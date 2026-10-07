import { Request, Response } from "express";
import Booking from "../../models/booking.model";
import User from "../../models/Users";
import Driver from "../../models/driver.model";
import { Types } from "mongoose";
import {
  emitBookingUpdate,
  emitToUser,
} from "../../utils/socket.util";
import * as notificationService from "../../services/notification.service";
import * as mqttUtil from "../../utils/mqtt.util";
import * as bookingDispatchService from "../../services/booking-dispatch.service";
import { runAutoAssignSweep } from "../../services/auto-assign.service";
import * as PaymentService from "../../services/payment.service";
import * as EnterpriseService from "../../services/enterprise.service";

/**
 * Get all bookings with filters
 */
export const getAllBookings = async (req: Request, res: Response) => {
  const {
    status,
    paymentStatus,
    serviceType,
    dateFrom,
    dateTo,
    search,
    page = 0,
    limit = 20,
  } = req.query;

  const query: any = {};

  if (status) query.status = status;
  if (paymentStatus) query.paymentStatus = paymentStatus;
  if (serviceType) query.serviceType = serviceType;

  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom as string);
    if (dateTo) query.createdAt.$lte = new Date(dateTo as string);
  }

  if (search) {
    query.$or = [
      { bookingNumber: { $regex: search, $options: "i" } },
      { "pickup.address": { $regex: search, $options: "i" } },
      { "drop.address": { $regex: search, $options: "i" } },
    ];
  }

  const bookings = await Booking.find(query)
    .populate("userId", "fullName mobileNumber")
    .populate("driverId", "fullName mobileNumber profilePhoto")
    .populate("vehicleTypeId", "name")
    .sort({ createdAt: -1 })
    .skip(Number(page) * Number(limit))
    .limit(Number(limit));

  const total = await Booking.countDocuments(query);

  res.locals.data = {
    bookings,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / Number(limit)),
  };
};

/**
 * Get booking by ID
 */
export const getBookingById = async (req: Request, res: Response) => {
  const { id } = req.params;

  const booking = await Booking.findById(id)
    .populate("userId", "fullName mobileNumber email profileImage")
    .populate("driverId", "fullName mobileNumber email rating")
    .populate("vehicleTypeId")
    .populate("promoCodeId")
    .populate("invoiceId");

  if (!booking) {
    return res.status(404).json({
      success: false,
      message: "Booking not found",
    });
  }

  res.locals.data = { booking };
};

/**
 * Cancel booking (Admin)
 */
export const cancelBooking = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason, refundAmount } = req.body;

  const booking = await Booking.findById(id);

  if (!booking) {
    return res.status(404).json({
      success: false,
      message: "Booking not found",
    });
  }

  if (["COMPLETED", "CANCELLED"].includes(booking.status)) {
    return res.status(400).json({
      success: false,
      message: "Cannot cancel this booking",
    });
  }

  const wasSearching = booking.status === "SEARCHING";
  const driverIdStr = booking.driverId ? String(booking.driverId) : null;
  const userIdStr = String(booking.userId);
  const bookingIdStr = String(booking._id);

  booking.status = "CANCELLED";
  // Was "SYSTEM", which is what an automatic cancellation records — an admin's
  // decision was indistinguishable from no-driver-found after the fact.
  booking.cancelledBy = "ADMIN";
  booking.cancellationReason = reason || "Cancelled by admin";
  booking.cancelledAt = new Date();
  booking.refundAmount = refundAmount || 0;
  booking.refundStatus = refundAmount > 0 ? "PENDING" : "NONE";

  await booking.save();

  // Return the enterprise credit this booking consumed — usedCredit was never
  // decremented anywhere, so an enterprise's utilisation only went up. If the
  // admin named a partial refund, release exactly that much and leave the rest
  // charged; an admin cancelling with no refund figure is treated as a
  // platform-side cancellation, so the enterprise is made whole.
  await EnterpriseService.releaseCreditForBooking(
    booking,
    `Credit released — booking ${booking.bookingNumber} cancelled by admin`,
    Number(refundAmount) > 0 ? Number(refundAmount) : undefined,
  );

  // Real-time propagation to user & driver apps
  try {
    emitBookingUpdate(bookingIdStr, userIdStr, driverIdStr, "CANCELLED", {
      reason: booking.cancellationReason,
      cancelledBy: "ADMIN",
      refundAmount: booking.refundAmount,
    });

    if (driverIdStr) {
      emitToUser(driverIdStr, "booking:cancelled", {
        bookingId: bookingIdStr,
        reason: booking.cancellationReason,
        cancelledBy: "ADMIN",
      });
      await mqttUtil.sendBookingCancelledToDriver(
        driverIdStr,
        bookingIdStr,
        booking.cancellationReason ?? "Cancelled by admin",
      );
    }

    // Clear any ongoing dispatch if booking was still searching
    if (wasSearching) {
      await bookingDispatchService.cancelBookingDispatch(bookingIdStr);
    }

    // Push notifications
    await notificationService
      .sendBookingStatusNotification(
        new Types.ObjectId(userIdStr),
        booking._id as Types.ObjectId,
        "CANCELLED",
      )
      .catch(() => null);

    if (driverIdStr) {
      await notificationService
        .sendToDriver(
          new Types.ObjectId(driverIdStr),
          "BOOKING",
          "Booking Cancelled",
          "A booking assigned to you has been cancelled by admin.",
          { bookingId: bookingIdStr, reason: String(booking.cancellationReason ?? "") },
          booking._id as Types.ObjectId,
          "Booking",
        )
        .catch(() => null);
    }
  } catch (err) {
    console.error("Admin cancel: propagation error", err);
  }

  res.locals.data = {
    message: "Booking cancelled successfully",
    booking,
  };
};

/**
 * Process refund
 */
export const processRefund = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { amount, reason } = req.body;

  const booking = await Booking.findById(id);

  if (!booking) {
    return res.status(404).json({
      success: false,
      message: "Booking not found",
    });
  }

  if (booking.refundStatus === "PROCESSED") {
    return res.status(400).json({
      success: false,
      message: "Refund already processed",
    });
  }

  // Process the refund through the real payment gateway. Refuses (no fake
  // success) in production without keys; uses mock only in non-production.
  const gatewayResult = await PaymentService.processRefund(
    booking._id as Types.ObjectId,
    amount,
    reason || "Admin refund",
  );

  if (!gatewayResult.success) {
    return res.status(502).json({
      success: false,
      message: `Gateway refund failed: ${gatewayResult.message}`,
    });
  }

  // processRefund already set refundAmount/refundStatus. A partial refund
  // must not read as fully refunded — the Payments page sums these statuses.
  const refundedSoFar = Number(booking.refundAmount || 0);
  booking.paymentStatus =
    refundedSoFar >= Number(booking.finalFare || 0)
      ? "REFUNDED"
      : "PARTIALLY_REFUNDED";
  await booking.save();

  // Propagate refund to user app
  try {
    const userIdStr = String(booking.userId);
    const bookingIdStr = String(booking._id);

    emitToUser(userIdStr, "booking:refund", {
      bookingId: bookingIdStr,
      refundAmount: amount,
      reason: reason || "Refund processed",
      timestamp: new Date().toISOString(),
    });

    await notificationService
      .sendToUser(
        new Types.ObjectId(userIdStr),
        "PAYMENT",
        "Refund Processed",
        `A refund of ₹${amount} has been processed for your booking.`,
        { bookingId: bookingIdStr, refundAmount: String(amount) },
        booking._id as Types.ObjectId,
        "Booking",
      )
      .catch(() => null);
  } catch (err) {
    console.error("Admin refund: propagation error", err);
  }

  res.locals.data = {
    message: "Refund processed successfully",
    refundAmount: amount,
  };
};

/**
 * Get booking stats
 */
export const getBookingStats = async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;

  const matchStage: any = {};
  if (dateFrom || dateTo) {
    matchStage.createdAt = {};
    if (dateFrom) matchStage.createdAt.$gte = new Date(dateFrom as string);
    if (dateTo) matchStage.createdAt.$lte = new Date(dateTo as string);
  }

  const stats = await Booking.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
        totalFare: { $sum: "$finalFare" },
      },
    },
  ]);

  const dailyStats = await Booking.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
        },
        count: { $sum: 1 },
        revenue: { $sum: "$finalFare" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  res.locals.data = { stats, dailyStats };
};

/**
 * Action Center: pending assignments, delayed orders, at-risk deliveries
 */
export const getActionCenter = async (_req: Request, res: Response) => {
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const activeStatuses = ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"];

  const [pendingDocs, delayedDocs, atRiskDocs] = await Promise.all([
    Booking.find({ status: "SEARCHING" })
      .populate("userId", "fullName mobileNumber")
      .sort({ createdAt: 1 })
      .limit(10),
    Booking.find({
      status: { $in: activeStatuses },
      estimatedDropTime: { $lt: now },
    })
      .populate("driverId", "fullName mobileNumber")
      .sort({ estimatedDropTime: 1 })
      .limit(10),
    Booking.find({
      status: { $in: activeStatuses },
      "liveLocation.updatedAt": { $lt: fiveMinAgo },
    })
      .populate("driverId", "fullName mobileNumber")
      .sort({ "liveLocation.updatedAt": 1 })
      .limit(10),
  ]);

  const pendingAssignments = pendingDocs.map((b: any) => ({
    _id: String(b._id),
    bookingNumber: b.bookingNumber,
    pickupAddress: b.pickup?.address,
    pickupLat: b.pickup?.lat,
    pickupLng: b.pickup?.lng,
    waitingSince: b.createdAt,
    customerName:
      typeof b.userId === "object" && b.userId
        ? (b.userId as any).fullName
        : undefined,
  }));

  const delayedOrders = delayedDocs.map((b: any) => {
    const etd = b.estimatedDropTime ? new Date(b.estimatedDropTime).getTime() : now.getTime();
    const delayMinutes = Math.max(Math.floor((now.getTime() - etd) / 60000), 0);
    return {
      _id: String(b._id),
      bookingNumber: b.bookingNumber,
      delayMinutes,
      driverName:
        typeof b.driverId === "object" && b.driverId
          ? (b.driverId as any).fullName
          : undefined,
      driverPhone:
        typeof b.driverId === "object" && b.driverId
          ? (b.driverId as any).mobileNumber
          : undefined,
      lat: b.liveLocation?.lat ?? b.drop?.lat,
      lng: b.liveLocation?.lng ?? b.drop?.lng,
    };
  });

  const atRisk = atRiskDocs.map((b: any) => {
    const updatedAt = b.liveLocation?.updatedAt;
    const staleMinutes = updatedAt
      ? Math.floor((now.getTime() - new Date(updatedAt).getTime()) / 60000)
      : 0;
    return {
      _id: String(b._id),
      bookingNumber: b.bookingNumber,
      risk: `Driver inactive ${staleMinutes}m`,
      severity: staleMinutes >= 10 ? "high" : "medium",
    };
  });

  res.locals.data = { pendingAssignments, delayedOrders, atRisk };
};

/**
 * Assign driver manually
 */
export const assignDriver = async (req: Request, res: Response) => {
  const { id } = req.params;
  const booking = await Booking.findById(id);
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
  if (booking.status !== "SEARCHING" || booking.driverId) {
    return res.status(400).json({ success: false, message: "Booking is not searching for a driver" });
  }
  // The legacy route stays compatible. A supplied driverId cannot bypass
  // vehicle eligibility, distance ordering or driver acceptance.
  await bookingDispatchService.offerNext(String(booking._id));
  const current = await bookingDispatchService.getBookingOfferDriverIds(String(booking._id));
  if (!current.length) {
    return res.status(400).json({ success: false, message: "No available matching driver found nearby" });
  }
  res.locals.data = {
    message: "Offered to the nearest eligible driver. Awaiting driver acceptance.",
    booking, offeredDriverId: current[0], awaitingResponse: true,
  };
};

/** Offer searching orders through the same nearest-driver queue as the apps. */
export const autoAssignBookings = async (req: Request, res: Response) => {
  const { bookingId } = req.body || {};
  // Shared sweep — the job scheduler runs the SAME code on a timer, so the
  // button and the unattended run can never drift apart.
  const result = await runAutoAssignSweep(bookingId);
  res.locals.data = {
    message: `Offered ${result.offered} searching booking(s); ${result.awaitingResponse} already awaiting a driver response`,
    ...result,
  };
};
