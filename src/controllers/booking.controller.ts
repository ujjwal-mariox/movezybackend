import { Request, Response } from "express";
import mongoose from "mongoose";
import Booking from "../models/booking.model";
import Driver from "../models/driver.model";
import Vehicle from "../models/vehicle.model";
import VehicleType from "../models/vehicle-type.model";
import VehicleCategory from "../models/vehicle-category.model";
import PromoCode from "../models/promo-code.model";
import AddonService from "../models/addon-service.model";
import GoodsType from "../models/goods-type.model";
import CancellationReason from "../models/cancellation-reason.model";
import ProhibitedItem from "../models/prohibited-item.model";
import { TimeSlot } from "../models/time-slot.model";
import * as FareService from "../services/fare.service";
import * as PromoService from "../services/promo.service";
import * as CoinService from "../services/coin.service";
import * as InvoiceService from "../services/invoice.service";
import * as BookingDispatchService from "../services/booking-dispatch.service";
import * as PaymentService from "../services/payment.service";
import * as NotificationService from "../services/notification.service";
import { emitToUser } from "../utils/socket.util";
import UserGST from "../models/user-gst.model";
import { cache } from "../utils/redis.util";
import { Types } from "mongoose";

/**
 * Calculate distance between two coordinates using the Haversine formula.
 * Returns distance in kilometers.
 */
function haversineDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  // Multiply by 1.3 to approximate road distance vs straight-line
  return Math.round(R * c * 1.3 * 10) / 10;
}

/**
 * Get fare estimate for a booking
 */
export const getFareEstimate = async (req: Request, res: Response) => {
  try {
    const {
      pickup,
      drop,
      stops,
      vehicleTypeId,
      serviceType,
      addons,
      loadingUnloadingCharge,
      promoCode,
      useCoins,
    } = req.body;

    let { distanceKm, durationMin } = req.body;

    // If pickup/drop coordinates provided but distance/duration not, calculate them
    if (!distanceKm && pickup?.lat && pickup?.lng && drop?.lat && drop?.lng) {
      distanceKm = haversineDistance(
        pickup.lat, pickup.lng,
        drop.lat, drop.lng
      );
      // Estimate duration at ~25 km/h average city speed
      durationMin = Math.ceil((distanceKm / 25) * 60);
      // Minimum 5 minutes
      if (durationMin < 5) durationMin = 5;
    }

    if (!distanceKm || !durationMin || !vehicleTypeId) {
      return res.status(400).json({
        success: false,
        message: "Distance, duration, and vehicle type are required. Provide either distanceKm/durationMin or pickup/drop coordinates.",
      });
    }

    // Resolve addon prices from database if only IDs are sent
    let resolvedAddons: any[] = [];
    if (addons && addons.length > 0) {
      const addonIds = addons.map(
        (a: any) => a.addonServiceId || a.addonId || a._id
      ).filter(Boolean);
      if (addonIds.length > 0) {
        const addonDocs = await AddonService.find({
          _id: { $in: addonIds },
          isActive: true,
        });
        resolvedAddons = addonDocs.map((doc) => ({
          addonId: doc._id,
          price: doc.price,
          quantity: 1,
        }));
      }
    }

    // Calculate fare
    const fareBreakdown = await FareService.calculateFare({
      vehicleTypeId,
      distanceKm,
      durationMin,
      serviceType: serviceType || "WITHIN_CITY",
      addons: resolvedAddons,
      loadingUnloadingCharge: loadingUnloadingCharge || 0,
      stops: stops?.length || 0,
    });

    let finalAmount = fareBreakdown.finalFare;
    let promoDiscount = 0;
    let coinDiscount = 0;

    // Apply promo code if provided
    if (promoCode) {
      const promoResult = await PromoService.validatePromoCode(
        promoCode,
        (req as any).user._id,
        finalAmount,
        vehicleTypeId,
        serviceType,
      );

      if (promoResult.valid) {
        promoDiscount = promoResult.discountAmount || 0;
        finalAmount -= promoDiscount;
      }
    }

    // Calculate coin discount if requested
    if (useCoins) {
      const coinWallet = await CoinService.getCoinWallet((req as any).user._id);
      const maxCoinDiscount = Math.min(
        coinWallet?.balance || 0,
        Math.floor(finalAmount * 0.1), // Max 10% discount with coins
      );
      coinDiscount = maxCoinDiscount;
      finalAmount -= coinDiscount;
    }

    res.json({
      success: true,
      data: {
        fareBreakdown,
        distanceKm,
        durationMin,
        promoDiscount,
        coinDiscount,
        finalAmount: Math.max(finalAmount, 0),
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to calculate fare estimate",
    });
  }
};

/**
 * Create a new booking
 */
export const createBooking = async (req: Request, res: Response) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = (req as any).user._id;
    const {
      pickupLocation,
      pickupAddress,
      dropLocation,
      dropAddress,
      distanceKm,
      durationMin,
      stops,
      vehicleTypeId,
      serviceType,
      goodsType,
      goodsDescription,
      goodsWeight,
      goodsQuantity,
      addons,
      loadingUnloading,
      promoCode,
      useCoins,
      coinsToUse,
      paymentMethod,
      scheduledDate,
      scheduledTimeSlotId,
      notes,
      receiverName,
      receiverPhone,
    } = req.body;

    // Validate required fields
    if (
      !pickupLocation ||
      !dropLocation ||
      !vehicleTypeId ||
      !distanceKm ||
      !durationMin
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Required fields missing (pickupLocation, dropLocation, vehicleTypeId, distanceKm, durationMin)",
      });
    }

    // Resolve addon details from database
    let resolvedAddons: any[] = [];
    if (addons && addons.length > 0) {
      const addonIds = addons.map(
        (a: any) => a.addonServiceId || a.addonId || a._id
      ).filter(Boolean);
      if (addonIds.length > 0) {
        const addonDocs = await AddonService.find({
          _id: { $in: addonIds },
          isActive: true,
        });
        resolvedAddons = addonDocs.map((doc) => ({
          addonId: doc._id,
          name: doc.name,
          price: doc.price,
          quantity: 1,
        }));
      }
    }

    // Calculate fare
    const fareBreakdown = await FareService.calculateFare({
      vehicleTypeId,
      distanceKm,
      durationMin,
      serviceType: serviceType || "WITHIN_CITY",
      addons: resolvedAddons,
      loadingUnloadingCharge:
        loadingUnloading?.loadingCharge + loadingUnloading?.unloadingCharge ||
        0,
      stops: stops?.length || 0,
    });

    let totalAmount = fareBreakdown.finalFare;
    let promoDiscount = 0;
    let promoCodeId = null;
    let coinDiscount = 0;
    let coinsUsed = 0;

    // Validate and apply promo code
    if (promoCode) {
      const promoResult = await PromoService.validatePromoCode(
        promoCode,
        userId,
        totalAmount,
        vehicleTypeId,
        serviceType,
      );

      if (promoResult.valid && promoResult.promo) {
        promoDiscount = promoResult.discountAmount || 0;
        promoCodeId = promoResult.promo._id;
        totalAmount -= promoDiscount;
      }
    }

    // Apply coins
    if (useCoins && coinsToUse > 0) {
      try {
        await CoinService.debitCoins(
          userId,
          coinsToUse,
          "REDEMPTION",
          undefined,
          undefined,
          `Used ${coinsToUse} coins for booking discount`,
        );
        coinsUsed = coinsToUse;
        coinDiscount = coinsToUse; // 1 coin = 1 rupee
        totalAmount -= coinDiscount;
      } catch (coinError) {
        // If coin debit fails, continue without coin discount
        console.error("Failed to debit coins:", coinError);
      }
    }

    // Generate booking number atomically, syncing with existing DB records
    const seqKey = "booking:sequence";
    const exists = await cache.exists(seqKey);
    if (!exists) {
      // Initialize counter from the highest existing booking number in DB
      const lastBooking = await Booking.findOne({}, { bookingNumber: 1 })
        .sort({ createdAt: -1 })
        .lean();
      let currentMax = 0;
      if (lastBooking?.bookingNumber) {
        const match = lastBooking.bookingNumber.match(/\d+/);
        if (match) currentMax = parseInt(match[0], 10);
      }
      // Also check total count as fallback
      const totalCount = await Booking.countDocuments();
      currentMax = Math.max(currentMax, totalCount);
      await cache.set(seqKey, currentMax.toString());
    }
    const bookingSeq = await cache.incr(seqKey);
    const bookingNumber = `MZ${bookingSeq.toString().padStart(4, "0")}`;

    // Look up user's saved GSTIN (if any)
    let userGstin: string | undefined;
    let userGstBusinessName: string | undefined;
    try {
      const gstDoc = await UserGST.findOne({ userId, isActive: true });
      if (gstDoc) {
        userGstin = gstDoc.gstin;
        userGstBusinessName = gstDoc.businessName;
      }
    } catch (gstErr) {
      console.error("Failed to fetch user GST:", gstErr);
    }

    // Resolve goodsType: if an ObjectId was sent, look up the category; otherwise use as-is
    let resolvedGoodsType = goodsType || "PERSONAL";
    if (resolvedGoodsType && mongoose.Types.ObjectId.isValid(resolvedGoodsType)) {
      try {
        const goodsDoc = await GoodsType.findById(resolvedGoodsType);
        resolvedGoodsType = goodsDoc?.category || "PERSONAL";
      } catch {
        resolvedGoodsType = "PERSONAL";
      }
    }
    // Ensure it's a valid enum value
    if (!["BUSINESS", "PERSONAL"].includes(resolvedGoodsType)) {
      resolvedGoodsType = "PERSONAL";
    }

    // Calculate totals for required schema fields
    const addonTotal = resolvedAddons.reduce((sum: number, a: any) => sum + (a.price * (a.quantity || 1)), 0);
    const subtotalAmount = fareBreakdown.baseFare + fareBreakdown.distanceCharge + (fareBreakdown.timeCharge || 0) + (fareBreakdown.surgeCharge || 0) + addonTotal;
    const totalDiscount = promoDiscount + coinDiscount;
    const finalFare = Math.max(totalAmount, 0);

    // Create booking — field names MUST match the Mongoose schema
    const booking = new Booking({
      bookingNumber,
      userId,
      serviceType: serviceType || "WITHIN_CITY",
      // Schema expects `pickup` and `drop` as LocationSchema (address, lat, lng)
      pickup: {
        address: pickupAddress || "Pickup Location",
        lat: pickupLocation.lat,
        lng: pickupLocation.lng,
      },
      drop: {
        address: dropAddress || "Drop Location",
        lat: dropLocation.lat,
        lng: dropLocation.lng,
      },
      stops: (stops || []).map((stop: any) => ({
        address: stop.address || "Stop",
        lat: stop.location?.lat ?? stop.lat,
        lng: stop.location?.lng ?? stop.lng,
        contactName: stop.contactName,
        contactPhone: stop.contactPhone,
      })),
      vehicleTypeId,
      goodsType: resolvedGoodsType,
      goodsDescription,
      goodsWeight,
      goodsQuantity,
      // Schema field names (NOT distance/estimatedDuration)
      distanceKm,
      durationMin,
      baseFare: fareBreakdown.baseFare,
      distanceCharge: fareBreakdown.distanceCharge,
      timeCharge: fareBreakdown.timeCharge || 0,
      surgeFare: fareBreakdown.surgeCharge || 0,
      surgeMultiplier: fareBreakdown.surgeMultiplier || 1,
      addons: resolvedAddons.map((addon: any) => ({
        addonId: addon.addonId,
        name: addon.name,
        price: addon.price,
        quantity: addon.quantity || 1,
      })),
      addonTotal,
      loadingUnloading: loadingUnloading || {
        type: "NONE",
        pickupFloor: 0,
        dropFloor: 0,
        charge: 0,
      },
      promoCodeId,
      promoDiscount,
      coinsUsed,
      coinDiscount,
      gstAmount: fareBreakdown.gstAmount || 0,
      gstPercentage: fareBreakdown.gstPercentage || 5,
      gstin: userGstin,
      gstBusinessName: userGstBusinessName,
      // Required fields: subtotal, fare, finalFare
      subtotal: subtotalAmount,
      fare: finalFare,
      finalFare: finalFare,
      totalDiscount,
      paymentMethod: paymentMethod || "CASH",
      // Pickup OTP the customer shows the driver (driver enters it at pickup to
      // move DRIVER_ARRIVED → PICKED). Generated at creation so it always exists.
      otp: String(Math.floor(1000 + Math.random() * 9000)),
      // Schema enum: DRAFT, SEARCHING, ASSIGNED, DRIVER_ARRIVED, PICKED, IN_PROGRESS, COMPLETED, CANCELLED
      status: scheduledDate ? "DRAFT" : "SEARCHING",
      isScheduled: !!scheduledDate,
      scheduledAt: scheduledDate ? new Date(scheduledDate) : undefined,
      scheduledTimeSlotId,
      notes,
      receiverName,
      receiverPhone,
    });

    await booking.save({ session });
    await session.commitTransaction();

    // Dispatch booking to nearby drivers (bell ringing)
    if (!scheduledDate) {
      // Only dispatch immediate bookings, not scheduled ones
      const dispatchResult =
        await BookingDispatchService.dispatchBookingToDrivers(
          booking._id.toString(),
        );

      console.log(
        `Booking ${booking.bookingNumber} dispatched:`,
        dispatchResult,
      );
    }

    res.status(201).json({
      success: true,
      message: "Booking created successfully",
      data: booking,
    });
  } catch (error: any) {
    await session.abortTransaction();
    res.status(500).json({
      success: false,
      message: error.message || "Failed to create booking",
    });
  } finally {
    session.endSession();
  }
};

/**
 * Get user's bookings
 */
export const getUserBookings = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { status, page = 1, limit = 10 } = req.query;

    const query: any = { userId };
    if (status) {
      query.status = status;
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [bookings, total] = await Promise.all([
      Booking.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("vehicleTypeId", "name icon")
        .populate("driverId", "fullName mobileNumber profilePhoto"),
      Booking.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        bookings,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch bookings",
    });
  }
};

/**
 * Get booking by ID
 */
export const getBookingById = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user._id;

    // NOTE: Booking has no `vehicleId` field (only vehicleTypeId) — populating it
    // throws a Mongoose strictPopulate error (500). Removed.
    const booking = await Booking.findOne({ _id: bookingId, userId })
      .populate("vehicleTypeId", "name icon capacity")
      .populate("driverId", "fullName mobileNumber profilePhoto rating");

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    res.json({
      success: true,
      data: booking,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch booking",
    });
  }
};

/**
 * Track active booking
 */
export const trackBooking = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user._id;

    // `vehicleId` is not a schema path — populating it 500s (strictPopulate). Removed.
    const booking = await Booking.findOne({ _id: bookingId, userId })
      .populate("driverId", "fullName mobileNumber profilePhoto rating")
      .populate("vehicleTypeId", "name icon");

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    // Get driver's current location from cache
    let driverLocation = null;
    if (booking.driverId) {
      driverLocation = await cache.get(`driver:location:${booking.driverId}`);
    }

    res.json({
      success: true,
      data: {
        booking,
        driverLocation,
        eta: booking.estimatedArrivalTime || booking.durationMin || null,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to track booking",
    });
  }
};

/**
 * Apply promo code to booking
 */
export const applyPromoCode = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { promoCode } = req.body;
    const userId = (req as any).user._id;

    // A promo can be applied to a booking that is still active (not finished
    // or cancelled). "PENDING" is not a valid booking status (it is a payment
    // status), so the previous query never matched any booking.
    const booking = await Booking.findOne({
      _id: bookingId,
      userId,
      status: { $nin: ["COMPLETED", "CANCELLED"] },
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found or cannot apply promo",
      });
    }

    if (booking.promoCodeId) {
      return res.status(400).json({
        success: false,
        message: "Promo code already applied",
      });
    }

    const promoResult = await PromoService.validatePromoCode(
      promoCode,
      userId,
      booking.finalFare,
      booking.vehicleTypeId,
      booking.serviceType,
    );

    if (!promoResult.valid) {
      return res.status(400).json({
        success: false,
        message: promoResult.error,
      });
    }

    // Update booking with promo discount
    booking.promoCodeId = promoResult.promo?._id;
    booking.promoDiscount = promoResult.discountAmount || 0;
    booking.finalFare -= promoResult.discountAmount || 0;
    await booking.save();

    res.json({
      success: true,
      message: "Promo code applied successfully",
      data: {
        discount: promoResult.discountAmount,
        newTotal: booking.finalFare,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to apply promo code",
    });
  }
};

/**
 * Apply coins to booking
 */
export const applyCoins = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { coinsToUse } = req.body;
    const userId = (req as any).user._id;

    // See applyPromoCode: "PENDING" is a payment status, not a booking status,
    // so the booking was never found. Match any still-active booking instead.
    const booking = await Booking.findOne({
      _id: bookingId,
      userId,
      status: { $nin: ["COMPLETED", "CANCELLED"] },
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found or cannot apply coins",
      });
    }

    if ((booking.coinsUsed ?? 0) > 0) {
      return res.status(400).json({
        success: false,
        message: "Coins already applied",
      });
    }

    const coinWallet = await CoinService.getCoinWallet(userId);
    if (!coinWallet || coinWallet.balance < coinsToUse) {
      return res.status(400).json({
        success: false,
        message: "Insufficient coin balance",
      });
    }

    // Max 10% discount with coins
    const maxDiscount = Math.floor(booking.finalFare * 0.1);
    const actualCoins = Math.min(coinsToUse, maxDiscount, coinWallet.balance);

    // Update booking
    booking.coinsUsed = actualCoins;
    booking.coinDiscount = actualCoins;
    booking.finalFare -= actualCoins;
    await booking.save();

    res.json({
      success: true,
      message: "Coins applied successfully",
      data: {
        coinsUsed: actualCoins,
        coinDiscount: actualCoins,
        newTotal: booking.finalFare,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to apply coins",
    });
  }
};

/**
 * Schedule a booking
 */
export const scheduleBooking = async (req: Request, res: Response) => {
  // Same as createBooking but with scheduled status
  return createBooking(req, res);
};

/**
 * Get scheduled bookings
 */
export const getScheduledBookings = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    // Scheduled bookings are saved with isScheduled=true and scheduledAt
    // (status is "DRAFT", not "SCHEDULED"). The old query matched neither the
    // status nor the date field name, so it always returned [].
    const bookings = await Booking.find({
      userId,
      isScheduled: true,
      scheduledAt: { $gte: new Date() },
      status: { $nin: ["COMPLETED", "CANCELLED"] },
    })
      .sort({ scheduledAt: 1 })
      .populate("vehicleTypeId", "name icon");

    res.json({
      success: true,
      data: bookings,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch scheduled bookings",
    });
  }
};

/**
 * Cancel scheduled booking
 */
export const cancelScheduledBooking = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user._id;

    // Match scheduled bookings by the isScheduled flag (status is "DRAFT",
    // not "SCHEDULED"). Only allow cancelling ones that aren't already done.
    const booking = await Booking.findOne({
      _id: bookingId,
      userId,
      isScheduled: true,
      status: { $nin: ["COMPLETED", "CANCELLED"] },
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Scheduled booking not found",
      });
    }

    booking.status = "CANCELLED";
    booking.cancelledAt = new Date();
    booking.cancelledBy = "USER";
    await booking.save();

    res.json({
      success: true,
      message: "Scheduled booking cancelled",
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to cancel booking",
    });
  }
};

/**
 * Cancel booking
 */
export const cancelBooking = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { cancellationReasonId } = req.body;
    const userId = (req as any).user._id;

    const booking = await Booking.findOne({
      _id: bookingId,
      userId,
      status: { $in: ["DRAFT", "SEARCHING", "ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"] },
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found or cannot be cancelled",
      });
    }

    // Get cancellation reason for penalty calculation
    let refundPercentage = 100;
    if (cancellationReasonId) {
      const reason = await CancellationReason.findById(cancellationReasonId);
      if (reason && booking.status !== "PENDING") {
        refundPercentage = reason.refundPercentage;
      }
      booking.cancellationReasonId = cancellationReasonId;
    }

    const assignedDriverId = booking.driverId;
    const coinsToRestore = booking.coinsUsed ?? 0;
    const wasPaid = booking.paymentStatus === "PAID";

    booking.status = "CANCELLED";
    booking.cancelledAt = new Date();
    booking.cancelledBy = "USER";
    await booking.save();

    // 1. Refund the paid amount (if any), pro-rated by the reason's refund %.
    let refundResult: { success: boolean; message: string } = {
      success: false,
      message: "No payment to refund",
    };
    if (wasPaid && refundPercentage > 0) {
      const refundAmount = Math.round((booking.finalFare * refundPercentage) / 100);
      refundResult = await PaymentService.processRefund(
        booking._id as Types.ObjectId,
        refundAmount,
        "Booking cancelled by user",
      );
    }
    // Reflect refund outcome on the booking.
    booking.refundStatus = refundResult.success
      ? "PROCESSED"
      : wasPaid && refundPercentage > 0
        ? "PENDING"
        : booking.refundStatus;
    await booking.save();

    // 2. Restore any coins the user spent on this booking.
    if (coinsToRestore > 0) {
      try {
        await CoinService.creditCoins(
          userId,
          coinsToRestore,
          "BONUS",
          booking._id as Types.ObjectId,
          "Booking",
          `Coins refunded for cancelled booking`,
        );
      } catch (coinErr) {
        console.error("Failed to restore coins on cancellation:", coinErr);
      }
    }

    // 3. Notify the assigned driver (socket + push) so they stop heading there.
    if (assignedDriverId) {
      try {
        emitToUser(String(assignedDriverId), "booking:cancelled", {
          bookingId: String(booking._id),
          message: "This booking was cancelled by the customer.",
        });
        await NotificationService.sendToDriver(
          assignedDriverId as Types.ObjectId,
          "BOOKING",
          "Booking cancelled",
          "The customer cancelled this booking.",
          { bookingId: String(booking._id) },
        );
      } catch (notifyErr) {
        console.error("Failed to notify driver on cancellation:", notifyErr);
      }
    }

    res.json({
      success: true,
      message: "Booking cancelled successfully",
      data: {
        refundPercentage,
        refundProcessed: refundResult.success,
        coinsRestored: coinsToRestore,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to cancel booking",
    });
  }
};

/**
 * Rate booking/driver
 */
export const rateBooking = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    // The apps send the written text as `comment` (and tag chips as
    // `feedback`); older clients send `review`. Accept all three — previously
    // only `review` was read, so every comment/tag was silently discarded.
    const { rating, review, comment, feedback } = req.body;
    const userId = (req as any).user._id;

    const booking = await Booking.findOne({
      _id: bookingId,
      userId,
      status: "COMPLETED",
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Completed booking not found",
      });
    }

    if (booking.rating) {
      return res.status(400).json({
        success: false,
        message: "Booking already rated",
      });
    }

    booking.rating = rating;
    // Combine written comment with any selected feedback tags into the stored
    // review so nothing the user typed/tapped is lost.
    const text = (review || comment || "").trim();
    const tags = Array.isArray(feedback) && feedback.length
      ? feedback.join(", ")
      : "";
    booking.review = [text, tags].filter(Boolean).join(" | ") || undefined;
    await booking.save();

    // Recompute the driver's average rating from all their rated bookings.
    if (booking.driverId) {
      const agg = await Booking.aggregate([
        { $match: { driverId: booking.driverId, rating: { $gt: 0 } } },
        { $group: { _id: "$driverId", avg: { $avg: "$rating" }, count: { $sum: 1 } } },
      ]);
      if (agg.length > 0) {
        const avg = Math.round(agg[0].avg * 100) / 100;
        await Driver.findByIdAndUpdate(booking.driverId, { rating: avg });
      }
    }

    res.json({
      success: true,
      message: "Rating submitted successfully",
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to submit rating",
    });
  }
};

/**
 * Get booking invoice
 */
export const getBookingInvoice = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user._id;

    const booking = await Booking.findOne({
      _id: bookingId,
      userId,
      status: "COMPLETED",
    }).populate("vehicleTypeId", "name");

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Completed booking not found",
      });
    }

    // Generate or fetch invoice
    const invoice = await InvoiceService.generateInvoice(booking._id);

    res.json({
      success: true,
      data: invoice,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch invoice",
    });
  }
};

/**
 * Get vehicle options for a route
 */
export const getVehicleOptions = async (req: Request, res: Response) => {
  try {
    const { serviceType, goodsTypeId, pickup, drop } = req.body;
    let { distanceKm, durationMin } = req.body;

    // Auto-calculate distance from coordinates if not provided
    if (!distanceKm && pickup?.lat && pickup?.lng && drop?.lat && drop?.lng) {
      distanceKm = haversineDistance(pickup.lat, pickup.lng, drop.lat, drop.lng);
      durationMin = Math.max(5, Math.ceil((distanceKm / 25) * 60));
    }

    if (!distanceKm || !durationMin) {
      return res.status(400).json({
        success: false,
        message: "Provide distanceKm/durationMin or pickup/drop coordinates",
      });
    }

    // Get all active vehicle types with caching
    let vehicleTypes = await cache.get("vehicleTypes:active");
    if (!vehicleTypes) {
      // VehicleType has no `categoryId` field — populating it 500s (strictPopulate). Removed.
      vehicleTypes = await VehicleType.find({
        isActive: true,
        isDeleted: false,
      })
        .sort({ sortOrder: 1 });
      await cache.set("vehicleTypes:active", vehicleTypes, 3600);
    }

    // If goodsTypeId provided, get the goods type and FILTER vehicles
    let goodsType: any = null;
    if (goodsTypeId) {
      goodsType = await GoodsType.findById(goodsTypeId);
    }

    // Filter vehicles by goods type's allowedVehicleTypes (if specified)
    let filteredVehicleTypes = vehicleTypes as any[];
    if (goodsType?.allowedVehicleTypes?.length > 0) {
      const allowedIds = goodsType.allowedVehicleTypes.map((id: any) =>
        id.toString()
      );
      filteredVehicleTypes = (vehicleTypes as any[]).filter((type: any) =>
        allowedIds.includes(type._id.toString())
      );
      // Fallback to all if filter empties the list (misconfigured data)
      if (filteredVehicleTypes.length === 0) {
        filteredVehicleTypes = vehicleTypes as any[];
      }
    }

    console.log(
      `[VehicleOptions] Total active: ${(vehicleTypes as any[]).length}, After filter: ${filteredVehicleTypes.length}, goodsTypeId: ${goodsTypeId || "none"}`
    );

    // Calculate fare for each vehicle type + recommendation score
    const options = await Promise.all(
      filteredVehicleTypes.map(async (type: any) => {
        const fare = await FareService.calculateFare({
          vehicleTypeId: type._id,
          distanceKm,
          durationMin,
          serviceType: serviceType || "WITHIN_CITY",
          stops: 0,
        });

        // Recommendation score (higher = better match)
        let score = 0;

        // 1. Best value: lower fare per kg capacity = better deal
        if (type.maxWeightKg > 0) {
          const farePerKg = fare.finalFare / type.maxWeightKg;
          score += Math.max(0, 20 - farePerKg); // Up to 20 points
        }

        // 3. Range fit: if distance is within the vehicle's range
        if (distanceKm >= type.minRangeKm && distanceKm <= type.maxRangeKm) {
          score += 15;
        }

        // 4. Service type compatibility
        const svc = serviceType || "WITHIN_CITY";
        if (svc === "WITHIN_CITY" && type.allowIntraCity) score += 10;
        if (svc === "OUTSTATION" && type.allowInterCity) score += 10;

        // 5. Prefer lower sort order (admin-configured priority)
        score += Math.max(0, 10 - (type.sortOrder || 0));

        return {
          vehicleType: type,
          fare: fare.finalFare,
          fareBreakdown: fare,
          estimatedDuration: durationMin,
          distanceKm,
          score,
          isRecommended: false, // will set below
        };
      }),
    );

    // Sort by score descending, mark top one as recommended
    options.sort((a, b) => b.score - a.score);
    if (options.length > 0) {
      options[0].isRecommended = true;
    }

    res.json({
      success: true,
      data: options,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch vehicle options",
    });
  }
};

/**
 * Get addon services
 */
export const getAddonServices = async (req: Request, res: Response) => {
  try {
    let addons = await cache.get("addons:active");
    if (!addons) {
      addons = await AddonService.find({ isActive: true }).sort({
        sortOrder: 1,
      });
      await cache.set("addons:active", addons, 3600);
    }

    res.json({
      success: true,
      data: addons,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch addon services",
    });
  }
};

/**
 * Get goods types
 */
export const getGoodsTypes = async (req: Request, res: Response) => {
  try {
    let goodsTypes = await cache.get("goodsTypes:active");
    if (!goodsTypes) {
      goodsTypes = await GoodsType.find({ isActive: true, isDeleted: { $ne: true } })
        .populate("allowedVehicleTypes", "name image icon maxWeightKg")
        .sort({ sortOrder: 1 });
      await cache.set("goodsTypes:active", goodsTypes, 3600);
    }

    res.json({
      success: true,
      data: goodsTypes,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch goods types",
    });
  }
};

/**
 * Get cancellation reasons
 */
export const getCancellationReasons = async (req: Request, res: Response) => {
  try {
    let reasons = await cache.get("cancellationReasons:user");
    if (!reasons) {
      reasons = await CancellationReason.find({
        isActive: true,
        applicableTo: { $in: ["USER", "BOTH"] },
      }).sort({ sortOrder: 1 });
      await cache.set("cancellationReasons:user", reasons, 3600);
    }

    res.json({
      success: true,
      data: reasons,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch cancellation reasons",
    });
  }
};

/**
 * Get time slots for scheduling
 */
export const getTimeSlots = async (req: Request, res: Response) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    const dayOfWeek = targetDate
      .toLocaleDateString("en-US", { weekday: "long" })
      .toUpperCase();

    const slots = await TimeSlot.find({
      isActive: true,
      daysAvailable: dayOfWeek,
    }).sort({ startTime: 1 });

    res.json({
      success: true,
      data: slots,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch time slots",
    });
  }
};

/**
 * Get prohibited items (user-facing, only active)
 */
export const getProhibitedItems = async (req: Request, res: Response) => {
  try {
    let items = await cache.get("prohibitedItems:active");
    if (!items) {
      items = await ProhibitedItem.find({ isActive: true }).sort({ sortOrder: 1 });
      await cache.set("prohibitedItems:active", items, 3600);
    }

    res.json({
      success: true,
      data: items,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch prohibited items",
    });
  }
};
