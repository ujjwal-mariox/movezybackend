import twilio from "twilio";
import config from "../config";

/**
 * SMS delivery: MSG91 (Movezy's provider for India) or Twilio.
 *
 * The single integration point for SMS across the app — login OTPs, SOS,
 * receiver notices — all route through `sendTemplateSms`.
 *
 * Every message is a fixed template. Indian DLT rules only deliver business
 * SMS whose wording was registered in advance, with nothing but the variables
 * filled in, so free-text SMS is deliberately not offered. Adding a message
 * means: a new entry below, a DLT template, an MSG91 template and its id in
 * MSG91_TEMPLATE_<KEY> (docs/sms-templates.md lists them all).
 *
 * Every function reports honestly: `false` means nothing was delivered. Callers
 * must not treat a false as success, since SMS reaches people who are not app
 * users and have no other channel.
 */

/**
 * The exact wording of each message. `##name##` marks a variable: in MSG91 it
 * is a variable of that exact name, on the DLT portal it is `{#var#}`, and for
 * Twilio it is filled in here. Change wording only together with DLT + MSG91.
 */
export const SMS_TEMPLATES = {
  CUSTOMER_OTP:
    "##otp## is your Movezy verification code. It is valid for a few minutes. Do not share it with anyone.",
  DRIVER_OTP:
    "##otp## is your Movezy driver verification code. Valid for a few minutes. Do not share it.",
  PARCEL_PICKED_UP:
    "Hi ##name##, your Movezy parcel ##ref## has been picked up and is on its way. Track it in the Movezy app. - Movezy",
  SOS_ALERT:
    "EMERGENCY: ##name## has triggered an SOS alert on Movezy. Location: https://maps.google.com/?q=##location## - Movezy",
  LOCATION_SHARE:
    "##name## is sharing their live location with you on Movezy: https://movezy.co/track/##code## - Movezy",
} as const;

export type SmsTemplateKey = keyof typeof SMS_TEMPLATES;

/** DLT caps every variable at 30 characters; longer values fail delivery. */
const DLT_VAR_MAX = 30;

const cleanVars = (vars: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [
      k,
      String(v ?? "").replace(/\s+/g, " ").trim().slice(0, DLT_VAR_MAX).trim(),
    ]),
  );

/** The message as the recipient reads it (Twilio sends this text). */
export const renderSmsText = (
  key: SmsTemplateKey,
  vars: Record<string, string>,
): string =>
  SMS_TEMPLATES[key].replace(/##(\w+)##/g, (_, name) => vars[name] ?? "");

let twilioClient: twilio.Twilio | null = null;
let warnedUnconfigured = false;

const twilioConfigured = (): boolean =>
  Boolean(
    config.sms.twilioAccountSid &&
      config.sms.twilioAuthToken &&
      config.sms.twilioPhoneNumber,
  );

type Provider = "msg91" | "twilio" | "none";

/** SMS_PROVIDER picks one; unset means whichever is configured, MSG91 first. */
const activeProvider = (): Provider => {
  const chosen = (config.sms.provider || "").trim().toLowerCase();
  if (chosen === "msg91") return config.sms.msg91AuthKey ? "msg91" : "none";
  if (chosen === "twilio") return twilioConfigured() ? "twilio" : "none";
  if (config.sms.msg91AuthKey) return "msg91";
  if (twilioConfigured()) return "twilio";
  return "none";
};

/**
 * Normalise to E.164 (+919998887771).
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

/** MSG91 Send SMS (v5 flow): DLT template id + named variables. */
const sendViaMsg91 = async (
  to: string,
  key: SmsTemplateKey,
  vars: Record<string, string>,
): Promise<boolean> => {
  const templateId = config.sms.msg91Templates[key];
  if (!templateId) {
    console.warn(
      `[sms] MSG91 template id for ${key} is not set (MSG91_TEMPLATE_${key}); not sent`,
    );
    return false;
  }
  // Each value goes under its name (##otp## → "otp") and its position
  // ("VAR1", "VAR2", the naming in MSG91's own examples), so the MSG91
  // template works whichever way its variables were named.
  const names = [...SMS_TEMPLATES[key].matchAll(/##(\w+)##/g)].map((m) => m[1]);
  const positional = Object.fromEntries(
    names.map((name, i) => [`VAR${i + 1}`, vars[name] ?? ""]),
  );
  try {
    const res = await fetch(`${config.sms.msg91BaseUrl}/api/v5/flow`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authkey: config.sms.msg91AuthKey,
      },
      body: JSON.stringify({
        template_id: templateId,
        short_url: "0",
        // MSG91 wants the number with country code and no "+".
        recipients: [{ mobiles: to.replace(/^\+/, ""), ...positional, ...vars }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && body?.type === "success") {
      console.log(`[sms] MSG91 accepted ${key} to ${to} (request ${body.message})`);
      return true;
    }
    console.error(
      `[sms] MSG91 rejected ${key} to ${to}: HTTP ${res.status} ${
        body?.message || ""
      }`,
    );
    return false;
  } catch (err: any) {
    console.error(`[sms] MSG91 send ${key} to ${to} failed: ${err?.message || err}`);
    return false;
  }
};

const sendViaTwilio = async (to: string, text: string): Promise<boolean> => {
  if (!twilioClient) {
    twilioClient = twilio(config.sms.twilioAccountSid, config.sms.twilioAuthToken);
  }
  try {
    const res = await twilioClient.messages.create({
      to,
      from: config.sms.twilioPhoneNumber,
      body: text,
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

/**
 * Send one templated SMS. Returns true only if the provider accepted it.
 *
 * Never throws: SMS is always a side-channel to some primary action (completing
 * a pickup, raising an SOS), and a provider outage must not fail that action.
 */
export const sendTemplateSms = async (
  toPhone: string,
  key: SmsTemplateKey,
  vars: Record<string, string>,
): Promise<boolean> => {
  const to = toE164(toPhone);
  if (!to) {
    console.warn(`[sms] invalid recipient number: ${JSON.stringify(toPhone)}`);
    return false;
  }
  const values = cleanVars(vars);

  const provider = activeProvider();
  if (provider === "msg91") return sendViaMsg91(to, key, values);
  if (provider === "twilio") return sendViaTwilio(to, renderSmsText(key, values));

  // Log once, not per message, so an unconfigured dev box isn't spammed.
  if (!warnedUnconfigured) {
    console.warn(
      "[sms] No SMS provider configured (MSG91_AUTH_KEY, or the TWILIO_* " +
        "trio). SMS will be skipped and reported as not sent.",
    );
    warnedUnconfigured = true;
  }
  // The text can hold an OTP; only print it outside production.
  console.log(
    `[sms skipped] ${key} to ${to}${
      config.env === "production" ? "" : `: ${renderSmsText(key, values)}`
    }`,
  );
  return false;
};

export default { sendTemplateSms, renderSmsText, toE164, SMS_TEMPLATES };
