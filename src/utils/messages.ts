export type Lang = "en" | string;

export type MessageKey =
  | "user_already_found"
  | "success"
  | "logout"
  | "invalid_token"
  | "users_list"
  | "user_not_found"
  | "forbidden"
  | "otp_sent"
  | "otp_verified"
  | "incorrect_otp"
  | "status_changed"
  | "interest_exists"
  | "owner_name_required"
  | "aadhaar_images_required"
  | "pan_front_image_required"
  | "selfie_required"
  | "owner_details_uploaded"
  | "aadhaar_uploaded"
  | "pan_uploaded"
  | "selfie_uploaded"
  | "driving_license_uploaded"
  | "rc_uploaded"
  | "rc_image_required"
  | "license_images_required"
  | "personal_info_updated"
  | "kyc_documents_uploaded"
  | "vehicle_added"
  | "registration_number_exists"
  | "personal_info_incomplete"
  | "kyc_incomplete"
  | "vehicle_not_added"
  | "submitted_for_verification"
  | "driver_not_found"
  | "dashboard_fetched"
  | "driver_online"
  | "driver_offline"
  | "driver_not_approved"
  | "driver_suspended"
  | "photo_required"
  | "photo_updated"
  | "profile_fetched"
  | "profile_updated"
  | "unauthorized"
  | "invalid_amount"
  | "amount_below_minimum"
  | "bank_details_required"
  | "insufficient_balance"
  | "withdrawal_requested"
  | "logout_success";

type MessageMap = Record<MessageKey, string>;

export default function messages(lang: Lang = "en"): MessageMap {
  const data: Record<MessageKey, Record<string, string>> = {
    user_already_found: {
      en: "User already found with given username, Try again after new username!",
    },
    success: {
      en: "success",
    },
    logout: {
      en: "logout successfully",
    },
    invalid_token: {
      en: "invalid token",
    },
    users_list: {
      en: "users list",
    },
    user_not_found: {
      en: "user detail not found with given id",
    },
    forbidden: {
      en: "forbidden",
    },
    otp_sent: {
      en: "otp send to your register mobile number",
    },
    otp_verified: {
      en: "login successfully",
    },
    incorrect_otp: {
      en: "incorrect otp, try again!",
    },
    status_changed: {
      en: "status changed successfully",
    },
    interest_exists: {
      en: "you have added this interest before",
    },
    owner_name_required: {
      en: "Owner name is required",
    },
    aadhaar_images_required: {
      en: "Aadhaar card image is required",
    },
    pan_front_image_required: {
      en: "PAN card image is required",
    },
    selfie_required: {
      en: "Selfie image is required",
    },
    owner_details_uploaded: {
      en: "Owner details uploaded successfully",
    },
    aadhaar_uploaded: {
      en: "Aadhaar uploaded successfully",
    },
    pan_uploaded: {
      en: "PAN uploaded successfully",
    },
    selfie_uploaded: {
      en: "Selfie uploaded successfully",
    },
    driving_license_uploaded: {
      en: "Driving license uploaded successfully",
    },
    rc_uploaded: {
      en: "RC uploaded successfully",
    },
    rc_image_required: {
      en: "RC image is required",
    },
    license_images_required: {
      en: "Driving license front & back images are required",
    },
    personal_info_updated: {
      en: "Personal info updated successfully",
    },
    kyc_documents_uploaded: {
      en: "KYC documents uploaded successfully",
    },
    vehicle_added: {
      en: "Vehicle added successfully",
    },
    registration_number_exists: {
      en: "Registration number already exists",
    },
    personal_info_incomplete: {
      en: "Personal info is incomplete",
    },
    kyc_incomplete: {
      en: "KYC documents are incomplete",
    },
    vehicle_not_added: {
      en: "Vehicle not added",
    },
    submitted_for_verification: {
      en: "Submitted for verification",
    },
    driver_not_found: {
      en: "Driver not found",
    },
    dashboard_fetched: {
      en: "Dashboard fetched successfully",
    },
    driver_online: {
      en: "You are online now",
    },
    driver_offline: {
      en: "You are offline now",
    },
    driver_not_approved: {
      en: "Your account is not approved by admin yet",
    },
    driver_suspended: {
      en: "Your account is suspended. Please contact admin",
    },
    photo_required: {
      en: "Photo is required",
    },
    photo_updated: {
      en: "Photo updated successfully",
    },
    profile_fetched: {
      en: "Profile fetched successfully",
    },
    profile_updated: {
      en: "Profile updated successfully",
    },
    unauthorized: {
      en: "Unauthorized access",
    },
    invalid_amount: {
      en: "Please enter a valid amount",
    },
    amount_below_minimum: {
      en: "Amount is below the minimum withdrawal limit",
    },
    bank_details_required: {
      en: "Add your bank details before withdrawing",
    },
    insufficient_balance: {
      en: "Insufficient balance for this withdrawal",
    },
    withdrawal_requested: {
      en: "Withdrawal requested. It will be processed after approval.",
    },
    logout_success: {
      en: "Logout successful",
    },
  };

  // fallback to English
  const result = {} as MessageMap;

  (Object.keys(data) as MessageKey[]).forEach((key) => {
    result[key] = data[key][lang] || data[key]["en"];
  });

  return result;
}
