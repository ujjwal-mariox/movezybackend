import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import crypto from "crypto";
import DriverModel from "../models/driver.model";
import DriverVehicleModel from "../models/driver-vehicle.model";
import BookingModel from "../models/booking.model";
import WalletModel from "../models/wallet.model";
import WalletTransactionModel from "../models/wallet-transaction.model";
import RewardTransaction from "../models/reward-transaction.model";
import * as DriverLocationService from "../services/driver-location.service";
import * as BookingDispatchService from "../services/booking-dispatch.service";
import * as fileUploadService from "../utils/s3";
import { getIO } from "../utils/socket.util";
import User from "../models/Users";
import * as RewardService from "../services/reward.service";
import * as WalletService from "../services/wallet.service";
import * as CoinService from "../services/coin.service";
import * as SupportService from "../services/support.service";
import DriverInstruction from "../models/driver-instruction.model";
import Badge from "../models/badge.model";
import TrainingMaterial from "../models/training-material.model";
import VehicleTypeModel from "../models/vehicle-type.model";
import DriverKycModel from "../models/driver-kyc.model";
import VehicleModel from "../models/vehicle.model";
import * as PaymentService from "../services/payment.service";
import { Notification } from "../models/notification.model";
import * as IncentiveService from "../services/incentive.service";
import * as SOSService from "../services/sos.service";
import { AppConfig } from "../models/app-config.model";
import { cache } from "../utils/redis.util";
import Payout from "../models/payout.model";
import * as DriverPayoutService from "../services/driver-payout.service";

const DEFAULT_JOINING_FEE = 999;

/**
 * Get the joining fee amount from AppConfig (cached).
 * Falls back to 999 if not configured.
 */
const getJoiningFee = async (): Promise<number> => {
  const cached = await cache.get<number>("config:joining_fee");
  if (cached !== null && cached !== undefined) return cached;

  const config = await AppConfig.findOne({ key: "joining_fee" });
  const fee = config ? Number(config.value) : DEFAULT_JOINING_FEE;
  await cache.set("config:joining_fee", fee, 3600); // cache 1 hour
  return fee;
};

const ACTIVE_BOOKING_STATUSES = [
  "ASSIGNED",
  "DRIVER_ARRIVED",
  "PICKED",
  "IN_PROGRESS",
];

const DISCOVERABLE_BOOKING_STATUSES = ["SEARCHING", "PENDING"];

// =====================
// PROFILE
// =====================

export const getDashboard = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const driverObjectId = new Types.ObjectId(driverId);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const monthlyStart = new Date(now.getFullYear(), now.getMonth() - 7, 1);

    // Get driver's active vehicle to filter pending bookings
    const activeVehicle = await DriverVehicleModel.findOne({
      driverId: driverObjectId,
      isActive: true,
      isDeleted: { $ne: true },
    }).lean();

    let pendingFilter: any = {
      driverId: null,
      status: { $in: DISCOVERABLE_BOOKING_STATUSES },
    };

    if (activeVehicle) {
      // Filter by vehicle type
      pendingFilter.vehicleTypeId = activeVehicle.vehicleTypeId;

      // Filter by service type based on vehicle's allowed service types
      const vehicleType = await VehicleTypeModel.findById(
        activeVehicle.vehicleTypeId,
      )
        .select("allowIntraCity allowInterCity")
        .lean();

      if (vehicleType) {
        const allowedServiceTypes: string[] = [];
        if (vehicleType.allowIntraCity) allowedServiceTypes.push("WITHIN_CITY");
        if (vehicleType.allowInterCity) allowedServiceTypes.push("OUTSTATION");
        if (allowedServiceTypes.length > 0) {
          pendingFilter.serviceType = { $in: allowedServiceTypes };
        }
      }
    }

    const [
      driver,
      wallet,
      lifetimeStats,
      todayStats,
      onGoingCount,
      completedCount,
      pendingCount,
      currentBooking,
      pendingBookings,
      completedBookings,
      monthlyRevenue,
    ] = await Promise.all([
      DriverModel.findById(driverId)
        .select(
          "fullName mobileNumber countryCode status isOnline rating totalRides profilePhoto city state rejectionReason suspensionReason",
        )
        .lean(),
      WalletModel.findOne({ userId: driverObjectId })
        .select("balance lockedBalance")
        .lean(),
      BookingModel.aggregate([
        {
          $match: {
            driverId: driverObjectId,
            status: "COMPLETED",
          },
        },
        {
          $group: {
            _id: null,
            totalEarnings: { $sum: { $ifNull: ["$finalFare", "$fare"] } },
            totalServices: { $sum: 1 },
          },
        },
      ]),
      BookingModel.aggregate([
        {
          $match: {
            driverId: driverObjectId,
            status: "COMPLETED",
            completedAt: { $gte: todayStart },
          },
        },
        {
          $group: {
            _id: null,
            todaysEarnings: { $sum: { $ifNull: ["$finalFare", "$fare"] } },
            todaysServices: { $sum: 1 },
          },
        },
      ]),
      BookingModel.countDocuments({
        driverId: driverObjectId,
        status: { $in: ACTIVE_BOOKING_STATUSES },
      }),
      BookingModel.countDocuments({
        driverId: driverObjectId,
        status: "COMPLETED",
      }),
      BookingModel.countDocuments(pendingFilter),
      BookingModel.findOne({
        driverId: driverObjectId,
        status: { $in: ACTIVE_BOOKING_STATUSES },
      })
        .populate("userId", "fullName")
        .populate("vehicleTypeId", "name icon")
        .sort({ createdAt: -1 })
        .lean(),
      BookingModel.find(pendingFilter)
        .populate("userId", "fullName")
        .populate("vehicleTypeId", "name icon")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      BookingModel.find({
        driverId: driverObjectId,
        status: "COMPLETED",
      })
        .populate("userId", "fullName")
        .populate("vehicleTypeId", "name icon")
        .sort({ completedAt: -1, createdAt: -1 })
        .limit(5)
        .lean(),
      BookingModel.aggregate([
        {
          $match: {
            driverId: driverObjectId,
            status: "COMPLETED",
            completedAt: { $gte: monthlyStart },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$completedAt" },
              month: { $month: "$completedAt" },
            },
            amount: { $sum: { $ifNull: ["$finalFare", "$fare"] } },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
    ]);

    if (!driver) {
      req.rCode = 5;
      req.msg = "driver_not_found";
      return next();
    }

    // If no profilePhoto, fallback to KYC selfie
    if (!driver.profilePhoto) {
      const kyc = await DriverKycModel.findOne({ driverId: driverObjectId })
        .select("selfie")
        .lean();
      if (kyc?.selfie) {
        driver.profilePhoto = kyc.selfie as string;
        // Also update the driver record so this fallback only runs once
        await DriverModel.findByIdAndUpdate(driverId, { profilePhoto: kyc.selfie });
      }
    }

    if (driver.status !== "approved" && driver.isOnline) {
      await DriverModel.findByIdAndUpdate(driverId, { isOnline: false });
      driver.isOnline = false;
    }

    const lifetime = lifetimeStats[0] || { totalEarnings: 0, totalServices: 0 };
    const today = todayStats[0] || { todaysEarnings: 0, todaysServices: 0 };
    const monthlyRevenueMap = new Map(
      monthlyRevenue.map((entry: any) => [
        `${entry._id.year}-${entry._id.month}`,
        Number(entry.amount || 0),
      ]),
    );

    const revenueTrend = Array.from({ length: 8 }, (_, index) => {
      const date = new Date(now.getFullYear(), now.getMonth() - (7 - index), 1);
      const key = `${date.getFullYear()}-${date.getMonth() + 1}`;

      return {
        month: date.toLocaleString("en-US", { month: "short" }),
        amount: monthlyRevenueMap.get(key) || 0,
      };
    });

    req.rData = {
      driver: {
        id: String((driver as any)._id),
        fullName: driver.fullName || "",
        mobileNumber: driver.mobileNumber || "",
        countryCode: driver.countryCode || "+91",
        status: driver.status || "",
        isOnline: Boolean(driver.isOnline),
        rating: Number(driver.rating || 0),
        totalRides: Number(driver.totalRides || 0),
        profilePhoto: driver.profilePhoto || "",
        city: driver.city || "",
        state: driver.state || "",
        rejectionReason: driver.rejectionReason || "",
        suspensionReason: driver.suspensionReason || "",
      },
      wallet: {
        balance: Number(wallet?.balance || 0),
        lockedBalance: Number(wallet?.lockedBalance || 0),
      },
      stats: {
        totalEarnings: Number(lifetime.totalEarnings || 0),
        totalServices: Number(lifetime.totalServices || 0),
        upcomingServices: Number(onGoingCount || 0),
        todaysServices: Number(today.todaysServices || 0),
        todaysEarnings: Number(today.todaysEarnings || 0),
        onGoingCount: Number(onGoingCount || 0),
        pendingCount: Number(pendingCount || 0),
        completedCount: Number(completedCount || 0),
        monthlyRevenue: revenueTrend,
      },
      bookings: {
        current: currentBooking ? mapDashboardBooking(currentBooking) : null,
        pending: pendingBookings.map((booking) => mapDashboardBooking(booking)),
        completed: completedBookings.map((booking) =>
          mapDashboardBooking(booking),
        ),
      },
    };
    req.msg = "dashboard_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const driver = await DriverModel.findById(driverId).select("-__v").lean();

    if (!driver) {
      req.rCode = 0;
      req.msg = "driver_not_found";
      return next();
    }

    // Get statistics
    const bookingStats = await BookingModel.aggregate([
      {
        $match: { driverId: new Types.ObjectId(driverId), status: "COMPLETED" },
      },
      {
        $group: {
          _id: null,
          totalTrips: { $sum: 1 },
          totalEarnings: { $sum: { $ifNull: ["$finalFare", "$fare"] } },
          totalDistance: { $sum: "$distanceKm" },
          totalDurationMin: { $sum: "$durationMin" },
        },
      },
    ]);

    const stats = bookingStats[0] || {
      totalTrips: 0,
      totalEarnings: 0,
      totalDistance: 0,
      totalDurationMin: 0,
    };

    req.rData = {
      ...driver,
      stats: {
        totalTrips: stats.totalTrips,
        totalEarnings: stats.totalEarnings,
        totalDistance: Math.round(stats.totalDistance * 100) / 100,
        totalDurationMin: stats.totalDurationMin,
      },
    };
    req.msg = "profile_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const updateProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { fullName, email, gender, dob, bloodGroup, languages } = req.body;

    const driver = await DriverModel.findByIdAndUpdate(
      driverId,
      {
        ...(fullName && { fullName }),
        ...(email && { email }),
        ...(gender && { gender }),
        ...(dob && { dob }),
        ...(bloodGroup && { bloodGroup }),
        ...(languages && { languages }),
      },
      { new: true },
    );

    req.rData = driver;
    req.msg = "profile_updated";
    next();
  } catch (error) {
    next(error);
  }
};

export const updateProfilePhoto = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    if (!req.file) {
      req.rCode = 0;
      req.msg = "photo_required";
      return next();
    }

    const upload = await fileUploadService.uploadFileToAws([req.file]);

    const driver = await DriverModel.findByIdAndUpdate(
      driverId,
      { profilePhoto: upload.images },
      { new: true },
    );

    req.rData = driver;
    req.msg = "photo_updated";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// BANK DETAILS
// =====================

export const getBankDetails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const driver = await DriverModel.findById(driverId)
      .select("bankDetails")
      .lean();

    req.rData = driver?.bankDetails || null;
    req.msg = "bank_details_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const updateBankDetails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { accountHolderName, bankName, accountNumber, ifscCode } = req.body;

    const driver = await DriverModel.findByIdAndUpdate(
      driverId,
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

    req.rData = driver?.bankDetails;
    req.msg = "bank_details_updated";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// ADDRESS
// =====================

export const getAddresses = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const driver = await DriverModel.findById(driverId)
      .select("addresses")
      .lean();

    req.rData = driver?.addresses || [];
    req.msg = "addresses_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const addAddress = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { type, addressLine1, addressLine2, city, state, pincode, country } =
      req.body;

    const newAddress = {
      _id: new Types.ObjectId(),
      type,
      addressLine1,
      addressLine2,
      city,
      state,
      pincode,
      country: country || "India",
    };

    const driver = await DriverModel.findByIdAndUpdate(
      driverId,
      { $push: { addresses: newAddress } },
      { new: true },
    );

    req.rData = driver?.addresses;
    req.msg = "address_added";
    next();
  } catch (error) {
    next(error);
  }
};

export const updateAddress = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { addressId } = req.params;
    const updateData = req.body;

    await DriverModel.updateOne(
      { _id: driverId, "addresses._id": addressId },
      { $set: { "addresses.$": { ...updateData, _id: addressId } } },
    );

    req.msg = "address_updated";
    next();
  } catch (error) {
    next(error);
  }
};

export const deleteAddress = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { addressId } = req.params;

    await DriverModel.updateOne(
      { _id: driverId },
      { $pull: { addresses: { _id: addressId } } },
    );

    req.msg = "address_deleted";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// EARNINGS & WALLET
// =====================

export const getEarnings = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { period = "today" } = req.query;

    let startDate = new Date();
    startDate.setHours(0, 0, 0, 0);

    if (period === "weekly") {
      startDate.setDate(startDate.getDate() - 7);
    } else if (period === "monthly") {
      startDate.setMonth(startDate.getMonth() - 1);
    }

    const earnings = await BookingModel.aggregate([
      {
        $match: {
          driverId: new Types.ObjectId(driverId),
          status: "COMPLETED",
          completedAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: "$fare" },
          completedTrips: { $sum: 1 },
        },
      },
    ]);

    const stats = earnings[0] || {
      totalEarnings: 0,
      completedTrips: 0,
    };

    req.rData = stats;
    req.msg = "earnings_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getEarningsHistory = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { page = 1, limit = 20 } = req.query;

    const bookings = await BookingModel.find({
      driverId: new Types.ObjectId(driverId),
      status: "COMPLETED",
    })
      .select("bookingNumber fare completedAt pickup drop distanceKm")
      .sort({ completedAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    req.rData = bookings;
    req.msg = "earnings_history_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getWallet = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    let wallet = await WalletModel.findOne({
      userId: new Types.ObjectId(driverId),
    });

    if (!wallet) {
      wallet = await WalletModel.create({
        userId: new Types.ObjectId(driverId),
        balance: 0,
        lockedBalance: 0,
      });
    }

    req.rData = wallet;
    req.msg = "wallet_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getWalletTransactions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { page = 1, limit = 20, type } = req.query;

    const query: any = { userId: new Types.ObjectId(driverId) };
    if (type) query.type = type;

    const transactions = await WalletTransactionModel.find(query)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    req.rData = transactions;
    req.msg = "transactions_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const rechargeWallet = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      req.rCode = 0;
      req.msg = "invalid_amount";
      return next();
    }

    // Create a REAL Razorpay order (no more fake MZY_ id). The wallet is only
    // credited later in verifyWalletRecharge after the signature is verified.
    const order = await PaymentService.createWalletRechargeOrder(
      new Types.ObjectId(driverId),
      amount,
    );

    if (!order) {
      req.rCode = 0;
      req.msg = "payment_gateway_unavailable";
      return next();
    }

    req.rData = {
      orderId: order.id,
      amount: Number(order.amount) / 100,
      currency: order.currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
    };
    req.msg = "recharge_initiated";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Verify a driver wallet recharge payment and credit the wallet.
 * Credits ONLY after the Razorpay signature is verified server-side.
 */
export const verifyWalletRecharge = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { orderId, paymentId, signature, amount } = req.body;

    if (!orderId || !paymentId || !amount) {
      req.rCode = 0;
      req.msg = "missing_payment_details";
      return next();
    }

    const result = await PaymentService.verifyWalletRecharge(
      new Types.ObjectId(driverId),
      orderId,
      paymentId,
      signature || "",
      amount,
    );

    if (!result.success) {
      req.rCode = 0;
      req.msg = result.message || "payment_verification_failed";
      return next();
    }

    const wallet = await WalletModel.findOne({
      userId: new Types.ObjectId(driverId),
    });

    req.rData = { balance: wallet?.balance ?? 0 };
    req.msg = "recharge_success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * GET /driver/app/wallet/withdrawal-info
 * Returns the driver's withdrawable balance + minimum + bank-on-file flag +
 * recent payout requests, so the app can render the withdraw sheet with real
 * numbers (no client-side guessing).
 */
export const getWithdrawalInfo = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const [balance, driver, payouts] = await Promise.all([
      DriverPayoutService.getDriverAvailableBalance(driverId),
      DriverModel.findById(driverId).select("bankDetails").lean(),
      Payout.find({ driverId: new Types.ObjectId(driverId) })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("amount method status reference rejectionReason createdAt paidAt")
        .lean(),
    ]);

    const bank = (driver as any)?.bankDetails || {};
    const hasBankDetails = Boolean(bank.accountNumber && bank.ifscCode);

    req.rData = {
      available: balance.available,
      lifetimeEarnings: balance.lifetimeEarnings,
      reserved: balance.reserved,
      minWithdrawal: DriverPayoutService.MIN_WITHDRAWAL,
      hasBankDetails,
      bankName: bank.bankName || null,
      accountLast4:
        typeof bank.accountNumber === "string" && bank.accountNumber.length >= 4
          ? bank.accountNumber.slice(-4)
          : null,
      payouts,
    };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * POST /driver/app/wallet/withdraw
 * Driver requests a payout of their earned money. This does NOT touch the
 * (customer-keyed) wallet balance — driver earnings are computed from completed
 * trips. It creates a PENDING Payout that flows through the admin approval queue
 * (payout.controller: approve → mark-paid). An operator settles it out-of-band.
 */
export const withdrawFromWallet = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const amount = Number(req.body?.amount);
    const method = (req.body?.method || "BANK") as "BANK" | "UPI" | "CASH";

    if (!Number.isFinite(amount) || amount <= 0) {
      req.rCode = 0;
      req.msg = "invalid_amount";
      return next();
    }

    if (amount < DriverPayoutService.MIN_WITHDRAWAL) {
      req.rCode = 0;
      req.msg = "amount_below_minimum";
      req.rData = { minWithdrawal: DriverPayoutService.MIN_WITHDRAWAL };
      return next();
    }

    const driver = await DriverModel.findById(driverId).select(
      "fullName bankDetails",
    );
    if (!driver) {
      req.rCode = 0;
      req.msg = "driver_not_found";
      return next();
    }

    const bank = (driver as any).bankDetails || {};
    // BANK/UPI payouts need bank details on file; without them there's nowhere
    // to settle. (CASH could be settled in person, but we still require the
    // operator to have a record, so keep the guard for BANK/UPI.)
    if (method !== "CASH" && !(bank.accountNumber && bank.ifscCode)) {
      req.rCode = 0;
      req.msg = "bank_details_required";
      return next();
    }

    const balance = await DriverPayoutService.getDriverAvailableBalance(driverId);
    if (amount > balance.available) {
      req.rCode = 0;
      req.msg = "insufficient_balance";
      req.rData = { available: balance.available };
      return next();
    }

    const payout = await Payout.create({
      driverId: new Types.ObjectId(driverId),
      amount,
      method,
      status: "PENDING",
      notes: "Requested by driver from app",
      bankSnapshot: {
        accountHolderName: bank.accountHolderName,
        bankName: bank.bankName,
        accountNumber: bank.accountNumber,
        ifscCode: bank.ifscCode,
      },
      requestedBy: new Types.ObjectId(driverId),
      requestedByType: "Driver",
    });

    req.rData = {
      payoutId: String(payout._id),
      amount,
      status: payout.status,
      available: Math.max(balance.available - amount, 0),
    };
    req.msg = "withdrawal_requested";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// BOOKINGS (DRIVER SIDE)
// =====================

export const getRecommendedBookings = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const driverObjectId = new Types.ObjectId(driverId);

    const driver = await DriverModel.findById(driverId);
    if (!driver?.isOnline) {
      req.rData = [];
      req.msg = "driver_offline";
      return next();
    }

    // Block if driver already has an ongoing booking
    const hasOngoing = await BookingModel.findOne({
      driverId: driverObjectId,
      status: { $in: ACTIVE_BOOKING_STATUSES },
    });
    if (hasOngoing) {
      req.rData = [];
      req.msg = "active_booking_exists";
      return next();
    }

    // Get driver's active vehicle to filter by type and service
    const activeVehicle = await DriverVehicleModel.findOne({
      driverId: driverObjectId,
      isActive: true,
      isDeleted: { $ne: true },
    }).lean();

    const filter: any = {
      status: { $in: DISCOVERABLE_BOOKING_STATUSES },
      driverId: null,
    };

    if (activeVehicle) {
      filter.vehicleTypeId = activeVehicle.vehicleTypeId;

      const vehicleType = await VehicleTypeModel.findById(
        activeVehicle.vehicleTypeId,
      )
        .select("allowIntraCity allowInterCity")
        .lean();

      if (vehicleType) {
        const allowedServiceTypes: string[] = [];
        if (vehicleType.allowIntraCity) allowedServiceTypes.push("WITHIN_CITY");
        if (vehicleType.allowInterCity) allowedServiceTypes.push("OUTSTATION");
        if (allowedServiceTypes.length > 0) {
          filter.serviceType = { $in: allowedServiceTypes };
        }
      }
    }

    const bookings = await BookingModel.find(filter)
      .populate("userId", "fullName")
      .populate("vehicleTypeId", "name icon")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    req.rData = bookings.map((b) => mapDashboardBooking(b));
    req.msg = "bookings_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getBookingHistory = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { page = 1, limit = 20, status } = req.query;

    const query: any = { driverId: new Types.ObjectId(driverId) };
    if (status) query.status = status;

    const bookings = await BookingModel.find(query)
      .populate("userId", "fullName")
      .populate("vehicleTypeId", "name")
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    const total = await BookingModel.countDocuments(query);

    req.rData = { bookings, total, page: Number(page), limit: Number(limit) };
    req.msg = "history_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getCurrentBooking = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const booking = await BookingModel.findOne({
      driverId: new Types.ObjectId(driverId),
      status: { $in: ACTIVE_BOOKING_STATUSES },
    })
      .populate("userId", "fullName")
      .populate("vehicleTypeId", "name icon")
      .lean();

    req.rData = booking ? mapDashboardBooking(booking) : null;
    req.msg = booking ? "booking_fetched" : "no_active_booking";
    next();
  } catch (error) {
    next(error);
  }
};

export const acceptBooking = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;

    // Block if driver already has an ongoing booking
    const hasOngoing = await BookingModel.findOne({
      driverId: new Types.ObjectId(driverId),
      status: { $in: ACTIVE_BOOKING_STATUSES },
    });
    if (hasOngoing) {
      req.rCode = 0;
      req.msg = "You already have an active booking. Complete it before accepting a new one.";
      return next();
    }

    // Use dispatch service to handle acceptance (auto-closes for other drivers)
    const result = await BookingDispatchService.handleDriverAcceptance(
      bookingId,
      driverId,
    );

    if (!result.success) {
      req.rCode = 0;
      req.msg = result.message || "booking_not_available";
      return next();
    }

    // Update driver status
    await DriverModel.findByIdAndUpdate(driverId, {
      currentBookingId: new Types.ObjectId(bookingId),
    });

    // Get updated booking
    const booking = await BookingModel.findById(bookingId)
      .populate("userId", "fullName")
      .populate("vehicleTypeId", "name icon")
      .lean();

    req.rData = booking ? mapDashboardBooking(booking) : null;
    req.msg = "booking_accepted";
    next();
  } catch (error) {
    next(error);
  }
};

export const rejectBooking = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;

    // Use dispatch service to handle rejection
    await BookingDispatchService.handleDriverRejection(bookingId, driverId);

    req.msg = "booking_rejected";
    next();
  } catch (error) {
    next(error);
  }
};

export const arrivedAtPickup = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;

    const booking = await BookingModel.findOneAndUpdate(
      {
        _id: bookingId,
        driverId: new Types.ObjectId(driverId),
        status: "ASSIGNED",
      },
      { status: "DRIVER_ARRIVED", driverArrivedAt: new Date() },
      { new: true },
    );

    if (!booking) {
      req.rCode = 0;
      req.msg = "invalid_booking";
      return next();
    }

    const io = getIO();
    io.to(`user_${booking.userId}`).emit("driver_arrived", booking);

    req.rData = booking;
    req.msg = "arrived_at_pickup";
    next();
  } catch (error) {
    next(error);
  }
};

export const verifyPickupOtp = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;
    const { otp } = req.body;

    const booking = await BookingModel.findOne({
      _id: bookingId,
      driverId: new Types.ObjectId(driverId),
      status: "DRIVER_ARRIVED",
    });

    if (!booking) {
      req.rCode = 0;
      req.msg = "invalid_booking";
      return next();
    }

    if (booking.otp !== otp) {
      req.rCode = 0;
      req.msg = "invalid_otp";
      return next();
    }

    booking.status = "PICKED";
    booking.pickedAt = new Date();
    await booking.save();

    req.rData = booking;
    req.msg = "otp_verified";
    next();
  } catch (error) {
    next(error);
  }
};

export const startTrip = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;

    const booking = await BookingModel.findOneAndUpdate(
      {
        _id: bookingId,
        driverId: new Types.ObjectId(driverId),
        status: "PICKED",
      },
      { status: "IN_PROGRESS" },
      { new: true },
    );

    if (!booking) {
      req.rCode = 0;
      req.msg = "invalid_booking";
      return next();
    }

    const io = getIO();
    io.to(`user_${booking.userId}`).emit("trip_started", booking);

    req.rData = booking;
    req.msg = "trip_started";
    next();
  } catch (error) {
    next(error);
  }
};

export const completeTrip = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;

    const booking = await BookingModel.findOne({
      _id: bookingId,
      driverId: new Types.ObjectId(driverId),
      status: "IN_PROGRESS",
    });

    if (!booking) {
      req.rCode = 0;
      req.msg = "invalid_booking";
      return next();
    }

    booking.status = "COMPLETED";
    booking.completedAt = new Date();
    await booking.save();

    // Update driver
    await DriverModel.findByIdAndUpdate(driverId, {
      currentBookingId: null,
      $inc: { totalRides: 1 },
    });

    // ─── REFERRAL REWARD: credit the referrer on the referee's first completed booking ───
    try {
      const bookingUser = await User.findById(booking.userId).select(
        "referredBy referralApplied"
      );

      if (bookingUser?.referredBy && bookingUser.referralApplied) {
        // Check if this is the user's first completed booking
        const completedCount = await BookingModel.countDocuments({
          userId: booking.userId,
          status: "COMPLETED",
        });

        // completedCount === 1 means this booking we just completed is the first one
        if (completedCount === 1) {
          await RewardService.addReferralReward(
            bookingUser.referredBy, // reward the referrer
            100, // ₹100 referrer reward
            booking.userId // reference: the referred user
          );
        }
      }
    } catch (referralError) {
      // Don't fail the trip completion if referral reward fails
      console.error("Referral reward error:", referralError);
    }

    // ─── EARN COINS: credit the booking user with loyalty coins on completion ───
    try {
      const coinsEarned = await CoinService.calculateCoinsEarned(
        booking.finalFare || 0,
        String(booking.vehicleTypeId || "")
      );
      if (coinsEarned > 0) {
        await CoinService.creditCoins(
          booking.userId as Types.ObjectId,
          coinsEarned,
          "BOOKING",
          booking._id as Types.ObjectId,
          "Booking",
          `Earned ${coinsEarned} coins for completed booking`
        );
      }
    } catch (coinError) {
      // Don't fail the trip completion if coin crediting fails
      console.error("Coin crediting error:", coinError);
    }

    const io = getIO();
    io.to(`user_${booking.userId}`).emit("trip_completed", booking);

    req.rData = booking;
    req.msg = "trip_completed";
    next();
  } catch (error) {
    next(error);
  }
};

export const collectCashPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;

    const booking = await BookingModel.findOneAndUpdate(
      {
        _id: bookingId,
        driverId: new Types.ObjectId(driverId),
        status: "COMPLETED",
      },
      { paymentStatus: "PAID" },
      { new: true },
    );

    if (!booking) {
      req.rCode = 0;
      req.msg = "invalid_booking";
      return next();
    }

    req.rData = booking;
    req.msg = "cash_collected";
    next();
  } catch (error) {
    next(error);
  }
};

export const getBookingDetails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;

    const booking = await BookingModel.findOne({
      _id: bookingId,
      driverId: new Types.ObjectId(driverId),
    })
      .populate("userId", "fullName mobileNumber")
      .populate("vehicleTypeId", "name")
      .lean();

    if (!booking) {
      req.rCode = 0;
      req.msg = "booking_not_found";
      return next();
    }

    req.rData = booking;
    req.msg = "booking_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// ONLINE STATUS
// =====================

export const toggleOnlineStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const requestedStatus = Boolean(req.body?.isOnline);

    const driver = await DriverModel.findById(driverId);
    if (!driver) {
      req.rCode = 5;
      req.msg = "driver_not_found";
      return next();
    }

    if (requestedStatus) {
      if (driver.status === "suspended") {
        req.rCode = 4;
        req.msg = "driver_suspended";
        req.rData = {
          isOnline: false,
          status: driver.status,
          reason: driver.suspensionReason || "",
        };
        return next();
      }

      if (driver.status !== "approved") {
        req.rCode = 4;
        req.msg = "driver_not_approved";
        req.rData = {
          isOnline: false,
          status: driver.status,
          reason: driver.rejectionReason || "",
        };
        return next();
      }
    }

    const updatedDriver = await DriverModel.findByIdAndUpdate(
      driverId,
      { isOnline: requestedStatus },
      { new: true },
    );

    req.rData = {
      isOnline: Boolean(updatedDriver?.isOnline),
      status: updatedDriver?.status || "",
    };
    req.msg = requestedStatus ? "driver_online" : "driver_offline";
    next();
  } catch (error) {
    next(error);
  }
};

export const updateLocation = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { latitude, longitude, heading, speed } = req.body;

    await DriverLocationService.updateDriverLocation(
      new Types.ObjectId(driverId),
      latitude,
      longitude,
      heading,
      speed,
    );

    req.msg = "location_updated";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// MY VEHICLES (Multi-vehicle onboarding)
// =====================

export const getMyVehicles = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const vehicles = await VehicleModel.find({
      driverId: new Types.ObjectId(driverId),
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();

    const driver = await DriverModel.findById(driverId)
      .select("fullName mobileNumber referredBy onboardingFeePaid profilePhoto")
      .lean();

    req.rData = { vehicles, driver };
    req.msg = "my_vehicles_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const addMyVehicle = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const {
      vehicleNumber,
      vehicleType,
      vehicleBodyType,
      fuelType,
      city,
      assignedDriverName,
      assignedDriverPhone,
    } = req.body;

    if (!vehicleNumber) {
      req.rCode = 0;
      req.msg = "vehicle_number_required";
      return next();
    }

    // Check duplicate
    const exists = await VehicleModel.findOne({
      vehicleNumber: vehicleNumber.toUpperCase(),
      isDeleted: { $ne: true },
    });
    if (exists) {
      req.rCode = 0;
      req.msg = "vehicle_number_already_exists";
      return next();
    }

    // Handle file uploads
    let rcImageUrl = "";
    let vehicleImageUrls: string[] = [];
    let licenseFrontUrl = "";
    let licenseBackUrl = "";

    if (Array.isArray(req.files)) {
      for (const file of req.files as Express.Multer.File[]) {
        if (file.fieldname === "rcImage") {
          const upload = await (fileUploadService as any).default.uploadFileToAws([file]);
          rcImageUrl = upload.images;
        } else if (file.fieldname === "vehicleImages") {
          const upload = await (fileUploadService as any).default.uploadFileToAws([file]);
          if (upload.images) vehicleImageUrls.push(upload.images);
        } else if (file.fieldname === "licenseFrontImage") {
          const upload = await (fileUploadService as any).default.uploadFileToAws([file]);
          licenseFrontUrl = upload.images;
        } else if (file.fieldname === "licenseBackImage") {
          const upload = await (fileUploadService as any).default.uploadFileToAws([file]);
          licenseBackUrl = upload.images;
        }
      }
    }

    const vehicle = await VehicleModel.create({
      driverId: new Types.ObjectId(driverId),
      vehicleNumber,
      vehicleType: vehicleType || "4W",
      vehicleBodyType,
      fuelType,
      city,
      rcFrontImage: rcImageUrl,
      vehicleImages: vehicleImageUrls,
      assignedDriverName,
      assignedDriverPhone,
      assignedDriverLicenseFrontImage: licenseFrontUrl,
      assignedDriverLicenseBackImage: licenseBackUrl,
      isPrimary: false,
      isActive: true,
    });

    req.rData = vehicle;
    req.msg = "vehicle_added";
    next();
  } catch (error) {
    next(error);
  }
};

export const applyVehicleReferral = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { vehicleId } = req.params;
    // The app sends `referralCode`; accept `code` too for compatibility.
    const code = req.body.referralCode ?? req.body.code;

    if (!code) {
      req.rCode = 0;
      req.msg = "referral_code_required";
      return next();
    }

    const vehicle = await VehicleModel.findOne({
      _id: vehicleId,
      driverId: new Types.ObjectId(driverId),
      isDeleted: { $ne: true },
    });

    if (!vehicle) {
      req.rCode = 0;
      req.msg = "vehicle_not_found";
      return next();
    }

    if (vehicle.onboardingFeePaid) {
      req.rCode = 0;
      req.msg = "already_paid";
      return next();
    }

    if (vehicle.referralCodeApplied) {
      req.rCode = 0;
      req.msg = "referral_already_applied";
      return next();
    }

    // Validate referral code
    const referrer = await DriverModel.findOne({ referralCode: code });
    if (!referrer || referrer._id.toString() === driverId) {
      req.rCode = 0;
      req.msg = "invalid_referral_code";
      return next();
    }

    // Apply discount (50% off)
    const joiningFee = await getJoiningFee();
    const discount = Math.floor(joiningFee / 2);

    await VehicleModel.findByIdAndUpdate(vehicleId, {
      referralCodeApplied: code,
      referralDiscount: discount,
    });

    // Also set referredBy on driver if not already set
    const driver = await DriverModel.findById(driverId);
    if (driver && !driver.referredBy) {
      await DriverModel.findByIdAndUpdate(driverId, {
        referredBy: referrer._id,
      });
    }

    req.rData = { discount, finalAmount: joiningFee - discount };
    req.msg = "referral_applied";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// VEHICLES (Legacy - DriverVehicle model)
// =====================

export const getVehicles = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const vehicles = await DriverVehicleModel.find({
      driverId: new Types.ObjectId(driverId),
    })
      .populate("vehicleTypeId", "name")
      .lean();

    req.rData = vehicles;
    req.msg = "vehicles_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const addVehicle = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { vehicleTypeId, registrationNumber } = req.body;

    const vehicle = await DriverVehicleModel.create({
      driverId: new Types.ObjectId(driverId),
      vehicleTypeId: new Types.ObjectId(vehicleTypeId),
      registrationNumber,
      isActive: false,
    });

    req.rData = vehicle;
    req.msg = "vehicle_added";
    next();
  } catch (error) {
    next(error);
  }
};

export const updateVehicle = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { vehicleId } = req.params;
    const updateData = req.body;

    const vehicle = await DriverVehicleModel.findOneAndUpdate(
      { _id: vehicleId, driverId: new Types.ObjectId(driverId) },
      updateData,
      { new: true },
    );

    req.rData = vehicle;
    req.msg = "vehicle_updated";
    next();
  } catch (error) {
    next(error);
  }
};

export const deleteVehicle = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { vehicleId } = req.params;

    await DriverVehicleModel.deleteOne({
      _id: vehicleId,
      driverId: new Types.ObjectId(driverId),
    });

    req.msg = "vehicle_deleted";
    next();
  } catch (error) {
    next(error);
  }
};

function mapDashboardBooking(booking: any) {
  return {
    id: String(booking?._id || ""),
    bookingNumber: booking?.bookingNumber || "",
    serviceType: booking?.serviceType || "",
    status: booking?.status || "",
    pickup: {
      address: booking?.pickup?.address || "",
      lat: Number(booking?.pickup?.lat || 0),
      lng: Number(booking?.pickup?.lng || 0),
      contactName: booking?.pickup?.contactName || "",
      contactPhone: booking?.pickup?.contactPhone || "",
      floor: booking?.pickup?.floor ?? null,
      isLiftAvailable: booking?.pickup?.isLiftAvailable ?? null,
    },
    drop: {
      address: booking?.drop?.address || "",
      lat: Number(booking?.drop?.lat || 0),
      lng: Number(booking?.drop?.lng || 0),
      contactName: booking?.drop?.contactName || "",
      contactPhone: booking?.drop?.contactPhone || "",
      floor: booking?.drop?.floor ?? null,
      isLiftAvailable: booking?.drop?.isLiftAvailable ?? null,
    },
    // Keep legacy flat fields for backward compat
    pickupAddress: booking?.pickup?.address || "",
    dropAddress: booking?.drop?.address || "",
    scheduledAt: booking?.scheduledAt || null,
    isScheduled: Boolean(booking?.isScheduled),
    createdAt: booking?.createdAt || null,
    completedAt: booking?.completedAt || null,
    assignedAt: booking?.assignedAt || null,
    distanceKm: Number(booking?.distanceKm || 0),
    durationMin: Number(booking?.durationMin || 0),
    estimatedFare: Number(booking?.finalFare ?? booking?.fare ?? 0),
    baseFare: Number(booking?.baseFare || 0),
    addonTotal: Number(booking?.addonTotal || 0),
    customerName: booking?.userId?.fullName || "",
    vehicleTypeName: booking?.vehicleTypeId?.name || "",
    vehicleTypeIcon: booking?.vehicleTypeId?.icon || "",
    paymentMethod: booking?.paymentMethod || "CASH",
    goodsType: booking?.goodsType || "",
    goodsDescription: booking?.goodsDescription || "",
    otp: booking?.otp || "",
    addons: (booking?.addons || []).map((a: any) => ({
      name: a?.name || "",
      price: Number(a?.price || 0),
      quantity: Number(a?.quantity || 1),
    })),
    loadingUnloading: booking?.loadingUnloading
      ? {
          type: booking.loadingUnloading.type || "NONE",
          pickupFloor: booking.loadingUnloading.pickupFloor ?? null,
          dropFloor: booking.loadingUnloading.dropFloor ?? null,
          charge: Number(booking.loadingUnloading.charge || 0),
        }
      : null,
  };
}

export const setActiveVehicle = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { vehicleId } = req.params;

    // Deactivate all vehicles
    await DriverVehicleModel.updateMany(
      { driverId: new Types.ObjectId(driverId) },
      { isActive: false },
    );

    // Activate selected vehicle
    const vehicle = await DriverVehicleModel.findOneAndUpdate(
      { _id: vehicleId, driverId: new Types.ObjectId(driverId) },
      { isActive: true },
      { new: true },
    );

    req.rData = vehicle;
    req.msg = "vehicle_activated";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// TRAINING & LEARNING
// =====================

export const getTrainingModules = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const materials = await TrainingMaterial.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: -1 })
      .select("title description type url thumbnailUrl")
      .lean();

    req.rData = materials;
    req.msg = "training_materials_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getTrainingModuleDetails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { moduleId } = req.params;

    const material = await TrainingMaterial.findById(moduleId)
      .select("title description type url thumbnailUrl")
      .lean();

    if (!material) {
      req.rData = null;
      req.msg = "material_not_found";
      return next();
    }

    req.rData = material;
    req.msg = "material_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const completeTrainingLesson = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { moduleId, lessonId } = req.params;

    await DriverModel.findByIdAndUpdate(driverId, {
      $addToSet: { completedLessons: `${moduleId}_${lessonId}` },
    });

    req.msg = "lesson_completed";
    next();
  } catch (error) {
    next(error);
  }
};

export const getTrainingProgress = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const driver =
      await DriverModel.findById(driverId).select("completedLessons");
    const completedCount = driver?.completedLessons?.length || 0;
    const totalLessons = 16;

    req.rData = {
      completedLessons: completedCount,
      totalLessons,
      progressPercentage: Math.round((completedCount / totalLessons) * 100),
    };
    req.msg = "progress_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// BADGES & ACHIEVEMENTS
// =====================

export const getBadges = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const driverObjectId = new Types.ObjectId(driverId);

    // Fetch all active badges from DB
    const allBadges = await Badge.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .lean();

    // Get driver details for evaluating unlock status
    const driver = await DriverModel.findById(driverObjectId)
      .select("unlockedBadges rating")
      .lean();

    const unlockedSet = new Set(
      (driver?.unlockedBadges || []).map((id: any) => id.toString()),
    );

    // Get completed trip count
    const tripStats = await BookingModel.aggregate([
      {
        $match: {
          driverId: driverObjectId,
          status: "COMPLETED",
        },
      },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]);
    const totalTrips = tripStats[0]?.count || 0;

    // Get cancelled booking count
    const cancelledCount = await BookingModel.countDocuments({
      driverId: driverObjectId,
      status: "CANCELLED",
    });

    // Check KYC status
    const driverFull = await DriverModel.findById(driverObjectId)
      .select("kyc")
      .lean();
    const isKycVerified = (driverFull as any)?.kyc?.isVerified === true;

    // Evaluate each badge
    const badgesWithStatus = allBadges.map((badge: any) => {
      let isUnlocked = unlockedSet.has(badge._id.toString());
      let progress = 0;
      let progressTarget = badge.unlockValue || 0;
      let progressLabel = "";

      if (!isUnlocked) {
        switch (badge.unlockType) {
          case "kyc_verified":
            isUnlocked = isKycVerified;
            progress = isKycVerified ? 1 : 0;
            progressTarget = 1;
            progressLabel = isKycVerified
              ? "KYC & Documents Verified"
              : "Complete KYC to unlock";
            break;
          case "trips":
            isUnlocked = totalTrips >= badge.unlockValue;
            progress = Math.min(totalTrips, badge.unlockValue);
            progressLabel = `${totalTrips} Trips Completed`;
            break;
          case "rating":
            const driverRating = (driver as any)?.rating || 0;
            isUnlocked = driverRating >= badge.unlockValue;
            progress = driverRating;
            progressLabel = `Rating: ${driverRating}`;
            break;
          case "zero_cancellation":
            isUnlocked = totalTrips > 0 && cancelledCount === 0;
            progress = cancelledCount === 0 ? 1 : 0;
            progressTarget = 1;
            progressLabel =
              cancelledCount === 0
                ? "Perfect Reliability"
                : `${cancelledCount} cancellations`;
            break;
          default:
            progressLabel = isUnlocked ? badge.description : "Not yet unlocked";
        }

        // Auto-unlock if criteria met
        if (isUnlocked && !unlockedSet.has(badge._id.toString())) {
          DriverModel.findByIdAndUpdate(driverObjectId, {
            $addToSet: { unlockedBadges: badge._id.toString() },
          }).catch(() => {});
        }
      } else {
        progress = progressTarget;
        progressLabel = badge.description;
      }

      return {
        _id: badge._id,
        name: badge.name,
        description: badge.description,
        icon: badge.icon,
        category: badge.category,
        unlockType: badge.unlockType,
        unlockValue: badge.unlockValue,
        isUnlocked,
        progress,
        progressTarget,
        progressLabel,
      };
    });

    req.rData = badgesWithStatus;
    req.msg = "badges_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getUnlockedBadges = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const driver =
      await DriverModel.findById(driverId).select("unlockedBadges");

    req.rData = driver?.unlockedBadges || [];
    req.msg = "unlocked_badges_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getBadgeRequirements = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { badgeId } = req.params;
    const badge = await Badge.findById(badgeId).lean();

    if (!badge) {
      req.rData = null;
      req.msg = "badge_not_found";
      return next();
    }

    req.rData = {
      type: badge.unlockType,
      target: badge.unlockValue,
      description: badge.description,
    };
    req.msg = "requirements_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// INCENTIVES
// =====================

export const getIncentives = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    // Real incentive summary computed from the driver's completed bookings.
    req.rData = (await IncentiveService.getDriverIncentiveSummary(
      driverId,
    )) as any;
    req.msg = "incentives_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getActiveIncentives = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    // Real not-yet-achieved offers (was a hardcoded list).
    req.rData = (await IncentiveService.getActiveIncentiveOffers(
      driverId,
    )) as any;
    req.msg = "active_incentives_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// REFERRAL
// =====================

export const getReferralCode = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const driver = await DriverModel.findById(driverId).select("referralCode");

    if (!driver?.referralCode) {
      const code = `MZD${driverId.toString().slice(-6).toUpperCase()}`;
      await DriverModel.findByIdAndUpdate(driverId, { referralCode: code });
      req.rData = { referralCode: code };
    } else {
      req.rData = { referralCode: driver.referralCode };
    }

    req.msg = "referral_code_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const applyReferralCode = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { code } = req.body;

    const driver = await DriverModel.findById(driverId);
    if (driver?.referredBy) {
      req.rCode = 0;
      req.msg = "referral_already_applied";
      return next();
    }

    const referrer = await DriverModel.findOne({ referralCode: code });
    if (!referrer) {
      req.rCode = 0;
      req.msg = "invalid_referral_code";
      return next();
    }

    await DriverModel.findByIdAndUpdate(driverId, { referredBy: referrer._id });

    req.msg = "referral_applied";
    next();
  } catch (error) {
    next(error);
  }
};

export const getReferralHistory = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const referrals = await DriverModel.find({
      referredBy: new Types.ObjectId(driverId),
    })
      .select("fullName createdAt")
      .sort({ createdAt: -1 })
      .lean();

    req.rData = referrals;
    req.msg = "referral_history_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// ONBOARDING PAYMENT
// =====================

export const getOnboardingFee = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    // Count unpaid vehicles
    const unpaidVehicles = await VehicleModel.find({
      driverId: new Types.ObjectId(driverId),
      isDeleted: { $ne: true },
      onboardingFeePaid: { $ne: true },
    }).lean();

    const joiningFee = await getJoiningFee();

    const vehicleFees = unpaidVehicles.map((v) => ({
      vehicleId: v._id,
      vehicleNumber: v.vehicleNumber,
      baseAmount: joiningFee,
      discount: v.referralDiscount || 0,
      finalAmount: Math.max(0, joiningFee - (v.referralDiscount || 0)),
    }));

    const totalAmount = vehicleFees.reduce((sum, v) => sum + v.finalAmount, 0);

    req.rData = {
      amount: joiningFee,
      currency: "INR",
      description: "One time joining fee per vehicle.",
      vehicles: vehicleFees,
      totalAmount,
    };
    req.msg = "fee_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const payOnboardingFee = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { vehicleId, vehicleIds } = req.body;

    // Accept either a single vehicleId (legacy) or an array of vehicleIds
    // (bulk pay-for-all-unpaid). Normalize to an array of ObjectIds.
    const requestedIds: string[] = Array.isArray(vehicleIds) && vehicleIds.length > 0
      ? vehicleIds
      : vehicleId
        ? [vehicleId]
        : [];

    if (requestedIds.length === 0) {
      req.rCode = 0;
      req.msg = "vehicle_id_required";
      return next();
    }

    const vehicles = await VehicleModel.find({
      _id: { $in: requestedIds.map((v) => new Types.ObjectId(v)) },
      driverId: new Types.ObjectId(driverId),
      isDeleted: { $ne: true },
    });

    if (vehicles.length !== requestedIds.length) {
      req.rCode = 0;
      req.msg = "vehicle_not_found";
      return next();
    }

    const unpaid = vehicles.filter((v) => !v.onboardingFeePaid);
    if (unpaid.length === 0) {
      req.rCode = 0;
      req.msg = "already_paid";
      return next();
    }

    const joiningFee = await getJoiningFee();
    const amount = unpaid.reduce(
      (sum, v) =>
        sum + Math.max(0, joiningFee - (v.referralDiscount || 0)),
      0,
    );

    const order = await PaymentService.createOrder(
      amount,
      "INR",
      `veh_${unpaid[0]._id}_${unpaid.length}`,
      {
        driverId,
        vehicleIds: unpaid.map((v) => v._id.toString()).join(","),
        vehicleCount: unpaid.length.toString(),
      },
    );

    if (!order) {
      req.rCode = 0;
      req.msg = "payment_order_failed";
      return next();
    }

    // Store orderId on every vehicle being paid for so verify can find them.
    await VehicleModel.updateMany(
      { _id: { $in: unpaid.map((v) => v._id) } },
      { onboardingOrderId: order.id },
    );

    req.rData = {
      orderId: order.id,
      amount,
      currency: "INR",
      vehicleId: unpaid[0]._id, // legacy field for older clients
      vehicleIds: unpaid.map((v) => v._id.toString()),
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
    };
    req.msg = "payment_initiated";
    next();
  } catch (error) {
    next(error);
  }
};

export const verifyOnboardingPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const {
      vehicleId,
      vehicleIds,
      paymentId: paymentIdLegacy,
      orderId: orderIdLegacy,
      signature: signatureLegacy,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
    } = req.body;

    const paymentId = razorpay_payment_id || paymentIdLegacy;
    const orderId = razorpay_order_id || orderIdLegacy;
    const signature = razorpay_signature || signatureLegacy;

    // Build the set of vehicles to mark paid: explicit list from client,
    // else look up everything tied to this Razorpay orderId, else fall back
    // to the legacy single-vehicle field.
    let targetIds: string[] = [];
    if (Array.isArray(vehicleIds) && vehicleIds.length > 0) {
      targetIds = vehicleIds;
    } else if (orderId) {
      const linkedVehicles = await VehicleModel.find({
        driverId: new Types.ObjectId(driverId),
        onboardingOrderId: orderId,
        isDeleted: { $ne: true },
      }).select("_id");
      targetIds = linkedVehicles.map((v) => v._id.toString());
    }
    if (targetIds.length === 0 && vehicleId) {
      targetIds = [vehicleId];
    }

    if (targetIds.length === 0 || !paymentId) {
      req.rCode = 0;
      req.msg = "missing_payment_details";
      return next();
    }

    // Verify the Razorpay signature. With real keys this MUST pass; only in
    // non-production mock mode (no real keys) do we proceed without one.
    const signatureValid = PaymentService.verifyPaymentSignature(
      orderId || "",
      paymentId,
      signature || "",
    );

    if (!signatureValid && !PaymentService.isMockPaymentAllowed()) {
      req.rCode = 0;
      req.msg = "invalid_payment_signature";
      return next();
    }

    // Mark every paid vehicle
    await VehicleModel.updateMany(
      {
        _id: { $in: targetIds.map((v) => new Types.ObjectId(v)) },
        driverId: new Types.ObjectId(driverId),
      },
      {
        onboardingFeePaid: true,
        onboardingPaymentId: paymentId,
        onboardingOrderId: orderId,
        verificationStatus: "under_verification",
      },
    );

    // Also update driver-level flag
    await DriverModel.findByIdAndUpdate(driverId, {
      onboardingFeePaid: true,
      onboardingPaymentId: paymentId,
      status: "under_verification",
    });

    req.rData = {
      status: "under_verification",
      vehicleId: targetIds[0],
      vehicleIds: targetIds,
      paidCount: targetIds.length,
    };
    req.msg = "payment_verified";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// SUPPORT
// =====================

/**
 * Trigger an SOS alert from the driver app. The widget calls this from inside
 * an active trip — bookingId is optional (some panics happen pre-pickup).
 */
export const triggerDriverSOS = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { location, bookingId, address } = req.body || {};

    if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
      req.rCode = 0;
      req.msg = "location_required";
      return next();
    }

    const sosAlert = await SOSService.triggerSOS(
      "DRIVER",
      new Types.ObjectId(driverId),
      { lat: location.lat, lng: location.lng },
      bookingId ? new Types.ObjectId(bookingId) : undefined,
      address,
    );

    req.rData = {
      sosId: sosAlert._id,
      status: sosAlert.status,
    };
    req.msg = "sos_triggered";
    next();
  } catch (error) {
    next(error);
  }
};

export const raiseTicket = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { category, subject, message, description, bookingId, priority } =
      req.body;
    const desc = description || message;

    if (!category || !subject || !desc) {
      req.rCode = 0;
      req.msg = "category_subject_message_required";
      return next();
    }

    // Persist a real ticket via the shared support service (was a fake TKT id).
    const ticket = await SupportService.createTicket({
      driverId: new Types.ObjectId(driverId),
      category,
      subject,
      description: desc,
      priority,
      bookingId: bookingId ? new Types.ObjectId(bookingId) : undefined,
    });

    // Record the opening message on the DRIVER channel so the thread isn't
    // empty when the driver (or admin) opens it. Mirrors the customer flow.
    await SupportService.addMessage({
      ticketId: ticket._id as Types.ObjectId,
      senderId: new Types.ObjectId(driverId),
      senderType: "DRIVER",
      message: desc,
    });

    req.rData = {
      ticketId: ticket.ticketId,
      id: ticket._id,
      status: ticket.status,
    };
    req.msg = "ticket_raised";
    next();
  } catch (error) {
    next(error);
  }
};

export const getTickets = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const tickets = await SupportService.getDriverTickets(
      new Types.ObjectId(driverId),
    );
    req.rData = tickets;
    req.msg = "tickets_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const getTicketDetails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { ticketId } = req.params;

    const ticket = await SupportService.getTicketById(ticketId);
    if (!ticket || String((ticket as any).driverId?._id || (ticket as any).driverId) !== String(driverId)) {
      req.rCode = 0;
      req.msg = "ticket_not_found";
      return next();
    }

    // Only the DRIVER channel is driver-visible. Without this filter the driver
    // would also receive INTERNAL admin notes. Driver messages and admin replies
    // meant for the driver both live on the "DRIVER" channel.
    const messages = await SupportService.getTicketMessages(
      ticket._id as Types.ObjectId,
      "DRIVER",
    );

    req.rData = { ticket, messages };
    req.msg = "ticket_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const replyToTicket = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { ticketId } = req.params;
    const { message } = req.body;

    if (!message) {
      req.rCode = 0;
      req.msg = "message_required";
      return next();
    }

    const ticket = await SupportService.getTicketById(ticketId);
    if (!ticket || String((ticket as any).driverId?._id || (ticket as any).driverId) !== String(driverId)) {
      req.rCode = 0;
      req.msg = "ticket_not_found";
      return next();
    }

    const reply = await SupportService.addMessage({
      ticketId: ticket._id as Types.ObjectId,
      senderId: new Types.ObjectId(driverId),
      senderType: "DRIVER",
      message,
    });

    req.rData = { id: reply._id };
    req.msg = "reply_sent";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// DRIVER INSTRUCTIONS
// =====================

export const getInstructions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const instructions = await DriverInstruction.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .select("_id icon text");

    req.rData = instructions;
    req.msg = "instructions_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const acknowledgeInstructions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    await DriverModel.findByIdAndUpdate(driverId, {
      instructionsAcknowledgedAt: new Date(),
    });

    req.msg = "instructions_acknowledged";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// DAILY CHECKLIST
// =====================

export const getDailyChecklist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const checklist = [
      { _id: "1", label: "Face and T-Shirt Selfie", required: true },
      { _id: "2", label: "Front Side of Car/Bike", required: true },
      { _id: "3", label: "Right Side of Car/Bike", required: true },
      { _id: "4", label: "Left Side of Car/Bike", required: true },
      { _id: "5", label: "Back Side of Car/Bike", required: true },
    ];

    req.rData = checklist;
    req.msg = "checklist_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const submitDailyChecklist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    let images: string[] = [];
    if (Array.isArray(req.files)) {
      for (const file of req.files) {
        const upload = await fileUploadService.uploadFileToAws([file]);
        images.push(upload.images as string);
      }
    }

    await DriverModel.findByIdAndUpdate(driverId, {
      lastChecklistAt: new Date(),
      lastChecklistImages: images,
    });

    req.msg = "checklist_submitted";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// NOTIFICATIONS
// =====================

export const getNotifications = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    // Real driver notifications (was a stub returning []).
    const [items, unreadCount] = await Promise.all([
      Notification.find({ driverId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ driverId, isRead: false }),
    ]);

    req.rData = { notifications: items, unreadCount, page, limit } as any;
    req.msg = "notifications_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

export const markNotificationRead = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { notificationId } = req.params;

    if (notificationId) {
      // Mark one notification read (scoped to this driver).
      await Notification.updateOne(
        { _id: notificationId, driverId },
        { isRead: true, readAt: new Date() },
      );
    } else {
      // No id → mark all this driver's notifications read.
      await Notification.updateMany(
        { driverId, isRead: false },
        { isRead: true, readAt: new Date() },
      );
    }

    req.msg = "notification_read";
    next();
  } catch (error) {
    next(error);
  }
};

export const updateFcmToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { fcmToken } = req.body;

    await DriverModel.findByIdAndUpdate(driverId, { fcmToken });

    req.msg = "fcm_token_updated";
    next();
  } catch (error) {
    next(error);
  }
};

// =====================
// WALLET
// =====================

/**
 * GET DRIVER WALLET - balance + recent transactions
 */
export const getDriverWallet = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const driverObjectId = new Types.ObjectId(driverId);

    const wallet = await WalletService.getWallet(driverObjectId);

    req.rData = wallet;
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * GET DRIVER WALLET TRANSACTIONS (paginated)
 */
export const getDriverWalletTransactions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const driverObjectId = new Types.ObjectId(driverId);
    const { page = 1, limit = 20 } = req.query;

    const result = await WalletService.getTransactions(
      driverObjectId,
      Number(page),
      Number(limit),
    );

    req.rData = result;
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * ADD MONEY TO DRIVER WALLET (recharge)
 */
export const addToDriverWallet = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const driverObjectId = new Types.ObjectId(driverId);
    const { amount, referenceId } = req.body;

    // SECURITY: this endpoint previously credited the wallet with NO payment,
    // letting a driver top up for free. Crediting now requires a verified
    // Razorpay payment via /wallet/recharge (order) + /wallet/recharge/verify.
    void driverObjectId;
    void amount;
    void referenceId;
    req.rCode = 0;
    req.msg = "use_recharge_flow";
    return next();
  } catch (error) {
    next(error);
  }
};

// =====================
// REFERRAL
// =====================

const REFERRAL_CODE_LENGTH = 8;
const REFERRER_REWARD_AMOUNT = 100; // ₹100 for the driver who referred
const REFEREE_REWARD_AMOUNT = 50; // ₹50 for the new driver who was referred

/**
 * Generate a unique referral code for drivers: uppercase alphanumeric, 8 chars
 */
const generateUniqueDriverReferralCode = async (): Promise<string> => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code: string;
  let exists = true;

  while (exists) {
    code = "";
    const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
    for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
      code += chars[bytes[i] % chars.length];
    }
    const existing = await DriverModel.findOne({ referralCode: code });
    exists = !!existing;
  }

  return code!;
};

/**
 * GET /driver/app/referral/stats
 * Get the current driver's referral code and statistics.
 */
export const getDriverReferralStats = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const driverObjectId = new Types.ObjectId(driverId);

    let driver = await DriverModel.findById(driverObjectId).select(
      "referralCode fullName",
    );

    if (!driver) {
      req.rCode = 0;
      req.msg = "driver_not_found";
      return next();
    }

    // Generate referral code if it doesn't exist yet
    if (!driver.referralCode) {
      const code = await generateUniqueDriverReferralCode();
      driver = await DriverModel.findByIdAndUpdate(
        driverObjectId,
        { referralCode: code },
        { new: true },
      ).select("referralCode fullName");
    }

    // Count how many drivers this person has referred
    const referralCount = await DriverModel.countDocuments({
      referredBy: driverObjectId,
      isDeleted: { $ne: true },
    });

    // Total earnings from referral rewards
    const earningsAgg = await RewardTransaction.aggregate([
      {
        $match: {
          userId: driverObjectId,
          type: "REFERRAL",
          status: { $in: ["PENDING", "CREDITED"] },
        },
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: "$amount" },
        },
      },
    ]);

    const totalEarnings =
      earningsAgg.length > 0 ? earningsAgg[0].totalEarnings : 0;

    // Recent referrals list
    const recentReferrals = await DriverModel.find({
      referredBy: driverObjectId,
      isDeleted: { $ne: true },
    })
      .select("fullName mobileNumber createdAt")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    req.rData = {
      referralCode: driver!.referralCode,
      referralCount,
      totalEarnings,
      referrerRewardAmount: REFERRER_REWARD_AMOUNT,
      refereeRewardAmount: REFEREE_REWARD_AMOUNT,
      recentReferrals: recentReferrals.map((r: any) => ({
        name: r.fullName || "New Driver",
        mobile: r.mobileNumber
          ? `${r.mobileNumber.slice(0, 2)}****${r.mobileNumber.slice(-2)}`
          : "",
        joinedAt: r.createdAt,
      })),
    };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * POST /driver/app/referral/apply
 * Apply a referral code to the current driver.
 * Body: { referralCode: string }
 */
export const applyDriverReferralCode = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const driverObjectId = new Types.ObjectId(driverId);
    const { referralCode } = req.body;

    if (!referralCode || typeof referralCode !== "string") {
      req.rCode = 0;
      req.msg = "referral_code_required";
      return next();
    }

    const currentDriver = await DriverModel.findById(driverObjectId);

    if (!currentDriver) {
      req.rCode = 0;
      req.msg = "driver_not_found";
      return next();
    }

    // Already applied a referral code
    if (currentDriver.referredBy) {
      req.rCode = 0;
      req.msg = "referral_already_applied";
      return next();
    }

    // Can't use own referral code
    if (
      currentDriver.referralCode &&
      currentDriver.referralCode.toUpperCase() === referralCode.toUpperCase()
    ) {
      req.rCode = 0;
      req.msg = "cannot_use_own_referral";
      return next();
    }

    // Find the referrer driver by code
    const referrer = await DriverModel.findOne({
      referralCode: referralCode.toUpperCase(),
      isDeleted: { $ne: true },
    });

    if (!referrer) {
      req.rCode = 0;
      req.msg = "invalid_referral_code";
      return next();
    }

    // Mark referral
    await DriverModel.findByIdAndUpdate(driverObjectId, {
      referredBy: referrer._id,
    });

    // Reward the referee (new driver)
    await RewardService.addReferralReward(
      driverObjectId,
      REFEREE_REWARD_AMOUNT,
      referrer._id,
    );

    // Reward the referrer
    await RewardService.addReferralReward(
      referrer._id,
      REFERRER_REWARD_AMOUNT,
      driverObjectId,
    );

    req.rData = {
      referrerName: referrer.fullName || "A Movezy driver",
      rewardAmount: REFEREE_REWARD_AMOUNT,
    };
    req.msg = "referral_applied";
    next();
  } catch (error) {
    next(error);
  }
};
