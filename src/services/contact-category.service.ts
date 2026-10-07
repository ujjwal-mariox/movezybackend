export const CONTACT_CATEGORIES = {
  NEW_BOOKING: "New Booking",
  EXISTING_BOOKING: "Existing Booking",
  BUSINESS_ENQUIRY: "Business Enquiry",
  DRIVER_PARTNERSHIP: "Driver Partnership",
  FLEET_PARTNERSHIP: "Fleet Partnership",
  PAYMENT_BILLING: "Payment/Billing",
  TECHNICAL_ISSUE: "Technical Issue",
  OTHER: "Other",
} as const;

export type ContactCategory = keyof typeof CONTACT_CATEGORIES;

/** Older website builds sent a subject only; keep those enquiries usable. */
export function contactCategory(value: unknown, subject = ""): ContactCategory | null {
  if (value === undefined || value === null || value === "") {
    if (/business|enterprise/i.test(subject)) return "BUSINESS_ENQUIRY";
    if (/fleet/i.test(subject)) return "FLEET_PARTNERSHIP";
    if (/driver|partner/i.test(subject)) return "DRIVER_PARTNERSHIP";
    if (/billing|invoice|payment/i.test(subject)) return "PAYMENT_BILLING";
    if (/booking help|existing booking/i.test(subject)) return "EXISTING_BOOKING";
    return "OTHER";
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return Object.prototype.hasOwnProperty.call(CONTACT_CATEGORIES, normalized)
    ? normalized as ContactCategory : null;
}
