import { Types } from "mongoose";
import User from "../models/Users";
import Driver from "../models/driver.model";
import Booking from "../models/booking.model";
import UserAddress from "../models/UserAddress";
import Wallet from "../models/wallet.model";
import Payout from "../models/payout.model";
import DriverKyc from "../models/driver-kyc.model";
import Vehicle from "../models/vehicle.model";
import DriverVehicle from "../models/driver-vehicle.model";
import { CoinWallet } from "../models/coin.model";
import { EmergencyContact } from "../models/sos.model";
import { getDriverAvailableBalance } from "./driver-payout.service";
import { deleteFilesFromAws } from "../utils/s3";

/**
 * Self-service account deletion, required by both app stores.
 *
 * 1. Request: the login closes at once (auth middleware refuses the account)
 *    and the wipe is scheduled DELETION_GRACE_DAYS ahead.
 * 2. Signing in again before then cancels it (OTP verify calls
 *    cancelPendingDeletion).
 * 3. After the grace period the account-deletion job anonymises the account:
 *    personal details, addresses, photos and documents are removed (stored
 *    files too). Bookings, invoices and payouts stay — tax and accounting
 *    records — pointing at the anonymised account.
 */

export const DELETION_GRACE_DAYS = 30;

type Kind = "user" | "driver";

/** A trip in these states (or a future scheduled one) blocks deletion. */
const LIVE_STATUSES = ["SEARCHING", "ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"];

export interface DeletionCheck {
  /** Reasons the account can't be deleted yet; empty = can delete. */
  blockers: string[];
  /** Money that would be lost (shown so the person confirms knowingly). */
  walletBalance: number;
  coinBalance: number;
  graceDays: number;
}

const ownerField = (kind: Kind) => (kind === "user" ? "userId" : "driverId");

export const checkDeletion = async (
  kind: Kind,
  id: Types.ObjectId | string,
): Promise<DeletionCheck> => {
  const _id = new Types.ObjectId(String(id));
  const blockers: string[] = [];

  const liveTrip = await Booking.exists({
    [ownerField(kind)]: _id,
    $or: [
      { status: { $in: LIVE_STATUSES } },
      { status: "DRAFT", isScheduled: true, scheduledAt: { $gt: new Date() } },
    ],
  });
  if (liveTrip) {
    blockers.push(
      kind === "user"
        ? "You have an active or upcoming booking. Finish or cancel it first."
        : "You have an active trip. Complete it first.",
    );
  }

  if (kind === "driver") {
    const pendingPayout = await Payout.exists({
      driverId: _id,
      status: { $in: ["PENDING", "APPROVED"] },
    });
    if (pendingPayout) {
      blockers.push("A payout is still being processed. Wait until it is paid.");
    }
    const balance = await getDriverAvailableBalance(String(_id)).catch(() => null);
    if (balance && balance.available > 0) {
      blockers.push(
        `You have ₹${balance.available.toFixed(2)} in earnings. Withdraw it first.`,
      );
    }
  }

  const [wallet, coins] = await Promise.all([
    Wallet.findOne({ userId: _id }).select("balance").lean(),
    CoinWallet.findOne({ userId: _id }).select("balance").lean(),
  ]);

  return {
    blockers,
    walletBalance: Number((wallet as any)?.balance || 0),
    coinBalance: Number((coins as any)?.balance || 0),
    graceDays: DELETION_GRACE_DAYS,
  };
};

/**
 * Schedules the deletion and closes the login. Returns the wipe date, or the
 * blockers when it can't proceed.
 */
export const requestDeletion = async (
  kind: Kind,
  id: Types.ObjectId | string,
): Promise<{ scheduledFor?: Date; blockers: string[] }> => {
  const check = await checkDeletion(kind, id);
  if (check.blockers.length) return { blockers: check.blockers };

  const now = new Date();
  const scheduledFor = new Date(now.getTime() + DELETION_GRACE_DAYS * 86400000);
  const update = {
    deletionRequestedAt: now,
    deletionScheduledFor: scheduledFor,
    // No pushes to a closed account; the next sign-in registers again.
    fcmToken: null,
  };
  if (kind === "user") {
    await User.findByIdAndUpdate(id, { ...update, token: null });
  } else {
    await Driver.findByIdAndUpdate(id, { ...update, isOnline: false });
  }
  return { scheduledFor, blockers: [] };
};

/** Called on a successful sign-in: undoes a pending deletion. */
export const cancelPendingDeletion = async (
  kind: Kind,
  doc: { _id: any; deletionRequestedAt?: Date | null } | null | undefined,
): Promise<boolean> => {
  if (!doc?.deletionRequestedAt) return false;
  const unset = { deletionRequestedAt: null, deletionScheduledFor: null };
  if (kind === "user") await User.findByIdAndUpdate(doc._id, unset);
  else await Driver.findByIdAndUpdate(doc._id, unset);
  return true;
};

/** The placeholder phone keeps the unique index happy and frees the number. */
const placeholderPhone = (id: Types.ObjectId) => `deleted-${String(id)}`;

const anonymiseUser = async (user: any): Promise<void> => {
  const _id = user._id as Types.ObjectId;
  const addresses = await UserAddress.find({ userId: _id }).lean();
  await deleteFilesFromAws([user.profileImage]);
  await Promise.all([
    UserAddress.deleteMany({ userId: _id }),
    EmergencyContact.deleteMany({ userId: _id }),
  ]);
  await User.findByIdAndUpdate(_id, {
    $set: {
      fullName: "Deleted user",
      mobileNumber: placeholderPhone(_id),
      isDeleted: true,
      isActive: false,
      deletedAt: new Date(),
      deletionScheduledFor: null,
      fcmToken: null,
      token: null,
      whatsappOptIn: false,
      notificationAllowed: false,
    },
    $unset: { email: 1, profileImage: 1, gender: 1, dob: 1 },
  });
  console.log(
    `[account-deletion] user ${_id} anonymised (${addresses.length} addresses removed)`,
  );
};

const anonymiseDriver = async (driver: any): Promise<void> => {
  const _id = driver._id as Types.ObjectId;
  const kyc: any = await DriverKyc.findOne({ driverId: _id }).lean();
  const vehicles: any[] = await Vehicle.find({ driverId: _id }).lean();

  // Every stored photo or document image tied to this partner.
  const files: (string | undefined)[] = [
    driver.profilePhoto,
    ...(driver.lastChecklistImages || []),
  ];
  if (kyc) {
    for (const doc of [kyc.aadhaar, kyc.pan, kyc.drivingLicense, kyc.vehicleRc]) {
      files.push(doc?.frontImage, doc?.backImage);
    }
    files.push(kyc.selfie, ...(kyc.vehicleImages || []));
  }
  for (const v of vehicles) {
    files.push(
      v.rcFrontImage,
      v.rcBackImage,
      v.assignedDriverLicenseFrontImage,
      v.assignedDriverLicenseBackImage,
      ...(v.vehicleImages || []),
    );
  }
  await deleteFilesFromAws(files);

  await Promise.all([
    DriverKyc.deleteMany({ driverId: _id }),
    EmergencyContact.deleteMany({ userId: _id }),
    // Vehicles stay as trip history, without their document images, and out
    // of dispatch.
    Vehicle.updateMany(
      { driverId: _id },
      {
        $set: { isActive: false, isDeleted: true },
        $unset: {
          rcFrontImage: 1,
          rcBackImage: 1,
          vehicleImages: 1,
          assignedDriverLicenseFrontImage: 1,
          assignedDriverLicenseBackImage: 1,
        },
      },
    ),
    DriverVehicle.updateMany({ driverId: _id }, { $set: { isActive: false, isDeleted: true } }),
  ]);

  await Driver.findByIdAndUpdate(_id, {
    $set: {
      fullName: "Deleted partner",
      mobileNumber: placeholderPhone(_id),
      isDeleted: true,
      isActive: false,
      isOnline: false,
      deletedAt: new Date(),
      deletionScheduledFor: null,
      fcmToken: null,
      addresses: [],
    },
    $unset: {
      email: 1,
      dob: 1,
      gender: 1,
      bloodGroup: 1,
      profilePhoto: 1,
      bankDetails: 1,
      bankDetailsUpdateRequest: 1,
      lastChecklistImages: 1,
      deviceInfo: 1,
      location: 1,
    },
  });
  console.log(
    `[account-deletion] partner ${_id} anonymised (${vehicles.length} vehicles detached)`,
  );
};

/**
 * Daily: anonymise every account whose grace period has run out. One failing
 * account doesn't stop the rest; it's retried on the next run.
 */
export const runAccountDeletionJob = async (): Promise<{ users: number; drivers: number }> => {
  const due = { deletionScheduledFor: { $ne: null, $lte: new Date() }, isDeleted: { $ne: true } };
  let users = 0;
  let drivers = 0;
  for (const u of await User.find(due).limit(200)) {
    try {
      await anonymiseUser(u);
      users++;
    } catch (e) {
      console.error(`[account-deletion] user ${u._id} failed`, e);
    }
  }
  for (const d of await Driver.find(due).limit(200)) {
    try {
      await anonymiseDriver(d);
      drivers++;
    } catch (e) {
      console.error(`[account-deletion] partner ${d._id} failed`, e);
    }
  }
  return { users, drivers };
};
