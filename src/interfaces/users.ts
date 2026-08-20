import { Document } from "mongoose";

export type Gender = "Male" | "Female" | "Other";

export interface IUser extends Document {
  /** Short display ID ("CUS-0042") for admin search and support calls. */
  userCode?: string;
  fullName: string;
  email: string;
  profileImage: string;
  gender: Gender;
  dob: string;
  countryCode: string;
  mobileNumber: string;
  /** Consent to booking updates over WhatsApp, captured on the login screen. */
  whatsappOptIn?: boolean;
  isActive: boolean;
  isDeleted: boolean;
  isBlocked?: boolean;
  blockedAt?: Date | null;
  blockReason?: string | null;
  /** Master push opt-in. This is the real schema path — NOT isNotificationEnabled. */
  notificationAllowed: boolean;
  /** Firebase device token used to deliver push to this customer. */
  fcmToken?: string | null;
  /** Per-category push preferences; keys match the lowercased notification type. */
  notificationSettings?: {
    booking?: boolean;
    payment?: boolean;
    promo?: boolean;
    system?: boolean;
    chat?: boolean;
  };
  token?: string | null;
  referralCode?: string | null;
  referredBy?: any;
  referralApplied?: boolean;
}
