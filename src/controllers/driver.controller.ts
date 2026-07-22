import { Request, Response, NextFunction } from "express";
import mongoose, { Types } from "mongoose";
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
import { emitToUser } from "../utils/socket.util";
import * as NotificationService from "../services/notification.service";
import * as FareService from "../services/fare.service";
import User from "../models/Users";
import * as RewardService from "../services/reward.service";
import * as WalletService from "../services/wallet.service";
import * as CoinService from "../services/coin.service";
import * as SupportService from "../services/support.service";
import DriverInstruction from "../models/driver-instruction.model";
import Badge from "../models/badge.model";
import TrainingMaterial from "../models/training-material.model";
import { getTrainingGateStatus } from "../services/training-gate.service";
import VehicleTypeModel from "../models/vehicle-type.model";
import DriverKycModel from "../models/driver-kyc.model";
import VehicleModel from "../models/vehicle.model";
import * as PaymentService from "../services/payment.service";
import { Notification } from "../models/notification.model";
import * as IncentiveService from "../services/incentive.service";
import * as SOSService from "../services/sos.service";
import { AppConfig, FareConfig } from "../models/app-config.model";
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
      upcomingCount,
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
            // Every earnings figure a driver sees must agree with what they can
            // actually withdraw. These summed finalFare — the customer's gross,
            // GST and commission included — so the dashboard headline promised
            // ~24% more than the payout screen would ever pay out.
            totalEarnings: { $sum: { $ifNull: ["$driverEarnings", 0] } },
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
            todaysEarnings: { $sum: { $ifNull: ["$driverEarnings", 0] } },
            todaysServices: { $sum: 1 },
          },
        },
      ]),
      BookingModel.countDocuments({
        driverId: driverObjectId,
        status: { $in: ACTIVE_BOOKING_STATUSES },
      }),
      // Scheduled work still ahead of this driver. `upcomingServices` used to
      // be the on-going count under a second name, so the dashboard showed one
      // number twice under two different labels.
      BookingModel.countDocuments({
        driverId: driverObjectId,
        isScheduled: true,
        scheduledAt: { $gt: new Date() },
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
        .populate("vehicleTypeId", "name icon image")
        .sort({ createdAt: -1 })
        .lean(),
      BookingModel.find(pendingFilter)
        .populate("userId", "fullName")
        .populate("vehicleTypeId", "name icon image")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      BookingModel.find({
        driverId: driverObjectId,
        status: "COMPLETED",
      })
        .populate("userId", "fullName")
        .populate("vehicleTypeId", "name icon image")
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
            amount: { $sum: { $ifNull: ["$driverEarnings", 0] } },
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

    const trainingGate = await getTrainingGateStatus(driverId);

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

    // The rate the settlement will actually charge, read once for every
    // booking mapped below.
    const dashFareConfig = await FareConfig.findOne({ isActive: true })
      .select("driverCommissionPercent")
      .lean();
    const commissionPercent = Number(
      (dashFareConfig as any)?.driverCommissionPercent ?? 20,
    );

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
      // Surfaced so the driver app can explain where the estimate comes from
      // instead of presenting a net figure with no visible derivation.
      commissionPercent,
      stats: {
        totalEarnings: Number(lifetime.totalEarnings || 0),
        totalServices: Number(lifetime.totalServices || 0),
        upcomingServices: Number(upcomingCount || 0),
        todaysServices: Number(today.todaysServices || 0),
        todaysEarnings: Number(today.todaysEarnings || 0),
        onGoingCount: Number(onGoingCount || 0),
        pendingCount: Number(pendingCount || 0),
        completedCount: Number(completedCount || 0),
        monthlyRevenue: revenueTrend,
      },
      bookings: {
        current: currentBooking
          ? mapDashboardBooking(currentBooking, commissionPercent)
          : null,
        pending: pendingBookings.map((booking) =>
          mapDashboardBooking(booking, commissionPercent),
        ),
        completed: completedBookings.map((booking) =>
          mapDashboardBooking(booking, commissionPercent),
        ),
      },
      // Lets the home screen show the "complete training to start earning" card
      // and pre-empt the go-online block, rather than only discovering the gate
      // when the toggle is rejected.
      training: {
        required: trainingGate.required,
        complete: trainingGate.complete,
        totalRequired: trainingGate.totalRequired,
        completedRequired: trainingGate.completedRequired,
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
          totalEarnings: { $sum: { $ifNull: ["$driverEarnings", 0] } },
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
      .populate("vehicleTypeId", "name icon image")
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
      // Never ship OTPs to the driver — history includes the ACTIVE booking.
      .select("-otp -deliveryOtp")
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
      .populate("vehicleTypeId", "name icon image")
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
      .populate("vehicleTypeId", "name icon image")
      .lean();

    // Use the configured commission, not the mapper's default 20 — otherwise
    // the earnings shown right after accepting can differ from the dashboard's.
    const acceptFareConfig = await FareConfig.findOne({ isActive: true })
      .select("driverCommissionPercent")
      .lean();
    const acceptCommission = Number(
      (acceptFareConfig as any)?.driverCommissionPercent ?? 20,
    );

    // Put the job in the driver's inbox.
    //
    // Dispatch only ever sent a raw FCM push (sendPushNotification writes no
    // Notification document), so a driver could run a dozen trips and find an
    // empty notifications page. The offer itself stays transient — it goes to
    // every nearby driver and dies in 30s, so persisting that would fill the
    // inbox with expired offers — but the job you actually WON belongs there.
    if (booking) {
      const pickupAddr = String((booking as any)?.pickup?.address || "").slice(
        0,
        60,
      );
      await NotificationService.sendToDriver(
        new Types.ObjectId(String(driverId)),
        "BOOKING",
        "Booking assigned",
        pickupAddr
          ? `Pickup: ${pickupAddr}`
          : `Booking ${(booking as any).bookingNumber || ""} is yours.`,
        { bookingId: String(bookingId) },
        booking._id as Types.ObjectId,
        "Booking",
      ).catch((e) =>
        // Never fail an accepted booking over its notification.
        console.error("accept notification failed", e),
      );
    }

    req.rData = booking
      ? mapDashboardBooking(booking, acceptCommission)
      : null;
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

    // Sockets join `user:<id>` (socket.util), so the old `user_<id>` room was
    // empty and this event reached nobody.
    emitToUser(String(booking.userId), "driver_arrived", booking);

    await NotificationService.sendBookingStatusNotification(
      booking.userId as Types.ObjectId,
      booking._id as Types.ObjectId,
      "DRIVER_ARRIVED",
    ).catch(() => null);

    req.rData = scrubOtps((booking as any).toObject?.() ?? booking);
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

    // ─── WAITING CHARGE ───
    // How long the driver waited at pickup: driverArrivedAt → pickedAt. This is
    // the only point where both timestamps exist, and it is before payment is
    // captured (the Razorpay order is created from the current finalFare, and
    // cash is collected at completion), so the customer is quoted the right
    // amount. Previously waitingMinutes stayed 0 and drivers were never paid.
    if (booking.driverArrivedAt) {
      const waitedMs = booking.pickedAt.getTime() - booking.driverArrivedAt.getTime();
      const waitingMinutes = Math.max(0, Math.floor(waitedMs / 60000));
      const waitingCharge = await FareService.calculateWaitingCharges(waitingMinutes);

      booking.waitingMinutes = waitingMinutes;
      booking.waitingCharge = waitingCharge;

      // Never retro-bill a booking that is already settled — that would need a
      // separate top-up/refund flow rather than a silent fare change.
      if (waitingCharge > 0 && booking.paymentStatus !== "PAID") {
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const gstPercentage = booking.gstPercentage || 5;

        booking.subtotal = round2((booking.subtotal || 0) + waitingCharge);
        booking.gstAmount = round2((booking.subtotal * gstPercentage) / 100);
        booking.finalFare = round2(
          Math.max(
            0,
            booking.subtotal + booking.gstAmount - (booking.totalDiscount || 0),
          ),
        );
        // `fare` mirrors finalFare at creation; keep them in step.
        booking.fare = booking.finalFare;
      }
    }

    await booking.save();

    emitToUser(String(booking.userId), "booking:picked", booking);

    await NotificationService.sendBookingStatusNotification(
      booking.userId as Types.ObjectId,
      booking._id as Types.ObjectId,
      "PICKED",
    ).catch(() => null);

    // Consignee notice: SMS the parcel's receiver that it is on its way. They
    // are not an app user, so SMS is the only channel that reaches them.
    await NotificationService.notifyConsigneePickup(booking).catch(() => null);

    req.rData = scrubOtps((booking as any).toObject?.() ?? booking);
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

    emitToUser(String(booking.userId), "trip_started", booking);

    await NotificationService.sendBookingStatusNotification(
      booking.userId as Types.ObjectId,
      booking._id as Types.ObjectId,
      "IN_PROGRESS",
    ).catch(() => null);

    req.rData = scrubOtps((booking as any).toObject?.() ?? booking);
    req.msg = "trip_started";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Mark one intermediate stop delivered.
 *
 * Multi-drop rides had no per-stop state: the driver had a single COMPLETE
 * for the whole trip and nothing tracked which drops were done. Stops must be
 * completed in order — the route was priced through them in sequence.
 */
export const completeStop = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId, stopIndex } = req.params;

    const booking = await BookingModel.findOne({
      _id: bookingId,
      driverId: new Types.ObjectId(driverId),
      // PICKED covers drivers who head to the first stop before tapping
      // "start trip"; both states mean the goods are on board.
      status: { $in: ["PICKED", "IN_PROGRESS"] },
    });

    if (!booking) {
      req.rCode = 0;
      req.msg = "invalid_booking";
      return next();
    }

    const idx = Number(stopIndex);
    const stops: any[] = (booking.stops as any[]) || [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= stops.length) {
      req.rCode = 0;
      req.msg = "invalid_stop";
      return next();
    }
    if (stops[idx].completedAt) {
      req.rCode = 0;
      req.msg = "stop_already_completed";
      return next();
    }
    // In order: every earlier stop must already be done.
    if (stops.slice(0, idx).some((s) => !s.completedAt)) {
      req.rCode = 0;
      req.msg = "complete_previous_stops_first";
      return next();
    }

    stops[idx].completedAt = new Date();
    booking.markModified("stops");
    await booking.save();

    // Let the customer's tracking screen tick the drop off live.
    emitToUser(String(booking.userId), "booking:stop_completed", {
      bookingId: String(booking._id),
      stopIndex: idx,
      completedAt: stops[idx].completedAt,
    });

    req.rData = {
      stopIndex: idx,
      completedAt: stops[idx].completedAt,
      remainingStops: stops.filter((s) => !s.completedAt).length,
    };
    req.msg = "stop_completed";
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

    // Every intermediate drop must be marked delivered before the final one —
    // otherwise COMPLETE quietly closes a ride whose middle drops nobody
    // confirmed. Only bites when stops exist, so plain A→B rides are untouched.
    const openStops = ((booking.stops as any[]) || []).filter(
      (s) => !s.completedAt,
    ).length;
    if (openStops > 0) {
      req.rCode = 0;
      req.msg = "complete_stops_first";
      req.rData = { remainingStops: openStops };
      return next();
    }

    // Delivery OTP gate: the receiver reads their code out at the drop. Only
    // enforced when the booking has one — bookings created before the field
    // existed complete exactly as before.
    if (booking.deliveryOtp) {
      const suppliedOtp = String(req.body?.otp ?? "");
      if (suppliedOtp !== booking.deliveryOtp) {
        req.rCode = 0;
        req.msg = "invalid_delivery_otp";
        return next();
      }
    }

    booking.status = "COMPLETED";
    booking.completedAt = new Date();

    // Freeze the driver's settlement for this trip.
    //
    // Payouts used to derive earnings as Σ finalFare. finalFare includes the
    // customer's GST, so drivers could withdraw tax the platform owes the
    // government, and no commission was ever taken. Earnings are computed from
    // the pre-GST subtotal and stored per booking, so a later rate change can
    // never silently rewrite what a driver already earned.
    //
    // Commission is charged on the full subtotal, not on the discounted total:
    // promo and coin discounts are Movezy's marketing cost, and the driver did
    // the same trip either way.
    const settlementConfig = await FareConfig.findOne({ isActive: true });
    const commissionPercent = settlementConfig?.driverCommissionPercent ?? 20;
    const settlementBase = booking.subtotal ?? 0;
    const commissionAmount =
      Math.round(((settlementBase * commissionPercent) / 100) * 100) / 100;
    booking.commissionPercent = commissionPercent;
    booking.commissionAmount = commissionAmount;
    booking.driverEarnings =
      Math.round((settlementBase - commissionAmount) * 100) / 100;

    await booking.save();

    // This trip may have completed a daily/weekly/peak target. Awarding writes
    // a ledger row the payout balance includes — the app has always shown
    // "Incentives Unlocked" and "Total (Earnings + Bonus)", but nothing ever
    // credited the bonus. Never fail a completed trip over a bonus.
    try {
      await IncentiveService.awardEarnedIncentives(String(driverId));
    } catch (e) {
      console.error("awardEarnedIncentives failed", e);
    }

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
        // Record it on the booking too. The coins were credited but this was
        // never set, so the trip/completion screens — which only show the
        // "+N coins earned" banner when coinsEarned > 0 — never displayed it.
        booking.coinsEarned = coinsEarned;
        await booking.save();
      }
    } catch (coinError) {
      // Don't fail the trip completion if coin crediting fails
      console.error("Coin crediting error:", coinError);
    }

    emitToUser(String(booking.userId), "trip_completed", booking);

    await NotificationService.sendBookingStatusNotification(
      booking.userId as Types.ObjectId,
      booking._id as Types.ObjectId,
      "COMPLETED",
    ).catch(() => null);

    // The customer is told the trip finished; the driver never was — and
    // nothing in the app ever told them what they earned, despite the
    // settlement being frozen right above. PAYMENT type, so it reads as money
    // rather than another job alert.
    await NotificationService.sendToDriver(
      new Types.ObjectId(String(driverId)),
      "PAYMENT",
      "Trip completed",
      `₹${(booking.driverEarnings ?? 0).toFixed(2)} added to your earnings for booking ${booking.bookingNumber || ""}.`.trim(),
      { bookingId: String(booking._id) },
      booking._id as Types.ObjectId,
      "Booking",
    ).catch((e) => console.error("completion notification failed", e));

    req.rData = scrubOtps((booking as any).toObject?.() ?? booking);
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

    const booking = await BookingModel.findOne({
      _id: bookingId,
      driverId: new Types.ObjectId(driverId),
      status: "COMPLETED",
    });

    if (!booking) {
      req.rCode = 0;
      req.msg = "invalid_booking";
      return next();
    }

    // Guard against marking a prepaid trip PAID-by-cash. Cash collection is only
    // valid for a COD booking that hasn't already been settled online/by wallet;
    // otherwise this would overwrite a real Razorpay payment and imply the driver
    // took cash for a trip the customer already paid for.
    if (booking.paymentMethod !== "CASH") {
      req.rCode = 0;
      req.msg = "not_a_cash_booking";
      return next();
    }
    if (booking.paymentStatus === "PAID") {
      // Already settled — treat as a no-op success so a retry doesn't error.
      req.rData = scrubOtps((booking as any).toObject?.() ?? booking);
      req.msg = "cash_collected";
      return next();
    }

    booking.paymentStatus = "PAID";
    await booking.save();

    req.rData = scrubOtps((booking as any).toObject?.() ?? booking);
    req.msg = "cash_collected";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Driver cancels an assigned booking (e.g. customer unreachable, wrong address).
 *
 * The state model always allowed this (cancelledBy has a DRIVER value) but there
 * was no endpoint and no button, so a driver stuck with an unreachable customer
 * could only fake-complete the trip — and the active booking blocked all new work.
 *
 * Only before pickup: once goods are aboard (PICKED/IN_PROGRESS) cancelling is a
 * support case, not a self-serve action. The booking returns to the pool rather
 * than being killed, so the customer keeps their ride.
 */
export const cancelBookingByDriver = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;
    const { reason } = req.body as { reason?: string };

    const booking = await BookingModel.findOne({
      _id: bookingId,
      driverId: new Types.ObjectId(driverId),
      status: { $in: ["ASSIGNED", "DRIVER_ARRIVED"] },
    });

    if (!booking) {
      req.rCode = 0;
      req.msg = "invalid_booking";
      return next();
    }

    // Release the driver and put the booking back out to search.
    booking.status = "SEARCHING";
    booking.driverId = undefined;
    booking.assignedAt = undefined;
    booking.driverArrivedAt = undefined;
    await booking.save();

    await DriverModel.findByIdAndUpdate(driverId, { currentBookingId: null });

    // Tell the customer their driver dropped off and we're re-searching.
    emitToUser(String(booking.userId), "booking:status", {
      bookingId: String(booking._id),
      status: "SEARCHING",
      message: "Your driver cancelled. We're finding you another driver.",
    });
    await NotificationService.sendToUser(
      booking.userId as Types.ObjectId,
      "BOOKING",
      "Finding a new driver",
      "Your driver had to cancel. We're assigning someone else.",
      { bookingId: String(booking._id) },
    ).catch(() => null);

    // Re-dispatch to other nearby drivers. Non-fatal: the booking is already
    // SEARCHING, so it stays discoverable even if this throws.
    BookingDispatchService.dispatchBookingToDrivers(String(booking._id)).catch(
      (err: any) =>
        console.error("Driver cancel: re-dispatch failed", err?.message || err),
    );

    console.log(
      `Booking ${booking.bookingNumber} cancelled by driver ${driverId}: ${reason || "no reason"}`,
    );

    req.rData = scrubOtps((booking as any).toObject?.() ?? booking);
    req.msg = "booking_cancelled";
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
      // Never expose the pickup OTP to the driver — the customer reads it out at
      // pickup. Without this projection the raw booking leaked it here, undoing
      // its deliberate removal from the dashboard payload (mapDashboardBooking)
      // and letting a driver self-verify pickup without meeting the customer.
      .select("-otp")
      .populate("userId", "fullName mobileNumber")
      .populate("vehicleTypeId", "name")
      .lean();

    if (!booking) {
      req.rCode = 0;
      req.msg = "booking_not_found";
      return next();
    }

    // Tell the driver whether a delivery OTP gate exists — but never the code
    // itself, for the same reason the pickup OTP is stripped above.
    (booking as any).deliveryOtpRequired = Boolean((booking as any).deliveryOtp);
    delete (booking as any).deliveryOtp;

    req.rData = scrubOtps((booking as any).toObject?.() ?? booking);
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

      // Training gate: block going online until mandatory training is done.
      // Inert unless an admin has marked a program mandatory, so it never
      // surprises an existing fleet. Only gates going ONLINE — a driver can
      // always go offline.
      const gate = await getTrainingGateStatus(driverId);
      if (gate.required && !gate.complete) {
        req.rCode = 4;
        req.msg = "training_incomplete";
        req.rData = {
          isOnline: false,
          status: driver.status,
          trainingRequired: true,
          trainingComplete: false,
          completedRequired: gate.completedRequired,
          totalRequired: gate.totalRequired,
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
      vehicleTypeId,
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

    // Which catalog vehicle is this? Dispatch matches bookings on a specific
    // VehicleType, so a vehicle added without one could never be sent a job —
    // this route only ever stored the broad "2W"/"3W" category, which is why
    // vehicles added in-app never received bookings.
    let catalogTypeId: Types.ObjectId | undefined;
    if (vehicleTypeId && Types.ObjectId.isValid(String(vehicleTypeId))) {
      const catalogType = await VehicleTypeModel.findOne({
        _id: new Types.ObjectId(String(vehicleTypeId)),
        isActive: true,
      }).select("_id");
      if (!catalogType) {
        req.rCode = 0;
        req.msg = "invalid_vehicle_type";
        return next();
      }
      catalogTypeId = catalogType._id as Types.ObjectId;
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
      vehicleTypeId: catalogTypeId,
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

/**
 * Strip both OTPs from any booking object about to be sent to a DRIVER.
 *
 * The pickup OTP is the customer's proof-of-presence and the delivery OTP the
 * receiver's — a driver holding either can self-verify without meeting anyone.
 * getBookingDetails and mapDashboardBooking already strip them, but the
 * lifecycle handlers (arrive/verify/start/complete/cancel/history) returned
 * raw booking docs and leaked both codes right back.
 */
function scrubOtps<T>(booking: T): T {
  if (booking && typeof booking === "object") {
    // Idempotent: an already-scrubbed object (getBookingDetails strips the
    // code itself) must keep its true flag, not have it recomputed to false
    // from the deleted field.
    (booking as any).deliveryOtpRequired =
      Boolean((booking as any).deliveryOtp) ||
      (booking as any).deliveryOtpRequired === true;
    delete (booking as any).otp;
    delete (booking as any).deliveryOtp;
  }
  return booking;
}

function mapDashboardBooking(booking: any, commissionPercent = 20) {
  // What this trip is actually worth to the driver, using the same formula the
  // settlement freezes at completion (subtotal - commission, pre-GST). Sent as
  // a distinct field so no client is tempted to label finalFare "earnings".
  const settlementBase = Number(booking?.subtotal ?? 0);
  const estimatedEarnings =
    settlementBase > 0
      ? Math.round((settlementBase * (100 - commissionPercent)) / 100 * 100) /
        100
      : 0;

  return {
    // Frozen once completed; before that, the estimate above.
    estimatedEarnings: Number(booking?.driverEarnings ?? estimatedEarnings),
    commissionPercent,
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
    // Intermediate drops, in delivery order. These were stripped here even
    // though the fare bills per stop — so the offer screen showed a multi-drop
    // ride as a plain A→B trip and the driver found out en route.
    stops: (Array.isArray(booking?.stops) ? booking.stops : []).map(
      (s: any) => ({
        address: s?.address || "",
        lat: Number(s?.lat || 0),
        lng: Number(s?.lng || 0),
        contactName: s?.contactName || "",
        contactPhone: s?.contactPhone || "",
        floor: s?.floor ?? null,
        completedAt: s?.completedAt ?? null,
      }),
    ),
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
    // The pickup OTP is deliberately NOT sent to the driver: the customer reads
    // it out at pickup and the driver submits it to verifyPickupOtp. Including
    // it here would let a driver verify pickup without ever meeting the customer.
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
    const { lessonId } = req.params;

    // Store the plain material id. This used to store `${moduleId}_${lessonId}`,
    // but materials are flat (no module/lesson hierarchy) and the app sends the
    // same materialId for both params, so every stored key was the degenerate
    // `${id}_${id}`. The plain id is what the training gate and progress count
    // match against; the gate still normalises the legacy composite for drivers
    // who completed training on older builds.
    await DriverModel.findByIdAndUpdate(driverId, {
      $addToSet: { completedLessons: lessonId },
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

    // Count the material that actually exists. This was `const totalLessons = 16`
    // — a number unrelated to the catalog, which currently holds 1 active
    // material. A driver who finished everything saw 6% and could never reach
    // 100%, so any gate keyed on this percentage would stay shut forever.
    const totalLessons = await TrainingMaterial.countDocuments({
      isActive: true,
    });

    // Dedupe by normalised material id (a material may appear both as the plain
    // id and as the legacy `${id}_${id}` composite), then cap at the
    // denominator — completedLessons is an unvalidated string bag that also
    // retains entries for material since deleted/deactivated, so it can
    // otherwise report >100%.
    const normalised = new Set(
      (driver?.completedLessons || []).map((e) => String(e).split("_")[0]),
    );
    const completedCount = Math.min(normalised.size, totalLessons);

    req.rData = {
      completedLessons: completedCount,
      totalLessons,
      // An empty catalog is vacuously complete, and must not divide by zero.
      progressPercentage:
        totalLessons === 0
          ? 100
          : Math.round((completedCount / totalLessons) * 100),
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

    // Check KYC status. This read `DriverModel...select("kyc").kyc.isVerified`,
    // but Driver has no `kyc` path — KYC lives in its own DriverKyc document. So
    // isKycVerified was always false and the badge showed "Complete KYC to
    // unlock" forever, even for a fully verified driver.
    const kycDoc = await DriverKycModel.findOne({ driverId: driverObjectId })
      .select("isVerified")
      .lean();
    const isKycVerified = (kycDoc as any)?.isVerified === true;

    // Stats for the wider catalog — every figure below is real driver data.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const badgeFareConfig = await FareConfig.findOne({ isActive: true })
      .select("peakHourStart peakHourEnd")
      .lean();
    const peakStart = Number((badgeFareConfig as any)?.peakHourStart ?? 8);
    const peakEnd = Number((badgeFareConfig as any)?.peakHourEnd ?? 11);

    const [
      earningsAgg,
      longHaulCount,
      activeDaysAgg,
      onTimeCount,
      peakCount,
      sosCount,
      referralCount,
      feedbackCount,
      trainingStatus,
    ] = await Promise.all([
      // Lifetime settled earnings + best calendar month, in one pass.
      BookingModel.aggregate([
        { $match: { driverId: driverObjectId, status: "COMPLETED" } },
        {
          $group: {
            _id: {
              year: { $year: "$completedAt" },
              month: { $month: "$completedAt" },
            },
            monthEarnings: { $sum: { $ifNull: ["$driverEarnings", 0] } },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$monthEarnings" },
            bestMonth: { $max: "$monthEarnings" },
          },
        },
      ]),
      // Long-haul: completed trips of 25 km or more.
      BookingModel.countDocuments({
        driverId: driverObjectId,
        status: "COMPLETED",
        distanceKm: { $gte: 25 },
      }),
      // Distinct days with a completed trip in the last 7 days.
      BookingModel.aggregate([
        {
          $match: {
            driverId: driverObjectId,
            status: "COMPLETED",
            completedAt: { $gte: sevenDaysAgo },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$completedAt" },
            },
          },
        },
        { $count: "days" },
      ]),
      // Scheduled pickups reached within 15 minutes of the slot.
      BookingModel.countDocuments({
        driverId: driverObjectId,
        status: "COMPLETED",
        isScheduled: true,
        scheduledAt: { $ne: null },
        pickedAt: { $ne: null },
        $expr: {
          $lte: [
            "$pickedAt",
            { $add: ["$scheduledAt", 15 * 60 * 1000] },
          ],
        },
      }),
      // Trips completed inside the configured peak-hour window.
      BookingModel.countDocuments({
        driverId: driverObjectId,
        status: "COMPLETED",
        $expr: {
          $and: [
            { $gte: [{ $hour: "$completedAt" }, peakStart] },
            { $lt: [{ $hour: "$completedAt" }, peakEnd] },
          ],
        },
      }),
      // SOS incidents involving this driver.
      mongoose.connection
        .collection("sosalerts")
        .countDocuments({ driverId: driverObjectId })
        .catch(() => 0),
      // Drivers who joined with this driver's referral.
      DriverModel.countDocuments({ referredBy: driverObjectId }),
      // Support tickets / feedback this driver has raised.
      mongoose.connection
        .collection("supporttickets")
        .countDocuments({ driverId: driverObjectId })
        .catch(() => 0),
      getTrainingGateStatus(String(driverId)).catch(() => null),
    ]);

    const totalEarnings = Number(earningsAgg[0]?.total || 0);
    const bestMonthEarnings = Number(earningsAgg[0]?.bestMonth || 0);
    const activeDays = Number(activeDaysAgg[0]?.days || 0);
    const trainingComplete = (trainingStatus as any)?.complete === true;

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
          case "training_completed":
            isUnlocked = trainingComplete;
            progress = trainingComplete ? 1 : 0;
            progressTarget = 1;
            progressLabel = trainingComplete
              ? "Ready for Orders!"
              : "Finish required training to unlock";
            break;
          case "earnings":
            isUnlocked = totalEarnings >= badge.unlockValue;
            progress = Math.min(totalEarnings, badge.unlockValue);
            progressLabel = `₹${Math.round(totalEarnings).toLocaleString(
              "en-IN",
            )} earned`;
            break;
          case "monthly_earnings":
            isUnlocked = bestMonthEarnings >= badge.unlockValue;
            progress = Math.min(bestMonthEarnings, badge.unlockValue);
            progressLabel = `Best month: ₹${Math.round(
              bestMonthEarnings,
            ).toLocaleString("en-IN")}`;
            break;
          case "long_distance":
            isUnlocked = longHaulCount >= badge.unlockValue;
            progress = Math.min(longHaulCount, badge.unlockValue);
            progressLabel = `${longHaulCount} long-haul trips (25km+)`;
            break;
          case "consistency":
            isUnlocked = activeDays >= badge.unlockValue;
            progress = Math.min(activeDays, badge.unlockValue);
            progressLabel = `Active ${activeDays} of last 7 days`;
            break;
          case "on_time":
            isUnlocked = onTimeCount >= badge.unlockValue;
            progress = Math.min(onTimeCount, badge.unlockValue);
            progressLabel = `${onTimeCount} on-time scheduled pickups`;
            break;
          case "peak_hours":
            isUnlocked = peakCount >= badge.unlockValue;
            progress = Math.min(peakCount, badge.unlockValue);
            progressLabel = `${peakCount} peak-hour trips`;
            break;
          case "safety":
            // Real record: enough trips, no cancellations, no SOS incidents.
            isUnlocked =
              totalTrips >= badge.unlockValue &&
              cancelledCount === 0 &&
              Number(sosCount) === 0;
            progress = Math.min(totalTrips, badge.unlockValue);
            progressLabel =
              Number(sosCount) === 0 && cancelledCount === 0
                ? `${totalTrips}/${badge.unlockValue} incident-free trips`
                : "Incident on record";
            break;
          case "feedback":
            isUnlocked = Number(feedbackCount) >= badge.unlockValue;
            progress = Math.min(Number(feedbackCount), badge.unlockValue);
            progressLabel = `${feedbackCount} feedback shared`;
            break;
          case "referrals":
            isUnlocked = referralCount >= badge.unlockValue;
            progress = Math.min(referralCount, badge.unlockValue);
            progressLabel = `${referralCount} drivers referred`;
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

/**
 * Reviews customers have left for this driver.
 *
 * The design shows a reviews list on the driver's home screen, but there was no
 * way to read one: ratings are written onto the booking by rateBooking and were
 * never surfaced back to the driver at all. No new collection is needed — the
 * ratings already exist, they were just invisible.
 */
export const getDriverReviews = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = new Types.ObjectId((req as any).driverId);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    const match = {
      driverId,
      status: "COMPLETED",
      rating: { $exists: true, $ne: null, $gt: 0 },
    };

    const [rows, total, summaryAgg, breakdownAgg] = await Promise.all([
      BookingModel.find(match)
        .sort({ completedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("bookingNumber rating review feedback completedAt userId")
        .populate("userId", "fullName profileImage")
        .lean(),
      BookingModel.countDocuments(match),
      BookingModel.aggregate([
        { $match: match },
        { $group: { _id: null, average: { $avg: "$rating" }, count: { $sum: 1 } } },
      ]),
      // Star distribution, for the ratings bar chart in the design.
      BookingModel.aggregate([
        { $match: match },
        { $group: { _id: "$rating", n: { $sum: 1 } } },
      ]),
    ]);

    const breakdown: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const b of breakdownAgg as any[]) {
      const k = String(Math.round(b._id));
      if (breakdown[k] !== undefined) breakdown[k] = b.n;
    }

    req.rData = {
      reviews: (rows as any[]).map((b) => ({
        id: String(b._id),
        bookingNumber: b.bookingNumber,
        rating: b.rating,
        // rateBooking stores the written text in `review` and tag chips in
        // `feedback`; older rows only have one of them.
        comment: b.review || b.feedback || "",
        customerName: (b.userId as any)?.fullName || "Customer",
        customerPhoto: (b.userId as any)?.profileImage || "",
        ratedAt: b.completedAt ?? null,
      })),
      summary: {
        average:
          Math.round(((summaryAgg as any[])[0]?.average ?? 0) * 10) / 10,
        count: (summaryAgg as any[])[0]?.count ?? 0,
        breakdown,
      },
      page,
      limit,
      total,
    } as any;
    req.msg = "reviews_fetched";
    next();
  } catch (error) {
    next(error);
  }
};

/** Bonuses this driver has actually been awarded and is owed. */
export const getIncentiveHistory = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const items = await IncentiveService.getDriverIncentiveHistory(driverId);
    req.rData = {
      items,
      total: items.reduce((sum: number, i: any) => sum + (i.amount ?? 0), 0),
    } as any;
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

    // Also update driver-level flag. An already-onboarded driver adding another
    // vehicle must KEEP their active status: the new vehicle's own
    // verificationStatus (set above) is what admin reviews. Demoting the driver
    // here used to strand them on the onboarding VerificationScreen, which only
    // exits on active/approved — locking them out of the dashboard entirely.
    const driverDoc = await DriverModel.findById(driverId).select("status");
    const alreadyOnboarded = ["active", "approved"].includes(
      driverDoc?.status ?? "",
    );

    await DriverModel.findByIdAndUpdate(driverId, {
      onboardingFeePaid: true,
      onboardingPaymentId: paymentId,
      ...(alreadyOnboarded ? {} : { status: "under_verification" }),
    });

    req.rData = {
      status: alreadyOnboarded
        ? driverDoc?.status
        : "under_verification",
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
