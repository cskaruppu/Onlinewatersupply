import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/config';
import { maskPhone } from '../common/phone';

/** Sends one-time codes by SMS. Swap the implementation per environment. */
export abstract class SmsSender {
  abstract sendOtp(phoneE164: string, otp: string): Promise<void>;
}

/**
 * Development/test only: writes the code to the server log instead of sending an SMS.
 * Blocked in production unless ALLOW_CONSOLE_SMS=true (see config.ts).
 */
@Injectable()
export class ConsoleSmsSender extends SmsSender {
  private readonly logger = new Logger('DevSms');
  async sendOtp(phoneE164: string, otp: string) {
    this.logger.warn(`[DEV-SMS] OTP for ${maskPhone(phoneE164)} is ${otp}`);
  }
}

/**
 * MSG91 Flow API. Requires a DLT-approved SMS template in MSG91 whose variable name
 * matches MSG91_OTP_VAR (default "otp").
 */
@Injectable()
export class Msg91SmsSender extends SmsSender {
  private readonly logger = new Logger('Msg91');
  constructor(private readonly config: AppConfig) {
    super();
  }

  async sendOtp(phoneE164: string, otp: string) {
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: {
        authkey: this.config.msg91AuthKey!,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        template_id: this.config.msg91TemplateId,
        short_url: '0',
        recipients: [{ mobiles: phoneE164.replace('+', ''), [this.config.msg91OtpVar]: otp }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      this.logger.error(`MSG91 returned HTTP ${res.status} for ${maskPhone(phoneE164)}`);
      throw new Error('SMS provider rejected the request');
    }
  }
}

export const smsSenderProvider = {
  provide: SmsSender,
  inject: [AppConfig],
  useFactory: (config: AppConfig): SmsSender =>
    config.smsProvider === 'msg91' ? new Msg91SmsSender(config) : new ConsoleSmsSender(),
};
