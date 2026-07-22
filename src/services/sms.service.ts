import twilio from "twilio";
import config from "../config";

/**
 * SMS delivery (Twilio).
 *
 * The single integration point for SMS across the app — SOS, consignee notices,
 * and admin driver alerts all route through `sendSms`.
 *
 * Every function reports honestly: `false` means nothing was delivered. Callers
 * must not treat a false as success, since SMS reaches people who are not app
 * users and have no other channel.
 */

let client: twilio.Twilio | null = null;
let warnedUnconfigured = false;

const isConfigured = (): boolean =>
  Boolean(
    config.sms.twilioAccountSid &&
      config.sms.twilioAuthToken &&
      config.sms.twilioPhoneNumber,
  );

/** Lazily built so an unconfigured deployment doesn't throw at import time. */
const getClient = (): twilio.Twilio | null => {
  if (!isConfigured()) return null;
  if (!client) {
    client = twilio(config.sms.twilioAccountSid, config.sms.twilioAuthToken);
  }
  return client;
};

/**
 * Normalise to E.164, which Twilio requires.
 *
 * Numbers are stored bare (e.g. "9998887771") throughout this codebase, so a
 * default country code is applied when one isn't present. This platform is
 * India-only (GSTIN, INR, DLT), hence the +91 default — override with
 * SMS_DEFAULT_COUNTRY_CODE if that changes.
 */
export const toE164 = (phone: string): string | null => {
  const raw = String(phone || "").trim();
  if (!raw) return null;
  if (raw.startsWith("+")) return raw.replace(/[^\d+]/g, "");

  // Strip the national trunk prefix: Indian numbers are routinely written as
  // "09998887771", and keeping that 0 yields an invalid "+910..." that silently
  // never delivers.
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) return null;

  const cc = (config.sms.defaultCountryCode || "+91").replace(/[^\d+]/g, "");
  // Already carries the country code without the '+' (e.g. "919998887771").
  const ccDigits = cc.replace("+", "");
  if (digits.length > 10 && digits.startsWith(ccDigits)) return `+${digits}`;
  return `${cc}${digits}`;
};

/**
 * Send one SMS. Returns true only if Twilio accepted it.
 *
 * Never throws: SMS is always a side-channel to some primary action (completing
 * a pickup, raising an SOS), and a provider outage must not fail that action.
 */
export const sendSms = async (
  toPhone: string,
  message: string,
): Promise<boolean> => {
  const to = toE164(toPhone);
  if (!to) {
    console.warn(`[sms] invalid recipient number: ${JSON.stringify(toPhone)}`);
    return false;
  }

  const c = getClient();
  if (!c) {
    // Log once, not per message, so an unconfigured dev box isn't spammed.
    if (!warnedUnconfigured) {
      console.warn(
        "[sms] Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / " +
          "TWILIO_PHONE_NUMBER). SMS will be skipped and reported as not sent.",
      );
      warnedUnconfigured = true;
    }
    console.log(`[sms skipped] to ${to}: ${message}`);
    return false;
  }

  try {
    const res = await c.messages.create({
      to,
      from: config.sms.twilioPhoneNumber,
      body: message,
    });
    console.log(`[sms] sent to ${to} (sid ${res.sid}, status ${res.status})`);
    return true;
  } catch (err: any) {
    // code 21608 = unverified number on a Twilio trial account: a very common
    // dev-time failure that looks like a bug but is an account limitation.
    console.error(
      `[sms] send to ${to} failed${err?.code ? ` (code ${err.code})` : ""}: ${
        err?.message || err
      }`,
    );
    return false;
  }
};

/** Send the same message to several recipients. Returns how many were accepted. */
export const sendBulkSms = async (
  phones: string[],
  message: string,
): Promise<number> => {
  const results = await Promise.all(
    (phones || []).map((p) => sendSms(p, message)),
  );
  return results.filter(Boolean).length;
};

export default { sendSms, sendBulkSms, toE164 };
