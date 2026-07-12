import { env } from "../env.js";

export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

class ConsoleSmsProvider implements SmsProvider {
  async send(phone: string, message: string): Promise<void> {
    // Development only: surfaces the OTP in the server log.
    console.log(`[sms → ${phone}] ${message}`);
  }
}

// Production adapter. Uses Twilio's REST API directly (no SDK dependency);
// swap in any local aggregator with the same interface.
class TwilioSmsProvider implements SmsProvider {
  constructor(
    private sid: string,
    private token: string,
    private from: string,
  ) {}

  async send(phone: string, message: string): Promise<void> {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${this.sid}:${this.token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: phone, From: this.from, Body: message }),
        // Cap the wait so a stuck Twilio call can't hold the OTP request open.
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Twilio send failed: ${res.status} ${await res.text()}`);
    }
  }
}

export function createSmsProvider(): SmsProvider {
  if (env.smsProvider === "twilio") {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
      throw new Error("SMS_PROVIDER=twilio requires TWILIO_* env vars");
    }
    return new TwilioSmsProvider(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER);
  }
  return new ConsoleSmsProvider();
}

export const sms = createSmsProvider();
