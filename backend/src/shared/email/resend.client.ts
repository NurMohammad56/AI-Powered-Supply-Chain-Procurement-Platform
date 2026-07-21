import nodemailer, { type Transporter } from 'nodemailer';

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
 * SMTP-backed email wrapper. Controllers enqueue email jobs; the worker
 * is the only place that actually talks to the mail server.
 */
class EmailClient {
  private client: Transporter | null = null;

  private get smtpConfigured(): boolean {
    return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  }

  private get sdk(): Transporter {
    if (!this.client) {
      if (!this.smtpConfigured) {
        logger.warn({ event: 'email.no_smtp' }, 'SMTP not configured; using stub client');
      }
      this.client = nodemailer.createTransport({
        host: env.SMTP_HOST || 'localhost',
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: this.smtpConfigured
          ? {
              user: env.SMTP_USER,
              pass: env.SMTP_PASS,
            }
          : undefined,
      });
    }
    return this.client;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.smtpConfigured) {
      logger.info(
        { event: 'email.stub_send', to: input.to, subject: input.subject },
        'Email stub: would have sent',
      );
      return { id: 'stub', delivered: true };
    }
    try {
      const result = await this.sdk.sendMail({
        from: env.EMAIL_FROM,
        to: Array.isArray(input.to) ? input.to.join(', ') : input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        replyTo: input.replyTo ?? env.EMAIL_REPLY_TO,
        headers: input.tags,
      });
      return { id: result.messageId ?? null, delivered: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'unknown email send failure';
      return { id: null, delivered: false, error: message };
    }
  }
}

export const emailClient = new EmailClient();
