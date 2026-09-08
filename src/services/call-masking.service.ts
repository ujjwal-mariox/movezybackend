import { Types } from "mongoose";
import config from "../config";
import { AppConfig } from "../models/app-config.model";
import CallLog from "../models/call-log.model";
import { toE164 } from "./sms.service";

/**
 * Number masking ("proxy calling").
 *
 * Neither party is shown the other's real number. A call is placed through
 * the telephony provider: the provider first rings the person who tapped
 * Call, then bridges them to the other party, and BOTH handsets display only
 * the platform's voice number. The apps never receive the real numbers when
 * masking is on — they get "XXXXXX1234" for display plus a Call button that
 * hits POST .../call.
 *
 * Provider: Twilio Programmable Voice, using the same account the SMS
 * integration already uses. Configuration (env):
 *   CALL_MASKING_PROVIDER = twilio | none   (default: twilio when the Twilio
 *                                           SID/token are present)
 *   TWILIO_VOICE_NUMBER   = the voice-capable number both parties see
 *                           (falls back to TWILIO_PHONE_NUMBER)
 * Admin-editable (AppConfig):
 *   CALL_MASKING_FALLBACK_DIRECT = "true" (default) | "false" — when the
 *       bridge is not configured or fails, hand the app the real number so
 *       the trip is never blocked; "false" makes calling unavailable instead.
 *   HIDE_CONTACT_NUMBERS = "true" | "false" — force masking of numbers in app
 *       payloads even without a provider (Call then falls back to DIRECT).
 */

export type CallMode = "BRIDGE" | "DIRECT" | "UNAVAILABLE";

export interface CallParty {
  role: "USER" | "DRIVER";
  id: Types.ObjectId | string;
  phone: string | null | undefined;
}

export interface CallBridgeResult {
  mode: CallMode;
  message: string;
  /** Only present for DIRECT: the number the app should dial itself. */
  number?: string;
  callId?: string;
}

const providerName = (): string => {
  const explicit = (process.env.CALL_MASKING_PROVIDER || "").trim().toLowerCase();
  if (explicit) return explicit;
  return config.sms.twilioAccountSid && config.sms.twilioAuthToken ? "twilio" : "none";
};

const voiceNumber = (): string | undefined =>
  (process.env.TWILIO_VOICE_NUMBER || config.sms.twilioPhoneNumber || "").trim() || undefined;

/** True when a bridge can actually be placed. */
export const isMaskingConfigured = (): boolean =>
  providerName() === "twilio" &&
  Boolean(config.sms.twilioAccountSid && config.sms.twilioAuthToken && voiceNumber());

/** "9876543210" → "XXXXXX3210". Empty stays empty. */
export const maskPhone = (phone: string | null | undefined): string => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  return `XXXXXX${digits.slice(-4)}`;
};

// ── Cached flags (sync readers such as payload mappers use these) ──────────
let flagCache: { hide: boolean; fallbackDirect: boolean; at: number } = {
  hide: isMaskingConfigured(),
  fallbackDirect: true,
  at: 0,
};
const FLAG_TTL_MS = 60 * 1000;
let refreshing: Promise<void> | null = null;

const refreshFlags = async (): Promise<void> => {
  try {
    const rows = await AppConfig.find({
      key: { $in: ["HIDE_CONTACT_NUMBERS", "CALL_MASKING_FALLBACK_DIRECT"] },
    })
      .select("key value")
      .lean();
    const byKey: Record<string, any> = {};
    for (const r of rows as any[]) byKey[r.key] = r.value;
    const hideFlag = String(byKey.HIDE_CONTACT_NUMBERS ?? "").toLowerCase() === "true";
    const fallback = String(byKey.CALL_MASKING_FALLBACK_DIRECT ?? "true").toLowerCase() !== "false";
    flagCache = { hide: isMaskingConfigured() || hideFlag, fallbackDirect: fallback, at: Date.now() };
  } catch {
    flagCache = { ...flagCache, at: Date.now() };
  }
};

export const ensureFlags = async (): Promise<void> => {
  if (Date.now() - flagCache.at < FLAG_TTL_MS) return;
  if (!refreshing) refreshing = refreshFlags().finally(() => (refreshing = null));
  await refreshing;
};

/**
 * Sync: should app payloads hide real numbers right now? Kicks off a refresh
 * in the background when the cache is stale so mappers never block.
 */
export const numbersHidden = (): boolean => {
  if (Date.now() - flagCache.at >= FLAG_TTL_MS && !refreshing) {
    refreshing = refreshFlags().finally(() => (refreshing = null));
  }
  return flagCache.hide;
};

/** Phone as it may be shown to the OTHER party. */
export const presentPhone = (phone: string | null | undefined): string =>
  numbersHidden() ? maskPhone(phone) : String(phone || "");

// ── Rate limit: a party may start at most N bridges per booking per window ──
const MAX_CALLS_PER_WINDOW = 6;
const WINDOW_MS = 10 * 60 * 1000;

const overLimit = async (bookingId: Types.ObjectId, initiatorId: Types.ObjectId): Promise<boolean> => {
  const n = await CallLog.countDocuments({
    bookingId,
    initiatorId,
    createdAt: { $gte: new Date(Date.now() - WINDOW_MS) },
  });
  return n >= MAX_CALLS_PER_WINDOW;
};

const twilioBridge = async (
  initiatorPhone: string,
  targetPhone: string,
  bookingRef: string,
): Promise<{ sid: string }> => {
  const sid = config.sms.twilioAccountSid as string;
  const token = config.sms.twilioAuthToken as string;
  const from = voiceNumber() as string;
  const say = "Connecting your Movezy call. Please hold.";
  // The bridge: ring the initiator first; when they answer, dial the other
  // party with the platform number as caller id. timeLimit caps runaway calls.
  const twiml =
    `<Response><Say language="en-IN">${say}</Say>` +
    `<Dial callerId="${from}" timeLimit="1800" timeout="25">` +
    `<Number>${targetPhone}</Number></Dial></Response>`;
  const body = new URLSearchParams({
    To: initiatorPhone,
    From: from,
    Twiml: twiml,
    Timeout: "25",
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.sid) {
    throw new Error(json?.message || `Twilio call failed (${res.status}) for ${bookingRef}`);
  }
  return { sid: String(json.sid) };
};

/**
 * Place (or, when masking is off, authorise) a call from `initiator` to
 * `target` on a booking. Always logs the attempt.
 */
export const bridgeCall = async (params: {
  bookingId: Types.ObjectId | string;
  bookingNumber?: string;
  initiator: CallParty;
  target: CallParty;
}): Promise<CallBridgeResult> => {
  await ensureFlags();
  const bookingId = new Types.ObjectId(String(params.bookingId));
  const initiatorId = new Types.ObjectId(String(params.initiator.id));
  const targetId = new Types.ObjectId(String(params.target.id));
  const base = {
    bookingId,
    initiatorType: params.initiator.role,
    initiatorId,
    targetType: params.target.role,
    targetId,
  };

  const targetDigits = String(params.target.phone || "").trim();
  if (!targetDigits) {
    await CallLog.create({ ...base, mode: "UNAVAILABLE", error: "target has no number" });
    return { mode: "UNAVAILABLE", message: "No phone number is on file for the other party." };
  }

  if (await overLimit(bookingId, initiatorId)) {
    await CallLog.create({ ...base, mode: "UNAVAILABLE", error: "rate limited" });
    return {
      mode: "UNAVAILABLE",
      message: "Too many call attempts for this booking. Please use chat or contact support.",
    };
  }

  const directFallback = (): CallBridgeResult =>
    flagCache.fallbackDirect
      ? { mode: "DIRECT", number: targetDigits, message: "Connecting you directly." }
      : {
          mode: "UNAVAILABLE",
          message: "Calling is temporarily unavailable. Please use chat or contact support.",
        };

  if (!isMaskingConfigured()) {
    const r = directFallback();
    await CallLog.create({ ...base, mode: r.mode, error: "masking not configured" });
    return r;
  }

  const from = toE164(String(params.initiator.phone || ""));
  const to = toE164(targetDigits);
  if (!from || !to) {
    const r = directFallback();
    await CallLog.create({ ...base, mode: r.mode, error: "number not dialable" });
    return r;
  }

  try {
    const { sid } = await twilioBridge(from, to, params.bookingNumber || String(bookingId));
    await CallLog.create({ ...base, mode: "BRIDGE", provider: "twilio", providerCallId: sid });
    return {
      mode: "BRIDGE",
      callId: sid,
      message: "We're calling you now. Answer to be connected — the other party only sees the Movezy number.",
    };
  } catch (e: any) {
    console.error("call-masking: bridge failed", e?.message || e);
    const r = directFallback();
    await CallLog.create({ ...base, mode: r.mode, provider: "twilio", error: String(e?.message || e) });
    return r;
  }
};
