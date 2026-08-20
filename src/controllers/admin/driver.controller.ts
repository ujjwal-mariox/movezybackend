import { Request, Response } from "express";
import { Types } from "mongoose";
import Driver from "../../models/driver.model";
import DriverKYC from "../../models/driver-kyc.model";
import DriverVehicle from "../../models/driver-vehicle.model";
import Vehicle from "../../models/vehicle.model";
import Booking from "../../models/booking.model";
import VehicleType from "../../models/vehicle-type.model";
import { emitToUser } from "../../utils/socket.util";
import * as notificationService from "../../services/notification.service";
import { auditFromRequest } from "./audit-log.controller";

/**
 * Normalize a DriverKyc record into the flat `documents[]` array the admin
 * document-compliance page consumes. Each entry: { type, url, expiryDate,
 * verificationStatus, isVerified, uploadedAt, verifiedAt }.
 *
 * Each document reports its OWN verdict from kyc.documentStatus. It used to
 * derive every document's status from Driver.status alone, so one approval
 * flipped all of them to verified at once and a per-document decision could
 * never be shown. Records reviewed before per-document status existed have no
 * verdict stored, so those still fall back to the driver-level derivation.
 *
 * Only documents that were actually uploaded (have an image URL) are emitted;
 * types the driver hasn't uploaded are simply absent (page treats as missing).
 */
const buildDriverDocuments = (kyc: any, driverStatus?: string) => {
  if (!kyc) return [];
  const approved = driverStatus === "approved";
  const rejected = driverStatus === "rejected";
  const legacyStatus = approved ? "verified" : rejected ? "rejected" : "pending";
  const uploadedAt = kyc.updatedAt || kyc.createdAt;

  const docs: any[] = [];
  const push = (
    type: string,
    kycField: string,
    url?: string,
    expiryDate?: string,
  ) => {
    if (!url) return;
    const review = kyc.documentStatus?.[kycField];
    const reviewed = review?.status && review.status !== "PENDING";
    const verificationStatus = reviewed
      ? review.status === "VERIFIED"
        ? "verified"
        : "rejected"
      : review?.status === "PENDING"
        ? "pending"
        : legacyStatus;

    docs.push({
      type,
      url,
      expiryDate: expiryDate || undefined,
      verificationStatus,
      isVerified: verificationStatus === "verified",
      rejectionReason: review?.rejectionReason || undefined,
      uploadedAt,
      verifiedAt:
        review?.reviewedAt ||
        (verificationStatus === "verified" ? kyc.verifiedAt : undefined) ||
        undefined,
    });
  };

  push(
    "driving_license",
    "drivingLicense",
    kyc.drivingLicense?.frontImage,
    kyc.drivingLicense?.expiryDate,
  );
  push("rc_book", "vehicleRc", kyc.vehicleRc?.image);
  push("aadhar", "aadhaar", kyc.aadhaar?.frontImage);
  push("pan", "pan", kyc.pan?.frontImage);
  return docs;
};

/**
 * Get all drivers with filters
 */
export const getAllDrivers = async (req: Request, res: Response) => {
  const {
    status,
    isActive,
    isOnline,
    search,
    dateFrom,
    dateTo,
    deleted,
    page = 0,
    limit = 20,
  } = req.query;

  // deleted=true surfaces soft-deleted drivers so the Restore action is
  // reachable — the hard isDeleted:false filter made restoring impossible.
  const query: any = { isDeleted: deleted === "true" };

  if (status === "document_not_complete") {
    query.status = {
      $in: [
        "draft",
        "documents_uploaded",
        "vehicle_added",
        "under_verification",
        "rejected",
      ],
    };
  } else if (status === "pending_verification") {
    // Exactly what the dashboard's "Pending Driver Verifications" tile counts
    // (reports.controller: documents_uploaded + under_verification). The tile
    // used to link to document_not_complete, a SUPERSET that also includes
    // draft/vehicle_added/rejected — so the admin clicked a number and landed
    // on a longer list than the number promised.
    query.status = { $in: ["documents_uploaded", "under_verification"] };
  } else if (status === "blocked") {
    query.status = "suspended";
  } else if (status) {
    query.status = status;
  }
  if (isActive !== undefined) query.isActive = isActive === "true";
  if (isOnline !== undefined) query.isOnline = isOnline === "true";

  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom as string);
    if (dateTo) query.createdAt.$lte = new Date(dateTo as string);
  }

  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: "i" } },
      { mobileNumber: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      // The short display ID ("DRV-0042") — with or without the prefix, so
      // typing just "42" or "0042" also finds the driver.
      { driverCode: { $regex: search, $options: "i" } },
    ];
  }

  const drivers = await Driver.find(query)
    .select("-__v")
    .sort({ createdAt: -1 })
    .skip(Number(page) * Number(limit))
    .limit(Number(limit));

  const total = await Driver.countDocuments(query);

  // Pull KYC docs for these drivers in ONE query and index by driverId. The
  // admin document-compliance page reads a normalized `documents[]` array off
  // each driver, but KYC actually lives in the separate DriverKyc collection
  // (nested keys drivingLicense/aadhaar/pan/vehicleRc). Without this join the
  // page saw no documents and hard-coded every driver to 0% compliance.
  const driverIds = drivers.map((d) => d._id);
  const kycRecords = await DriverKYC.find({ driverId: { $in: driverIds } });

  // Completion rate inputs for every driver on this page, in ONE aggregation:
  // trips that reached the driver (any status once assigned) vs completed vs
  // cancelled BY the driver. Acceptance rate is deliberately absent — no offer
  // or decline record is persisted anywhere (dispatch keeps an ephemeral Redis
  // set), so an "acceptance %" here would be a made-up number.
  const outcomeAgg = await Booking.aggregate([
    { $match: { driverId: { $in: driverIds } } },
    {
      $group: {
        _id: "$driverId",
        assignedTotal: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
        },
        cancelledByDriver: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$status", "CANCELLED"] },
                  { $eq: ["$cancelledBy", "DRIVER"] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);
  const outcomeByDriver = new Map<string, any>();
  outcomeAgg.forEach((o) => outcomeByDriver.set(String(o._id), o));

  // Acceptance rate from persisted dispatch offers (accruing since the
  // DispatchOffer collection was introduced). Responded = accepted + skipped
  // + expired: letting an offer ring out counts against acceptance the same
  // way declining does.
  const DispatchOffer = (await import("../../models/dispatch-offer.model"))
    .default;
  const offerAgg = await DispatchOffer.aggregate([
    { $match: { driverId: { $in: driverIds }, response: { $ne: "PENDING" } } },
    {
      $group: {
        _id: "$driverId",
        offers: { $sum: 1 },
        accepted: {
          $sum: { $cond: [{ $eq: ["$response", "ACCEPTED"] }, 1, 0] },
        },
      },
    },
  ]);
  const offersByDriver = new Map<string, any>(
    offerAgg.map((o: any) => [String(o._id), o]),
  );
  const kycByDriver = new Map<string, any>();
  kycRecords.forEach((k) => kycByDriver.set(String(k.driverId), k));

  // Get additional stats
  const driversWithStats = await Promise.all(
    drivers.map(async (driver) => {
      const completedTrips = await Booking.countDocuments({
        driverId: driver._id,
        status: "COMPLETED",
      });
      // `totalEarnings` summed finalFare — the customer's whole payment, GST
      // and the platform's commission included — so every driver's "earnings"
      // read ~31% high. driverEarnings is the net figure frozen at completion
      // and is what payouts settle against (services/driver-payout.service.ts).
      // The gross is still reported, under a name that says what it is.
      const earnings = await Booking.aggregate([
        { $match: { driverId: driver._id, status: "COMPLETED" } },
        {
          $group: {
            _id: null,
            net: { $sum: { $ifNull: ["$driverEarnings", 0] } },
            gross: { $sum: { $ifNull: ["$finalFare", 0] } },
          },
        },
      ]);
      const outcomes = outcomeByDriver.get(String(driver._id));
      const offers = offersByDriver.get(String(driver._id));
      return {
        ...driver.toObject(),
        completedTrips,
        // null (not 0) when nothing was ever assigned: "no history" and
        // "completes 0%" are different facts and must render differently.
        completionRate:
          outcomes && outcomes.assignedTotal > 0
            ? Math.round((outcomes.completed / outcomes.assignedTotal) * 100)
            : null,
        cancelledByDriver: outcomes?.cancelledByDriver ?? 0,
        assignedTotal: outcomes?.assignedTotal ?? 0,
        // Null until this driver has any resolved offers on record.
        acceptanceRate:
          offers && offers.offers > 0
            ? Math.round((offers.accepted / offers.offers) * 100)
            : null,
        offersReceived: offers?.offers ?? 0,
        totalEarnings: earnings[0]?.net || 0,
        grossFareCollected: earnings[0]?.gross || 0,
        documents: buildDriverDocuments(
          kycByDriver.get(String(driver._id)),
          driver.status,
        ),
      };
    }),
  );

  res.locals.data = {
    drivers: driversWithStats,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / Number(limit)),
  };
};

/**
 * Get pending verifications
 */
export const getPendingVerifications = async (req: Request, res: Response) => {
  const drivers = await Driver.find({
    isDeleted: false,
    status: { $in: ["documents_uploaded", "under_verification"] },
  })
    .select("fullName mobileNumber email status createdAt")
    .sort({ createdAt: 1 }); // Oldest first

  res.locals.data = { drivers, total: drivers.length };
};

/**
 * Get driver by ID
 */
export const getDriverById = async (req: Request, res: Response) => {
  const { id } = req.params;

  const driver = await Driver.findById(id);

  if (!driver) {
    return res.status(404).json({
      success: false,
      message: "Driver not found",
    });
  }

  // Get KYC documents
  const kyc = await DriverKYC.findOne({ driverId: id });

  // Get vehicles
  const vehicles = await DriverVehicle.find({ driverId: id });

  // Get booking stats. `totalEarnings` is the driver's net (subtotal −
  // commission, frozen at completion) on the same basis as the drivers list and
  // Finance → Payouts; it used to sum finalFare, which includes customer GST
  // and the platform's commission. Gross is reported alongside it under a name
  // that says what it is, so the two can never be mistaken for each other.
  const bookingStats = await Booking.aggregate([
    { $match: { driverId: driver._id } },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
        totalEarnings: { $sum: { $ifNull: ["$driverEarnings", 0] } },
        grossFareCollected: { $sum: { $ifNull: ["$finalFare", 0] } },
      },
    },
  ]);

  res.locals.data = {
    driver,
    kyc,
    vehicles,
    bookingStats,
  };
};

/**
 * Verify driver (Approve/Reject)
 */
export const verifyDriver = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { action, rejectionReason } = req.body;

  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({
      success: false,
      message: "Invalid action. Use 'approve' or 'reject'",
    });
  }

  const driver = await Driver.findById(id);

  if (!driver) {
    return res.status(404).json({
      success: false,
      message: "Driver not found",
    });
  }

  if (action === "approve") {
    driver.status = "approved";
    driver.isActive = true;
    driver.rejectionReason = undefined;
    driver.suspensionReason = undefined;
  } else {
    driver.status = "rejected";
    driver.isActive = false;
    driver.isOnline = false;
    driver.rejectionReason = rejectionReason || "Documents verification failed";
  }

  await driver.save();

  // Approving a driver has to approve their vehicles too.
  //
  // This handler only ever moved `driver.status`. The admin list *derives* each
  // document's state from that (see statusFor() at the top of this file), so
  // the panel showed "approved" — but nothing ever wrote
  // Vehicle.verificationStatus, and the driver app's My Vehicles screen reads
  // that raw field. So every vehicle sat at "pending" forever and the driver
  // was told they were still under verification after being approved.
  // One source of truth: write the real state.
  try {
    await Vehicle.updateMany(
      { driverId: driver._id, isDeleted: { $ne: true } },
      action === "approve"
        ? {
            $set: { verificationStatus: "approved" },
            $unset: { rejectionReason: "" },
          }
        : {
            $set: {
              verificationStatus: "rejected",
              rejectionReason:
                rejectionReason || "Documents verification failed",
            },
          },
    );
  } catch (e) {
    console.error("failed to propagate verification to vehicles", e);
  }

  // Make approved vehicles actually dispatchable.
  //
  // Dispatch matches drivers on DriverVehicle rows. Only the signup flow ever
  // created one, so a vehicle added later through the app sat approved in the
  // `vehicles` collection and was never sent a single booking — the two
  // collections were never bridged. Approval is the right moment to bridge:
  // a pending vehicle must not receive jobs.
  try {
    const driverVehicles = await Vehicle.find({
      driverId: driver._id,
      isDeleted: { $ne: true },
    })
      .select("vehicleNumber vehicleTypeId vehicleType")
      .lean();

    for (const v of driverVehicles as any[]) {
      if (!v.vehicleNumber) continue;

      // Prefer the exact type the driver registered. Older rows predate
      // `vehicleTypeId` and only know a category ("2W"), so fall back to that
      // category's designated default rather than stranding the vehicle
      // un-dispatchable forever — which is what used to happen, silently.
      let typeId = v.vehicleTypeId;
      if (!typeId && v.vehicleType) {
        const fallback = await VehicleType.findOne({
          categoryCode: v.vehicleType,
          isDefaultForCategory: true,
          isActive: true,
        }).select("_id");
        typeId = fallback?._id;
      }
      if (!typeId) {
        console.warn(
          `[approve] vehicle ${v.vehicleNumber} has no catalog type and its category (${v.vehicleType}) has no default — it will not be dispatchable`,
        );
        continue;
      }

      await DriverVehicle.findOneAndUpdate(
        { registrationNumber: String(v.vehicleNumber).toUpperCase() },
        {
          $set: {
            driverId: driver._id,
            vehicleTypeId: typeId,
            // Rejecting must take the vehicle back out of dispatch.
            isActive: action === "approve",
            isDeleted: false,
          },
        },
        { upsert: true, new: true },
      );
    }
  } catch (e) {
    console.error("failed to sync dispatch vehicles", e);
  }

  // ...and to their KYC record, for the same reason.
  //
  // The driver profile's "DL Verified" badge reads DriverKyc.isVerified. Nothing
  // ever set it, so every one of the 37 KYC records sat at false and an approved
  // driver was still told their licence was under review.
  //
  // Write the PER-DOCUMENT verdicts, not just the roll-up. This used to $set
  // isVerified directly and never touch kyc.documentStatus — the field
  // buildDriverDocuments (top of this file) reads first — so after a driver-level
  // approval every document still showed "Pending Review" and the compliance
  // score never moved. It also stamped isVerified:true straight over a live
  // REJECTED document verdict, leaving the roll-up and the per-document records
  // contradicting each other. A driver-level decision is an explicit decision on
  // everything they submitted, so it now says so on each submitted slot, and
  // isVerified is DERIVED with the same rule verifyDriverDocument uses below:
  // true only when every SUBMITTED document is VERIFIED.
  try {
    const kyc: any = await DriverKYC.findOne({ driverId: driver._id });
    if (kyc) {
      const reviewedAt = new Date();
      const reviewedBy = (req as any).admin?._id;
      kyc.documentStatus = kyc.documentStatus || {};

      for (const slot of KYC_DOCUMENT_TYPES) {
        // A slot the driver never uploaded stays PENDING — approving a driver
        // must not certify a document that does not exist.
        if (!isDocumentSubmitted(kyc, slot)) continue;
        kyc.documentStatus[slot] =
          action === "approve"
            ? {
                status: "VERIFIED",
                reviewedAt,
                reviewedBy,
                rejectionReason: undefined,
              }
            : {
                status: "REJECTED",
                reviewedAt,
                reviewedBy,
                rejectionReason: driver.rejectionReason,
              };
      }

      const submitted = KYC_DOCUMENT_TYPES.filter((t) =>
        isDocumentSubmitted(kyc, t),
      );
      const allVerified =
        submitted.length > 0 &&
        submitted.every((t) => kyc.documentStatus?.[t]?.status === "VERIFIED");

      kyc.isVerified = allVerified;
      kyc.verifiedAt = allVerified ? reviewedAt : undefined;
      kyc.markModified("documentStatus");
      await kyc.save();
    }
  } catch (e) {
    console.error("failed to propagate verification to KYC", e);
  }

  // Propagate verification outcome to driver app
  try {
    const driverIdStr = String(driver._id);
    emitToUser(driverIdStr, "driver:verification", {
      status: driver.status,
      isActive: driver.isActive,
      rejectionReason: driver.rejectionReason,
      updatedAt: new Date().toISOString(),
    });

    const isApproved = action === "approve";
    await notificationService
      .sendToDriver(
        driver._id as Types.ObjectId,
        "SYSTEM",
        isApproved ? "Verification Approved" : "Verification Rejected",
        isApproved
          ? "Your documents have been verified. You can now accept bookings."
          : `Your verification was rejected: ${driver.rejectionReason || "See reason in app."}`,
        { status: driver.status, reason: driver.rejectionReason ?? "" },
      )
      .catch(() => null);
  } catch (err) {
    console.error("Driver verify: propagation error", err);
  }

  res.locals.data = {
    message: `Driver ${action === "approve" ? "approved" : "rejected"} successfully`,
    driver,
  };
};

/**
 * Send a notification to ONE driver.
 *
 * Exists because the admin panel previously used /notifications/broadcast with
 * `audience: "DRIVERS"` for per-driver messages: sendBroadcast ignores any id in
 * `data` and targets every active driver, so a single re-upload request was
 * delivered to the whole fleet. This targets exactly one driver.
 */
export const notifyDriver = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, body } = req.body as { title?: string; body?: string };

  if (!title || !body) {
    return res.status(400).json({
      success: false,
      message: "title and body are required",
    });
  }

  const driver = await Driver.findById(id).select("_id fullName");
  if (!driver) {
    return res.status(404).json({ success: false, message: "Driver not found" });
  }

  const sent = await notificationService
    .sendToDriver(driver._id as Types.ObjectId, "SYSTEM", title, body)
    .catch(() => false);

  res.locals.data = {
    message: `Notification sent to ${driver.fullName || "driver"}`,
    // Push may be skipped when FCM is unconfigured; the in-app inbox row is
    // still written by sendToDriver. Report it rather than implying delivery.
    pushDelivered: Boolean(sent),
  };
};

/**
 * Block / unblock a driver.
 *
 * Deliberately reversible and distinct from reject: reject sends an onboarding
 * driver back to re-upload documents, whereas this suspends an ALREADY-ACTIVE
 * driver (e.g. expired documents) without touching their verification history.
 * Forces them offline so the dispatcher stops considering them immediately.
 */
export const blockDriver = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { action, reason } = req.body as {
    action?: "block" | "unblock";
    reason?: string;
  };

  if (action !== "block" && action !== "unblock") {
    return res.status(400).json({
      success: false,
      message: "action must be 'block' or 'unblock'",
    });
  }

  const driver = await Driver.findById(id);
  if (!driver) {
    return res.status(404).json({ success: false, message: "Driver not found" });
  }

  if (action === "block") {
    driver.status = "suspended";
    driver.isActive = false;
    driver.isOnline = false; // stop dispatch reaching them right away
    driver.suspensionReason = reason || "Blocked by admin";
  } else {
    // Restore to the working state. A blocked driver was necessarily verified
    // before, so "approved" is the correct state to return them to.
    driver.status = "approved";
    driver.isActive = true;
    driver.suspensionReason = undefined;
  }

  await driver.save();

  // Tell the driver app, reusing the channel the verify flow already uses.
  try {
    emitToUser(String(driver._id), "driver:verification", {
      status: driver.status,
      isActive: driver.isActive,
      suspensionReason: driver.suspensionReason,
      updatedAt: new Date().toISOString(),
    });

    await notificationService
      .sendToDriver(
        driver._id as Types.ObjectId,
        "SYSTEM",
        action === "block" ? "Account Blocked" : "Account Restored",
        action === "block"
          ? `Your account has been blocked: ${driver.suspensionReason}`
          : "Your account has been restored. You can accept bookings again.",
        { status: driver.status, reason: driver.suspensionReason ?? "" },
      )
      .catch(() => null);
  } catch (err) {
    console.error("Driver block: propagation error", err);
  }

  res.locals.data = {
    message: `Driver ${action === "block" ? "blocked" : "unblocked"} successfully`,
    driver,
  };
};

/**
 * Update driver status
 */
export const updateDriverStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, reason, isActive } = req.body;

  const validStatuses = [
    "draft",
    "documents_uploaded",
    "vehicle_added",
    "under_verification",
    "approved",
    "rejected",
    "suspended",
  ];

  if (
    status !== undefined &&
    status !== null &&
    !validStatuses.includes(status)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid status",
    });
  }

  if (status === undefined && typeof isActive !== "boolean") {
    return res.status(400).json({
      success: false,
      message: "Status or active flag is required",
    });
  }

  const update: any = {};

  if (status !== undefined) {
    update.status = status;
  }

  if (typeof isActive === "boolean") {
    update.isActive = isActive;
  }

  if (
    (status !== undefined && status !== "approved") ||
    (typeof isActive === "boolean" && !isActive)
  ) {
    update.isOnline = false;
  }

  if (status === "suspended") {
    update.isActive = false;
    update.suspensionReason = reason;
    update.rejectionReason = undefined;
  } else if (status === "rejected") {
    update.isActive = false;
    update.rejectionReason = reason;
    update.suspensionReason = undefined;
  } else if (status === "approved") {
    update.rejectionReason = undefined;
    update.suspensionReason = undefined;
  }

  const driver = await Driver.findByIdAndUpdate(id, update, { new: true });

  if (!driver) {
    return res.status(404).json({
      success: false,
      message: "Driver not found",
    });
  }

  // Propagate status change to driver app
  try {
    const driverIdStr = String(driver._id);
    emitToUser(driverIdStr, "driver:status", {
      status: driver.status,
      isActive: driver.isActive,
      isOnline: driver.isOnline,
      reason: reason ?? null,
      updatedAt: new Date().toISOString(),
    });

    const title = status
      ? `Account status: ${status}`
      : isActive
      ? "Account activated"
      : "Account deactivated";
    const body = status === "suspended"
      ? `Your account has been suspended.${reason ? ` Reason: ${reason}` : ""}`
      : status === "rejected"
      ? `Your account has been rejected.${reason ? ` Reason: ${reason}` : ""}`
      : status === "approved"
      ? "Your account has been approved. You can now resume work."
      : isActive === false
      ? "Your account has been deactivated by the admin team."
      : "Your account status has been updated by the admin team.";

    await notificationService
      .sendToDriver(
        driver._id as Types.ObjectId,
        "SYSTEM",
        title,
        body,
        { status: String(driver.status ?? ""), reason: String(reason ?? "") },
      )
      .catch(() => null);
  } catch (err) {
    console.error("Driver status update: propagation error", err);
  }

  res.locals.data = {
    message:
      status !== undefined
        ? `Driver status updated to ${status}`
        : `Driver marked as ${isActive ? "active" : "inactive"}`,
    driver,
  };
};

/**
 * Get driver documents
 */
export const getDriverDocuments = async (req: Request, res: Response) => {
  const { id } = req.params;

  const kyc = await DriverKYC.findOne({ driverId: id });

  if (!kyc) {
    return res.status(404).json({
      success: false,
      message: "Documents not found",
    });
  }

  res.locals.data = { documents: kyc };
};

/** The document slots a driver actually submits, and where each one lives. */
const KYC_DOCUMENT_TYPES = [
  "aadhaar",
  "pan",
  "drivingLicense",
  "selfie",
  "vehicleRc",
] as const;

/** The admin UI's document ids -> the KYC record's field names. */
const DOCUMENT_TYPE_ALIASES: Record<string, string> = {
  driving_license: "drivingLicense",
  drivingLicense: "drivingLicense",
  rc_book: "vehicleRc",
  vehicleRc: "vehicleRc",
  aadhar: "aadhaar",
  aadhaar: "aadhaar",
  pan: "pan",
  selfie: "selfie",
};

/** True when the driver has actually uploaded something for this slot. */
const isDocumentSubmitted = (kyc: any, docType: string): boolean => {
  const v = kyc?.[docType];
  if (!v) return false;
  if (typeof v === "string") return v.trim().length > 0;
  // Object-shaped documents count as submitted once any image is present.
  return Boolean(v.frontImage || v.backImage || v.image);
};

/**
 * Approve or reject ONE document.
 *
 * Previously the admin's per-document "Approve" had nowhere granular to write:
 * the KYC record carried a single `isVerified` flag for the whole set and every
 * document's status in the UI was derived from `driver.status`. So approving a
 * licence silently marked the Aadhaar, PAN, selfie and RC verified too.
 *
 * This writes only the document named in the URL. `isVerified` becomes a
 * derived roll-up — true only once every SUBMITTED document is VERIFIED — and
 * approving documents never by itself activates the driver's account; that
 * stays the separate, explicit verifyDriver action.
 */
export const verifyDriverDocument = async (req: Request, res: Response) => {
  const { id, docType } = req.params;
  const { action, reason } = req.body || {};

  // The admin page identifies documents as driving_license / rc_book / aadhar,
  // while the KYC record stores them as drivingLicense / vehicleRc / aadhaar.
  // Accept either spelling rather than 400-ing on the admin's own vocabulary.
  const field = DOCUMENT_TYPE_ALIASES[docType] ?? docType;

  if (!KYC_DOCUMENT_TYPES.includes(field as any)) {
    return res.status(400).json({
      success: false,
      message: `Unknown document "${docType}". Expected one of: ${Object.keys(DOCUMENT_TYPE_ALIASES).join(", ")}.`,
    });
  }

  if (action !== "approve" && action !== "reject") {
    return res.status(400).json({
      success: false,
      message: 'action must be "approve" or "reject".',
    });
  }

  const kyc: any = await DriverKYC.findOne({ driverId: id });
  if (!kyc) {
    return res.status(404).json({
      success: false,
      message: "Documents not found",
    });
  }

  if (!isDocumentSubmitted(kyc, field)) {
    return res.status(400).json({
      success: false,
      message: `The driver has not uploaded a ${docType} yet.`,
    });
  }

  kyc.documentStatus = kyc.documentStatus || {};
  kyc.documentStatus[field] = {
    status: action === "approve" ? "VERIFIED" : "REJECTED",
    reviewedAt: new Date(),
    reviewedBy: (req as any).admin?._id,
    rejectionReason: action === "reject" ? reason || "" : undefined,
  };

  // Roll-up across the documents this driver actually submitted. A slot they
  // never uploaded must not block verification, and must not count as passed.
  const submitted = KYC_DOCUMENT_TYPES.filter((t) => isDocumentSubmitted(kyc, t));
  const allVerified =
    submitted.length > 0 &&
    submitted.every((t) => kyc.documentStatus?.[t]?.status === "VERIFIED");

  kyc.isVerified = allVerified;
  if (allVerified) kyc.verifiedAt = new Date();

  kyc.markModified("documentStatus");
  await kyc.save();

  res.locals.data = {
    docType,
    status: kyc.documentStatus[field].status,
    documentStatus: kyc.documentStatus,
    // Whether every submitted document has now passed. The driver's account is
    // still activated separately, so the UI can prompt for that next.
    allDocumentsVerified: allVerified,
  };
  res.locals.message =
    action === "approve"
      ? `${docType} approved.`
      : `${docType} rejected.`;
};

/**
 * Get driver stats summary
 */
export const getDriverStats = async (req: Request, res: Response) => {
  const stats = await Driver.aggregate([
    { $match: { isDeleted: false } },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
      },
    },
  ]);

  const onlineCount = await Driver.countDocuments({
    isDeleted: false,
    status: "approved",
    isOnline: true,
  });

  const activeDrivers = await Driver.countDocuments({
    isDeleted: false,
    isActive: true,
  });

  const inactiveDrivers = await Driver.countDocuments({
    isDeleted: false,
    isActive: false,
  });

  // Real unassigned-orders count: bookings still searching for a driver.
  const unassignedOrders = await Booking.countDocuments({ status: "SEARCHING" });

  // Fleet-wide counts the status strip needs. "Busy" is a driver actually
  // carrying a booking; "idle" is online with nothing assigned — both from
  // currentBookingId, which dispatch maintains. "Underperforming" is a rated
  // driver below 3.5. No rating-count field exists on Driver — rating is a
  // recomputed average defaulting to 0 — so "has been rated" is rating > 0,
  // which keeps unrated new drivers out of a red bucket they have done
  // nothing to earn (a real 1-star average is 1, never 0).
  const busyDrivers = await Driver.countDocuments({
    isDeleted: false,
    status: "approved",
    isOnline: true,
    currentBookingId: { $ne: null },
  });
  const underperformingDrivers = await Driver.countDocuments({
    isDeleted: false,
    status: "approved",
    rating: { $gt: 0, $lt: 3.5 },
  });

  res.locals.data = {
    byStatus: stats,
    onlineDrivers: onlineCount,
    activeDrivers,
    inactiveDrivers,
    unassignedOrders,
    busyDrivers,
    idleDrivers: Math.max(onlineCount - busyDrivers, 0),
    underperformingDrivers,
  };
};

/**
 * Update driver profile
 */
export const updateDriver = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { fullName, email, gender, dob, bloodGroup, city, state, languages } =
    req.body;

  const driver = await Driver.findByIdAndUpdate(
    id,
    { fullName, email, gender, dob, bloodGroup, city, state, languages },
    { new: true },
  );

  if (!driver) {
    return res.status(404).json({
      success: false,
      message: "Driver not found",
    });
  }

  res.locals.data = {
    message: "Driver updated successfully",
    driver,
  };
};

/**
 * Update bank details
 */
export const updateBankDetails = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { accountHolderName, bankName, accountNumber, ifscCode } = req.body;

  const driver = await Driver.findByIdAndUpdate(
    id,
    {
      bankDetails: {
        accountHolderName,
        bankName,
        accountNumber,
        ifscCode,
        isVerified: false,
      },
    },
    { new: true },
  );

  if (!driver) {
    return res.status(404).json({
      success: false,
      message: "Driver not found",
    });
  }

  res.locals.data = {
    message: "Bank details updated successfully",
    driver,
  };
};

/**
 * Verify bank details
 */
export const verifyBankDetails = async (req: Request, res: Response) => {
  const { id } = req.params;

  const driver = await Driver.findByIdAndUpdate(
    id,
    { "bankDetails.isVerified": true },
    { new: true },
  );

  if (!driver) {
    return res.status(404).json({
      success: false,
      message: "Driver not found",
    });
  }

  res.locals.data = {
    message: "Bank details verified successfully",
    driver,
  };
};

// Audit rows must not carry a full bank account number — they are readable by
// every admin with audit access, which is a wider audience than driver PII.
const maskAccount = (accountNumber?: string) => {
  const s = String(accountNumber || "");
  return s.length > 4 ? `••••${s.slice(-4)}` : s;
};

/**
 * Decide a driver's pending bank-details change request.
 * PUT /admin/drivers/:id/bank-request  body { action: "approve"|"reject", reason? }
 *
 * Exists because the driver PUT no longer writes bankDetails once an account
 * is on file — it parks the edit here for a human decision. Approve copies the
 * requested fields into bankDetails (unverified — the separate
 * /bank-details/verify step still owns that flag); reject only stamps the
 * request, with a mandatory reason the driver will be shown.
 */
export const decideBankUpdateRequest = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { action, reason } = req.body as {
    action?: "approve" | "reject";
    reason?: string;
  };

  if (action !== "approve" && action !== "reject") {
    return res.status(400).json({
      success: false,
      message: "Invalid action. Use 'approve' or 'reject'",
    });
  }

  if (action === "reject" && !String(reason || "").trim()) {
    return res.status(400).json({
      success: false,
      message: "A reason is required to reject a bank update request",
    });
  }

  const driver = await Driver.findById(id);
  if (!driver) {
    return res.status(404).json({ success: false, message: "Driver not found" });
  }

  const request = driver.bankDetailsUpdateRequest;
  if (!request || request.status !== "PENDING") {
    return res.status(400).json({
      success: false,
      message: "This driver has no pending bank update request",
    });
  }

  const previousAccount = maskAccount(driver.bankDetails?.accountNumber);
  const requestedAccount = maskAccount(request.accountNumber);
  const decidedAt = new Date();

  if (action === "approve") {
    driver.bankDetails = {
      accountHolderName: request.accountHolderName,
      bankName: request.bankName || "",
      accountNumber: request.accountNumber,
      ifscCode: request.ifscCode,
      // A changed account must be re-verified; approval only says the CHANGE
      // was sanctioned, not that the account was checked against a passbook.
      isVerified: false,
    };
    request.status = "APPROVED";
    request.rejectionReason = undefined;
  } else {
    request.status = "REJECTED";
    request.rejectionReason = String(reason).trim();
  }
  request.decidedAt = decidedAt;
  // bankDetailsUpdateRequest is a nested path, not a subdocument schema —
  // mutating its keys in place is not always picked up by change tracking.
  driver.markModified("bankDetailsUpdateRequest");
  await driver.save();

  await auditFromRequest(req, {
    action: action === "approve" ? "APPROVE" : "REJECT",
    module: "drivers",
    targetId: String(driver._id),
    targetType: "Driver",
    description:
      action === "approve"
        ? `Approved bank details change for ${driver.fullName || driver._id} (${previousAccount || "none"} → ${requestedAccount})`
        : `Rejected bank details change for ${driver.fullName || driver._id} (requested ${requestedAccount}) — ${request.rejectionReason}`,
    metadata: {
      requestedAt: request.requestedAt,
      ifscCode: request.ifscCode,
      accountNumberMasked: requestedAccount,
    },
  });

  // Same propagation pair the verify/block decisions use: a socket event for a
  // live app, an inbox row (+push when FCM is up) for one that isn't.
  try {
    emitToUser(String(driver._id), "driver:bank-request", {
      status: request.status,
      rejectionReason: request.rejectionReason ?? null,
      decidedAt: decidedAt.toISOString(),
    });

    await notificationService
      .sendToDriver(
        driver._id as Types.ObjectId,
        "SYSTEM",
        action === "approve"
          ? "Bank Details Updated"
          : "Bank Update Request Rejected",
        action === "approve"
          ? `Your bank account change was approved. Payouts will now use the account ending ${requestedAccount.slice(-4)}.`
          : `Your bank account change was rejected: ${request.rejectionReason}`,
        {
          status: request.status,
          reason: request.rejectionReason ?? "",
        },
      )
      .catch(() => null);
  } catch (err) {
    console.error("Bank request decision: propagation error", err);
  }

  res.locals.data = {
    message: `Bank update request ${action === "approve" ? "approved" : "rejected"}`,
    bankDetails: driver.bankDetails,
    updateRequest: driver.bankDetailsUpdateRequest,
  };
};

/**
 * Get driver vehicles
 */
export const getDriverVehicles = async (req: Request, res: Response) => {
  const { id } = req.params;

  // Vehicles the driver onboarded (rich data with assigned-driver info,
  // RC images, verification status, onboarding fee status, etc.)
  const onboardedVehicles = await Vehicle.find({
    driverId: id,
    isDeleted: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .lean();

  // Active dispatch-level vehicle assignments (online/active flags).
  // Joined to the rich vehicle by registration/vehicleNumber so the admin can
  // see which onboarded vehicle is currently active for dispatch.
  const driverVehicles = await DriverVehicle.find({
    driverId: id,
    isDeleted: false,
  })
    .populate("vehicleTypeId", "name icon maxWeightKg")
    .lean();

  const dispatchByNumber = new Map<string, (typeof driverVehicles)[number]>();
  for (const dv of driverVehicles) {
    if (dv.registrationNumber) {
      dispatchByNumber.set(dv.registrationNumber.toUpperCase(), dv);
    }
  }

  const vehicles = onboardedVehicles.map((v) => {
    const dispatch = dispatchByNumber.get((v.vehicleNumber || "").toUpperCase());
    return {
      _id: v._id,
      vehicleNumber: v.vehicleNumber,
      registrationNumber: v.vehicleNumber, // alias for existing admin UI
      vehicleType: v.vehicleType,
      vehicleBodyType: v.vehicleBodyType,
      fuelType: v.fuelType,
      city: v.city,
      rcFrontImage: v.rcFrontImage,
      rcBackImage: v.rcBackImage,
      vehicleImages: v.vehicleImages,
      assignedDriverName: v.assignedDriverName,
      assignedDriverPhone: v.assignedDriverPhone,
      assignedDriverLicenseFrontImage: v.assignedDriverLicenseFrontImage,
      assignedDriverLicenseBackImage: v.assignedDriverLicenseBackImage,
      onboardingFeePaid: v.onboardingFeePaid,
      referralDiscount: v.referralDiscount,
      verificationStatus: v.verificationStatus,
      rejectionReason: v.rejectionReason,
      isPrimary: v.isPrimary,
      isActive: v.isActive,
      isOnline: dispatch?.isOnline ?? false,
      vehicleTypeId: dispatch?.vehicleTypeId ?? null,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  });

  res.locals.data = { vehicles };
};

/**
 * Delete driver (soft delete)
 */
export const deleteDriver = async (req: Request, res: Response) => {
  const { id } = req.params;

  const driver = await Driver.findByIdAndUpdate(
    id,
    {
      isDeleted: true,
      deletedAt: new Date(),
      isActive: false,
      isOnline: false,
    },
    { new: true },
  );

  if (!driver) {
    return res.status(404).json({
      success: false,
      message: "Driver not found",
    });
  }

  res.locals.data = {
    message: "Driver deleted successfully",
    driver,
  };
};

/**
 * Restore deleted driver
 */
export const restoreDriver = async (req: Request, res: Response) => {
  const { id } = req.params;

  const driver = await Driver.findByIdAndUpdate(
    id,
    { isDeleted: false, deletedAt: null, isActive: true },
    { new: true },
  );

  if (!driver) {
    return res.status(404).json({
      success: false,
      message: "Driver not found",
    });
  }

  res.locals.data = {
    message: "Driver restored successfully",
    driver,
  };
};

/**
 * Get driver bookings
 */
export const getDriverBookings = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { page = 0, limit = 20 } = req.query;

  const bookings = await Booking.find({ driverId: id })
    .populate("userId", "fullName mobileNumber")
    .sort({ createdAt: -1 })
    .skip(Number(page) * Number(limit))
    .limit(Number(limit))
    .lean();

  const total = await Booking.countDocuments({ driverId: id });

  res.locals.data = {
    bookings,
    total,
    page: Number(page),
    totalPages: Math.ceil(total / Number(limit)),
  };
};

/**
 * Get driver earnings
 */
export const getDriverEarnings = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { dateFrom, dateTo } = req.query;

  // Booking.driverId is an ObjectId and Mongoose does not cast $match inside an
  // aggregation pipeline, so matching on the raw string from req.params matched
  // nothing and this endpoint reported ₹0 for every driver.
  const matchQuery: any = {
    driverId: Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id,
    status: "COMPLETED",
  };

  if (dateFrom || dateTo) {
    matchQuery.createdAt = {};
    if (dateFrom) matchQuery.createdAt.$gte = new Date(dateFrom as string);
    if (dateTo) matchQuery.createdAt.$lte = new Date(dateTo as string);
  }

  const earnings = await Booking.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: null,
        totalEarnings: { $sum: "$driverEarnings" },
        totalTrips: { $sum: 1 },
        totalDistance: { $sum: "$distance" },
      },
    },
  ]);

  const dailyEarnings = await Booking.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        earnings: { $sum: "$driverEarnings" },
        trips: { $sum: 1 },
      },
    },
    { $sort: { _id: -1 } },
    { $limit: 30 },
  ]);

  res.locals.data = {
    summary: earnings[0] || {
      totalEarnings: 0,
      totalTrips: 0,
      totalDistance: 0,
    },
    dailyEarnings,
  };
};

/**
 * PUT /admin/drivers/:id/vehicles/:vehicleId/verify — approve or reject ONE
 * vehicle.
 *
 * Driver-level verification blanket-updates every vehicle, and its button
 * disappears once the driver is approved — so a 2nd vehicle sat at "pending"
 * forever with no reachable approval path. This is that path. Approval also
 * activates the vehicle's dispatch row (the same catalog-type bridging
 * verifyDriver does); rejection deactivates it, taking the vehicle out of
 * dispatch.
 */
export const verifyDriverVehicle = async (req: Request, res: Response) => {
  const { id, vehicleId } = req.params;
  const { action, rejectionReason } = req.body;

  if (action !== "approve" && action !== "reject") {
    return res.status(400).json({
      success: false,
      message: "action must be 'approve' or 'reject'",
    });
  }
  if (action === "reject" && !rejectionReason) {
    return res.status(400).json({
      success: false,
      message: "rejectionReason is required when rejecting",
    });
  }

  const vehicle = await Vehicle.findOne({
    _id: vehicleId,
    driverId: id,
    isDeleted: { $ne: true },
  });
  if (!vehicle) {
    return res
      .status(404)
      .json({ success: false, message: "Vehicle not found for this driver" });
  }

  vehicle.verificationStatus = action === "approve" ? "approved" : "rejected";
  (vehicle as any).rejectionReason =
    action === "reject" ? String(rejectionReason) : undefined;
  await vehicle.save();

  // Sync the dispatch row for THIS vehicle only — same fallback as the
  // driver-level bridge: rows predating vehicleTypeId only know a category,
  // so use that category's designated default rather than stranding the
  // vehicle un-dispatchable.
  if (vehicle.vehicleNumber) {
    let typeId: any = (vehicle as any).vehicleTypeId;
    if (!typeId && (vehicle as any).vehicleType) {
      const fallback = await VehicleType.findOne({
        categoryCode: (vehicle as any).vehicleType,
        isDefaultForCategory: true,
        isActive: true,
      }).select("_id");
      typeId = fallback?._id;
    }
    if (typeId) {
      await DriverVehicle.findOneAndUpdate(
        { registrationNumber: String(vehicle.vehicleNumber).toUpperCase() },
        {
          $set: {
            driverId: vehicle.driverId,
            vehicleTypeId: typeId,
            isActive: action === "approve",
            isDeleted: false,
          },
        },
        { upsert: true, new: true },
      );
    } else if (action === "approve") {
      console.warn(
        `[vehicle-verify] ${vehicle.vehicleNumber} approved but has no catalog type and no category default — it will NOT be dispatchable`,
      );
    }
  }

  // Tell the driver — same channel as driver-level verification.
  try {
    await notificationService.sendToDriver(
      vehicle.driverId as any,
      "SYSTEM",
      action === "approve" ? "Vehicle approved" : "Vehicle rejected",
      action === "approve"
        ? `Your vehicle ${vehicle.vehicleNumber} has been approved and can now receive bookings.`
        : `Your vehicle ${vehicle.vehicleNumber} was rejected: ${rejectionReason}`,
      { type: "VEHICLE_VERIFICATION", vehicleId: String(vehicle._id) },
    );
  } catch (e) {
    console.error("vehicle verification notification failed", e);
  }

  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "drivers",
    description: `${action === "approve" ? "Approved" : "Rejected"} vehicle ${vehicle.vehicleNumber} for driver ${id}`,
    targetType: "Vehicle",
    targetId: String(vehicle._id),
  });

  res.locals.data = { vehicle };
};

/**
 * GET /admin/drivers/pending-vehicles — every vehicle awaiting approval, with
 * its driver. The driver-level pending queue counts Driver.status only, so an
 * APPROVED driver's newly added vehicle appeared in no list at all — an admin
 * had to stumble into that driver's drawer to notice it.
 */
export const listPendingVehicles = async (_req: Request, res: Response) => {
  const vehicles = await Vehicle.find({
    isDeleted: { $ne: true },
    verificationStatus: { $in: ["pending", "under_verification"] },
  })
    .sort({ createdAt: -1 })
    .populate("driverId", "fullName mobileNumber status")
    .lean();

  res.locals.data = { vehicles, total: vehicles.length };
};
