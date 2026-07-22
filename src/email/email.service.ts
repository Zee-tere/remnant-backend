import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly ses: SESClient;
  private readonly fromEmail: string;
  private readonly appName: string;
  private readonly isProduction: boolean;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>('AWS_SES_REGION') || this.configService.get<string>('AWS_REGION') || 'us-east-1';
    this.ses = new SESClient({ region });
    this.fromEmail = this.configService.get<string>('EMAIL_FROM', '');
    this.appName = this.configService.get<string>('APP_NAME', 'Remnant');
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
  }

  async sendPasswordReset(to: string, resetUrl: string) {
    const subject = `Reset your ${this.appName} password`;
    const text = [
      `Use this link to reset your ${this.appName} password:`,
      resetUrl,
      '',
      'This link expires in 15 minutes. If you did not request this, you can ignore this email.',
    ].join('\n');
    const html = `
      <p>Use this link to reset your ${this.appName} password:</p>
      <p><a href="${resetUrl}">Reset password</a></p>
      <p>This link expires in 15 minutes. If you did not request this, you can ignore this email.</p>
    `;

    await this.sendEmail(to, subject, text, html);
  }

  async sendPairMatch(to: string, title: string, body: string, matchUrl: string) {
    const safeTitle = this.escapeHtml(title);
    const safeBody = this.escapeHtml(body);
    const safeUrl = this.escapeHtml(matchUrl);
    const text = [title, '', body, '', `View the match: ${matchUrl}`].join('\n');
    const html = `
      <h2>${safeTitle}</h2>
      <p>${safeBody}</p>
      <p><a href="${safeUrl}">View this match on ${this.escapeHtml(this.appName)}</a></p>
    `;

    await this.sendEmail(to, `${this.appName}: ${title}`, text, html);
  }

  private async sendEmail(to: string, subject: string, text: string, html: string) {
    if (!this.fromEmail) {
      if (this.isProduction) {
        throw new ServiceUnavailableException('Transactional email is not configured');
      }

      this.logger.warn(`EMAIL_FROM is not configured. Dev email for ${to}: ${text}`);
      return;
    }

    try {
      await this.ses.send(
        new SendEmailCommand({
          Source: this.fromEmail,
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: { Data: subject },
            Body: {
              Text: { Data: text },
              Html: { Data: html },
            },
          },
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown email provider error';
      this.logger.error(`Failed to send email to ${to}: ${message}`);
      throw new ServiceUnavailableException('Could not send email');
    }
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
