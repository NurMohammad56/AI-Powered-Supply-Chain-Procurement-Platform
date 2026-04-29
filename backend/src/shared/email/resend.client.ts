import { Resend } from 'resend';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: Record<string, string>;
}

export interface SendEmailResult {
  id: string | null;
  delivered: boolean;
  error?: string;
}

/**
 * Minimal Resend wrapper. The email worker is the only caller in
 * production; controllers should never call this directly - they enqueue
 * to the email queue and let the worker dispatch.
 */
class EmailClient {
  private client: Resend | null = null;

  private get sdk(): Resend {
    if (!this.client) {
      if (!env.RESEND_API_KEY) {
        logger.warn({ event: 'email.no_api_key' }, 'RESEND_API_KEY not configured; using stub client');
      }
      this.client = new Resend(env.RESEND_API_KEY || 're_stub');
    }
    return this.client;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!env.RESEND_API_KEY) {
      logger.info(
        { event: 'email.stub_send', to: input.to, subject: input.subject },
        'Email stub: would have sent',
      );
      return { id: 'stub', delivered: true };
    }
    try {
      const result = await this.sdk.emails.send({
        from: env.EMAIL_FROM,
        to: Array.isArray(input.to) ? input.to : [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        replyTo: input.replyTo ?? env.EMAIL_REPLY_TO,
        tags: input.tags
          ? Object.entries(input.tags).map(([name, value]) => ({ name, value }))
          : undefined,
      });
      if (result.error) {
        return { id: null, delivered: false, error: result.error.message };
      }
      return { id: result.data?.id ?? null, delivered: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'unknown email send failure';
      return { id: null, delivered: false, error: message };
    }
  }
}

export const emailClient = new EmailClient();
