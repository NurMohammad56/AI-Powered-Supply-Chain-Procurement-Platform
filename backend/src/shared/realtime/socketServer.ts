import type { Server as HttpServer } from 'node:http';

import { Types } from 'mongoose';
import { Server as IoServer, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';

import { redisSockPub, redisSockSub } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { SocketEvents, factoryRoom, userRoom } from './events.js';
import type { Role } from '../auth/types.js';

interface SocketContext {
  factoryId: Types.ObjectId;
  userId: Types.ObjectId;
  role: Role;
}

declare module 'socket.io' {
  interface Socket {
    data: { context?: SocketContext };
  }
}

let io: IoServer | null = null;

/**
 * Builds the Socket.io server with Redis adapter for horizontal scaling
 * (SDD §7.5). Authenticates connections by JWT in the handshake auth
 * payload; auto-joins `factory:<id>` and `user:<id>` rooms only.
 *
 * Strict posture (SDD §7.6): WebSocket-only transport (no long-polling
 * fallback), 1 MiB max frame, only `ping` accepted from clients.
 */
export function createSocketServer(httpServer: HttpServer): IoServer {
  if (io) return io;

  io = new IoServer(httpServer, {
    path: '/realtime',
    cors: {
      origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
      credentials: true,
    },
    transports: ['websocket'],
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1024 * 1024,
  });

  io.adapter(createAdapter(redisSockPub, redisSockSub));

  io.use((socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown })?.token;
      if (typeof token !== 'string' || token.length === 0) {
        return next(new Error('AUTH_TOKEN_MISSING'));
      }
      const claims = verifyAccessToken(token);
      socket.data.context = {
        factoryId: new Types.ObjectId(claims.factoryId),
        userId: new Types.ObjectId(claims.sub),
        role: claims.role,
      };
      next();
    } catch (err) {
      logger.warn({ err, event: 'socket.auth_failed' }, 'socket auth rejected');
      next(new Error('AUTH_TOKEN_INVALID'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const ctx = socket.data.context;
    if (!ctx) {
      socket.disconnect(true);
      return;
    }
    socket.join(factoryRoom(ctx.factoryId.toString()));
    socket.join(userRoom(ctx.userId.toString()));

    socket.emit(SocketEvents.SystemConnected, {
      serverTime: new Date().toISOString(),
      sessionId: socket.id,
    });

    // Strict allowlist: only `ping` from clients. Anything else gets the
    // connection killed and an audit-grade log line.
    socket.onAny((eventName: string) => {
      if (eventName === 'ping') return;
      logger.warn(
        {
          event: 'socket.unexpected_client_emit',
          eventName,
          socketId: socket.id,
          factoryId: ctx.factoryId.toString(),
          userId: ctx.userId.toString(),
        },
        'unexpected client emit; disconnecting',
      );
      socket.disconnect(true);
    });

    socket.on('disconnect', (reason) => {
      logger.debug({ event: 'socket.disconnect', socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  logger.info({ event: 'socket.server_ready' }, 'Socket.io server ready');
  return io;
}

export function getIo(): IoServer {
  if (!io) throw new Error('Socket.io server not initialised');
  return io;
}

export async function closeSocketServer(): Promise<void> {
  if (!io) return;
  await new Promise<void>((resolve) => io!.close(() => resolve()));
  io = null;
}
