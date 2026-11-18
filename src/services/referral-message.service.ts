import { AppConfig } from "../models/app-config.model";

/**
 * Referral share messages (client request, 16 Nov 2026): one for customers,
 * one for driver partners, edited in Admin → Settings → Referral share
 * messages. The server fills in each person's code and links, so a wording or
 * store-link change never needs a new app release.
 *
 * Placeholders, written in the admin text:
 *   {play_store_link}  Google Play link of the sharer's app
 *   {app_store_link}   Apple App Store link (customer app only)
 *   {referral_link}    the Play link with ?ref=<code> added
 *   {referral_code}    the sharer's referral code
 * A line whose link isn't configured yet is left out, so friends never see a
 * blank or a "[link]" placeholder (the iPhone line until the iOS app is live).
 */

export type ReferralAudience = "customer" | "driver";

export const REFERRAL_CONFIG_KEYS = {
  customerMessage: "REFERRAL_MESSAGE_CUSTOMER",
  driverMessage: "REFERRAL_MESSAGE_DRIVER",
  /** Existing key: the customer app's Play link, also used before this change. */
  customerPlayUrl: "APP_DOWNLOAD_URL",
  customerAppStoreUrl: "CUSTOMER_APP_STORE_URL",
  driverPlayUrl: "DRIVER_APP_DOWNLOAD_URL",
} as const;

/** The client's wording. Keep in sync with REFERRAL_DEFAULTS in the admin Settings page. */
export const DEFAULT_REFERRAL_MESSAGES: Record<ReferralAudience, string> = {
  customer: [
    "🚚 Need a reliable partner for your transportation needs?",
    "",
    "Meet Movezy – Speed Meets Reliability!",
    "",
    "Book a Bike, Goods Vehicle or Mini Truck for your local deliveries and goods transportation.",
    "",
    "✅ Quick and convenient bookings",
    "✅ Affordable and transparent pricing",
    "✅ Verified driver partners",
    "✅ Reliable doorstep delivery",
    "",
    "🎁 Join Movezy using my referral link and unlock exciting rewards!",
    "",
    "👉 Download the Movezy App:",
    "📱 Android: {play_store_link}",
    "🍎 iPhone: {app_store_link}",
    "",
    "🔗 My Invite Link: {referral_link}",
    "",
    "🎟️ Referral Code: {referral_code}",
    "",
    "Your next delivery is just a few taps away!",
    "",
    "Movezy – Speed Meets Reliability.",
  ].join("\n"),
  driver: [
    "🚚 Want to earn more with your vehicle? Join Movezy!",
    "",
    "Become a Movezy Driver Partner and earn through delivery and transportation opportunities.",
    "",
    "Whether you own a:",
    "🏍️ Two-Wheeler",
    "🛵 Scooter",
    "🚚 Goods Vehicle / Mini Truck",
    "",
    "Movezy connects you with customers looking for reliable transportation services.",
    "",
    "✅ Flexible working opportunities",
    "✅ Multiple delivery categories",
    "✅ Easy-to-use driver app",
    "✅ Opportunity to grow your earnings",
    "",
    "🎁 Join Movezy using my referral link and unlock exciting rewards!",
    "",
    "📱 Download the Movezy Driver App:",
    "{play_store_link}",
    "",
    "🔗 My Invite Link: {referral_link}",
    "",
    "🎟️ Referral Code: {referral_code}",
    "",
    "Movezy – Your Vehicle, Your Opportunity, Your Earnings!",
  ].join("\n"),
};

const TOKEN = /\{([a-z_]+)\}/gi;

/**
 * Fill the placeholders. A line holding a known placeholder with no value is
 * dropped, and so is a heading ("Download the app:") left with nothing under
 * it. An unknown placeholder (a typo) is left as typed so the admin preview
 * shows it. Keep in step with renderReferralMessage in the admin.
 */
export const renderReferralMessage = (
  template: string,
  values: Record<string, string>,
): string => {
  const known = (t: string) => Object.prototype.hasOwnProperty.call(values, t.toLowerCase());
  const kept: (string | null)[] = template
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      [...line.matchAll(TOKEN)].every(([, t]) => !known(t) || values[t.toLowerCase()])
        ? line.replace(TOKEN, (m, t) => (known(t) ? values[t.toLowerCase()] : m))
        : null,
    );
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] !== null) continue;
    let h = i - 1;
    while (h >= 0 && kept[h] === null) h--;
    let n = i + 1;
    while (n < kept.length && kept[n] === null) n++;
    const headingLeftEmpty =
      h >= 0 && /:\s*$/.test(kept[h] as string) && (n >= kept.length || !(kept[n] as string).trim());
    if (headingLeftEmpty) kept[h] = null;
  }
  return kept
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/** "https://…?id=x" + code → "https://…?id=x&ref=CODE"; "" when there is no link. */
export const referralLinkFor = (playUrl: string, code: string): string =>
  playUrl && code
    ? `${playUrl}${playUrl.includes("?") ? "&" : "?"}ref=${encodeURIComponent(code)}`
    : "";

/** The link and the ready-to-share message for one person's referral code. */
export const buildReferralShare = async (
  audience: ReferralAudience,
  code: string,
): Promise<{ referralLink: string; shareMessage: string }> => {
  const k = REFERRAL_CONFIG_KEYS;
  const keys =
    audience === "customer"
      ? [k.customerMessage, k.customerPlayUrl, k.customerAppStoreUrl]
      : [k.driverMessage, k.driverPlayUrl];
  const rows: any[] = await AppConfig.find({ key: { $in: keys } }).lean();
  const get = (key: string) => {
    const v = rows.find((r) => r.key === key)?.value;
    return v == null ? "" : String(v).trim();
  };

  const playUrl = get(audience === "customer" ? k.customerPlayUrl : k.driverPlayUrl);
  const appStoreUrl = audience === "customer" ? get(k.customerAppStoreUrl) : "";
  const referralLink = referralLinkFor(playUrl, code);
  const template =
    get(audience === "customer" ? k.customerMessage : k.driverMessage) ||
    DEFAULT_REFERRAL_MESSAGES[audience];

  return {
    referralLink,
    shareMessage: code
      ? renderReferralMessage(template, {
          referral_code: code,
          referral_link: referralLink,
          play_store_link: playUrl,
          app_store_link: appStoreUrl,
        })
      : "",
  };
};
