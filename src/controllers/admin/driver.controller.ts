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

/**
 * Normalize a DriverKyc record into the flat `documents[]` array the admin
 * document-compliance page consumes. Each entry: { type, url, expiryDate,
 * verificationStatus, isVerified, uploadedAt, verifiedAt }.
 *
 * KYC has only one top-level isVerified, and real approval lives on
 * Driver.status, so per-document verification is derived: if the driver is
 * "approved" the uploaded docs count as verified; otherwise they're "pending".
 * Only documents that were actually uploaded (have an image URL) are emitted;
 * types the driver hasn't uploaded are simply absent (page treats as missing).
 */
const buildDriverDocuments = (kyc: any, driverStatus?: string) => {
  if (!kyc) return [];
  const approved = driverStatus === "approved";
  const rejected = driverStatus === "rejected";
  const statusFor = () =>
    approved ? "verified" : rejected ? "rejected" : "pending";
  const isVerifiedFlag = approved ? true : false;
  const uploadedAt = kyc.updatedAt || kyc.createdAt;
  const verifiedAt = approved ? kyc.verifiedAt || undefined : undefined;

  const docs: any[] = [];
  const push = (type: string, url?: string, expiryDate?: string) => {
    if (!url) return;
    docs.push({
      type,
      url,
      expiryDate: expiryDate || undefined,
      verificationStatus: statusFor(),
      isVerified: isVerifiedFlag,
      uploadedAt,
      verifiedAt,
    });
  };

  push(
    "driving_license",
    kyc.drivingLicense?.frontImage,
    kyc.drivingLicense?.expiryDate,
  );
  push("rc_book", kyc.vehicleRc?.image);
  push("aadhar", kyc.aadhaar?.frontImage);
  push("pan", kyc.pan?.frontImage);
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
    page = 0,
    limit = 20,
  } = req.query;

  const query: any = { isDeleted: false };

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
  const kycByDriver = new Map<string, any>();
  kycRecords.forEach((k) => kycByDriver.set(String(k.driverId), k));

  // Get additional stats
  const driversWithStats = await Promise.all(
    drivers.map(async (driver) => {
      const completedTrips = await Booking.countDocuments({
        driverId: driver._id,
        status: "COMPLETED",
      });
      const earnings = await Booking.aggregate([
        { $match: { driverId: driver._id, status: "COMPLETED" } },
        { $group: { _id: null, total: { $sum: "$finalFare" } } },
      ]);
      return {
        ...driver.toObject(),
        completedTrips,
        totalEarnings: earnings[0]?.total || 0,
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

  // Get booking stats
  const bookingStats = await Booking.aggregate([
    { $match: { driverId: driver._id } },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
        totalEarnings: { $sum: "$finalFare" },
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

  res.locals.data = {
    byStatus: stats,
    onlineDrivers: onlineCount,
    activeDrivers,
    inactiveDrivers,
    unassignedOrders,
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

  const matchQuery: any = { driverId: id, status: "COMPLETED" };

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
