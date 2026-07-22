import { Document } from "mongoose";

export type Gender = "Male" | "Female" | "Other";

export interface IUser extends Document {
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
  notificationAllowed: boolean;
  token?: string | null;
  deviceToken?: string | null;
  deviceType?: string | null;
  referralCode?: string | null;
  referredBy?: any;
  referralApplied?: boolean;
}
