export type Lang = "en" | string;

export type MessageKey =
  // Booking / trip lifecycle
  | "invalid_booking"
  | "booking_not_found"
  | "booking_fetched"
  | "invalid_otp"
  | "invalid_delivery_otp"
  | "complete_stops_first"
  | "complete_previous_stops_first"
  | "stop_already_completed"
  | "stop_completed"
  | "invalid_stop"
  | "arrived_at_pickup"
  | "trip_started"
  | "trip_completed"
  | "cash_collected"
  | "not_a_cash_booking"
  | "booking_accepted"
  | "booking_rejected"
  | "booking_cancelled"
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
  | "training_incomplete"
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
    training_incomplete: {
      en: "Complete your required training before going online",
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

    // ── Booking / trip lifecycle ──
    // These keys were used by the driver + booking controllers but never defined
    // here, so the response carried no message at all and every failure in the
    // trip flow surfaced as a generic client-side fallback.
    invalid_booking: {
      en: "This booking is no longer available. It may have been cancelled or taken by another driver.",
    },
    booking_not_found: {
      en: "Booking not found",
    },
    booking_fetched: {
      en: "Booking details loaded",
    },
    invalid_otp: {
      en: "Incorrect pickup OTP. Please ask the customer to read it out again.",
    },
    // These were introduced with the delivery-OTP gate and the multi-stop flow
    // but never given text, and ResponseMiddleware falls back to the raw key —
    // so drivers were shown "complete_stops_first" as their error message.
    invalid_delivery_otp: {
      en: "That delivery OTP is incorrect. Ask the receiver to read it out again.",
    },
    complete_stops_first: {
      en: "Mark every stop delivered before completing the trip.",
    },
    complete_previous_stops_first: {
      en: "Deliver the earlier stops first.",
    },
    stop_already_completed: {
      en: "That stop is already marked delivered.",
    },
    stop_completed: {
      en: "Stop delivered.",
    },
    invalid_stop: {
      en: "That stop is not part of this booking.",
    },
    // NOTE: `otp_verified` is already defined above for the login flow and is
    // reused by verifyPickupOtp — not redefined here.
    arrived_at_pickup: {
      en: "Marked as arrived at pickup",
    },
    trip_started: {
      en: "Trip started",
    },
    trip_completed: {
      en: "Trip completed",
    },
    cash_collected: {
      en: "Cash collected",
    },
    not_a_cash_booking: {
      en: "This booking was already paid online — do not collect cash.",
    },
    booking_accepted: {
      en: "Booking accepted",
    },
    booking_rejected: {
      en: "Booking declined",
    },
    booking_cancelled: {
      en: "Booking cancelled",
    },
  };

  // fallback to English
  const result = {} as MessageMap;

  (Object.keys(data) as MessageKey[]).forEach((key) => {
    result[key] = data[key][lang] || data[key]["en"];
  });

  return result;
}
