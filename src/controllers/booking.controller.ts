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
import { TimeSlot, ScheduleConfig } from "../models/time-slot.model";
import { FareConfig } from "../models/app-config.model";
import * as FareService from "../services/fare.service";
import * as PromoService from "../services/promo.service";
import * as CoinService from "../services/coin.service";
import * as InvoiceService from "../services/invoice.service";
import * as BookingDispatchService from "../services/booking-dispatch.service";
import * as PaymentService from "../services/payment.service";
import * as NotificationService from "../services/notification.service";
import * as EnterpriseService from "../services/enterprise.service";
import * as UserDiscountService from "../services/user-discount.service";
import { emitToUser } from "../utils/socket.util";
import UserGST from "../models/user-gst.model";
import { cache } from "../utils/redis.util";
import { getDistanceForLegs } from "../services/routing.service";
import { generateBookingNumber } from "../services/booking-number.service";
import { Types } from "mongoose";

/** Guards against a client declaring a 10,000-floor building. */
const MAX_FLOORS = 50;
/** Heaviest load any vehicle in the catalog can take, as a sanity bound. */
const MAX_GOODS_KG = 10000;

/**
 * Weight the customer declares. Like floors, the server cannot verify it — but
 * it is only ever used as a quantity, never as a price.
 */
const resolveGoodsWeight = (goodsWeight: any) => {
  const v = Number(goodsWeight);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.round(v), MAX_GOODS_KG);
};

/**
 * Floors a customer declares for the trip. The server cannot know which floor
 * someone lives on, so these are declared *data* — but they are only ever used
 * as a quantity. The price itself always comes from the AddonService document,
 * never from the request.
 */
const resolveFloors = (loadingUnloading: any) => {
  const clamp = (n: any) => {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.min(v, MAX_FLOORS);
  };
  return {
    pickupFloor: clamp(loadingUnloading?.pickupFloor),
    dropFloor: clamp(loadingUnloading?.dropFloor),
    isLiftAvailable: Boolean(loadingUnloading?.isLiftAvailable),
  };
};

/**
 * Turn addon ids into priced line items. `price` and `priceType` are read from
 * the database; the client only ever contributes declared quantities.
 */
const resolveAddonsForFare = async (
  addons: any[] | undefined,
  floors: { pickupFloor: number; dropFloor: number },
  goodsKg: number = 0
) => {
  if (!addons || addons.length === 0) return [];
  const addonIds = addons
    .map((a: any) => a.addonServiceId || a.addonId || a._id)
    .filter(Boolean);
  if (addonIds.length === 0) return [];

  const addonDocs = await AddonService.find({
    _id: { $in: addonIds },
    isActive: true,
  });

  // Floors climbed across the trip. Always at least 1: the service still
  // happens on a ground-floor job, so it must not bill zero.
  const floorUnits = Math.max(1, floors.pickupFloor + floors.dropFloor);
  // Same rule for weight: a declared 0 still means the work happened.
  const kgUnits = Math.max(1, goodsKg);

  // Loading/unloading is priced PER PARTNER, not per floor — floors and lift
  // are inputs the customer declares, not multipliers on the bill.
  //
  // Derived here from the (already bounded) goods weight rather than taken from
  // the request: partner count multiplies the charge, so a client-supplied
  // value would be the same manipulation hole `loadingUnloadingCharge` was.
  const KG_PER_PARTNER = 100;
  const LOADING_CODES = new Set(["LDUNLD", "LDING", "UNLD"]);
  const partnerCount = Math.max(1, Math.ceil(goodsKg / KG_PER_PARTNER));

  return addonDocs.map((doc) => ({
    addonId: doc._id,
    name: doc.name,
    price: doc.price,
    quantity: LOADING_CODES.has(doc.code) ? partnerCount : 1,
    // Without this the fare service treated every add-on as FIXED, so
    // Insurance (2% of order value) billed a flat ₹2.
    priceType: doc.priceType,
    // PER_FLOOR and PER_KG add-ons had no units, so they silently billed one
    // flat unit while the app advertised "₹50/floor" and "₹25/kg".
    units:
      doc.priceType === "PER_FLOOR"
        ? floorUnits
        : doc.priceType === "PER_KG"
          ? kgUnits
          : undefined,
  }));
};

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
      loadingUnloading,
      goodsWeight,
      promoCode,
      useCoins,
    } = req.body;
    // `loadingUnloadingCharge` is deliberately NOT read from the body. It used
    // to be, and it was added straight into the subtotal — so a client could
    // post a negative charge and collapse any trip to the minimum fare
    // (verified: a ₹177 estimate became ₹59 with loadingUnloadingCharge:-100).
    // The client may send floors as *data*; only the server prices them.

    let { distanceKm, durationMin } = req.body;

    // Server-authoritative ROAD distance whenever coordinates are present —
    // overriding any client-sent figure. The old straight-line haversine
    // underquoted real road trips by ~25-35% (Delhi→Noida: 19.8 km straight
    // vs 26.3 km by road), and trusting the client's number let stale app
    // builds underquote themselves. Routed through stops in order; falls back
    // to haversine per-leg only if the router is unreachable.
    if (pickup?.lat && pickup?.lng && drop?.lat && drop?.lng) {
      const resolved = await getDistanceForLegs([
        pickup,
        ...(Array.isArray(stops)
          ? stops.filter((st: any) => st?.lat != null && st?.lng != null)
          : []),
        drop,
      ]);
      if (resolved) {
        distanceKm = resolved.distanceKm;
        durationMin = resolved.durationMin;
      }
    }

    if (!distanceKm || !durationMin || !vehicleTypeId) {
      return res.status(400).json({
        success: false,
        message: "Distance, duration, and vehicle type are required. Provide either distanceKm/durationMin or pickup/drop coordinates.",
      });
    }

    const floors = resolveFloors(loadingUnloading);
    const resolvedAddons = await resolveAddonsForFare(
      addons,
      floors,
      resolveGoodsWeight(goodsWeight)
    );

    // Calculate fare
    const fareBreakdown = await FareService.calculateFare({
      vehicleTypeId,
      distanceKm,
      durationMin,
      serviceType: serviceType || "WITHIN_CITY",
      addons: resolvedAddons,
      // Loading/unloading is priced through the add-ons above. It is never
      // taken from the request — see the note on the destructure.
      loadingUnloadingCharge: 0,
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

    // Automatic admin-managed discount — same order and basis as
    // createBooking (after promo and coins, on the remaining payable), so the
    // estimate a customer sees is the amount the booking will charge.
    let userDiscount = 0;
    const autoDiscount = await UserDiscountService.discountAmountFor(
      (req as any).user._id,
      Math.max(finalAmount, 0),
    );
    if (autoDiscount) {
      userDiscount = autoDiscount.amount;
      finalAmount -= userDiscount;
    }

    res.json({
      success: true,
      data: {
        fareBreakdown,
        distanceKm,
        durationMin,
        promoDiscount,
        userDiscount,
        coinDiscount,
        finalAmount: Math.max(finalAmount, 0),
        // What this trip will actually earn in coins, from the same service
        // that credits them at completion. The app computed `fare / 100`
        // itself and so advertised half the real rate (the server awards 2
        // coins per ₹100), quietly under-promising on every quote.
        coinsToEarn: await CoinService.calculateCoinsEarned(
          Math.max(finalAmount, 0),
          "",
        ),
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

    // The map picker's on-screen labels must never be stored as a real address.
    // Older app builds returned whatever was showing when Confirm was tapped, so
    // bookings exist with a drop address of "Move the map to select location".
    // The client is fixed, but old installs still POST it — so sanitise here
    // too and fall back to the coordinates, which are always present.
    const PLACEHOLDER_ADDRESSES = [
      "move the map to select location",
      "loading...",
      "address not found",
      "pick up from your location",
    ];
    const cleanAddress = (
      raw: unknown,
      loc: { lat?: number; lng?: number } | undefined,
      fallbackLabel: string,
    ): string => {
      const s = typeof raw === "string" ? raw.trim() : "";
      if (s && !PLACEHOLDER_ADDRESSES.includes(s.toLowerCase())) return s;
      return typeof loc?.lat === "number" && typeof loc?.lng === "number"
        ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`
        : fallbackLabel;
    };
    const safePickupAddress = cleanAddress(
      pickupAddress,
      pickupLocation,
      "Pickup Location",
    );
    const safeDropAddress = cleanAddress(
      dropAddress,
      dropLocation,
      "Drop Location",
    );

    // Validate required fields
    // distanceKm/durationMin are no longer required from the client — they're
    // resolved from the route below. They're still accepted as a fallback for
    // the case where the router is unreachable AND coordinates are missing.
    const hasRouteCoords =
      pickupLocation?.lat != null &&
      pickupLocation?.lng != null &&
      dropLocation?.lat != null &&
      dropLocation?.lng != null;

    if (!pickupLocation || !dropLocation || !vehicleTypeId) {
      return res.status(400).json({
        success: false,
        message:
          "Required fields missing (pickupLocation, dropLocation, vehicleTypeId)",
      });
    }

    if (!hasRouteCoords && (!distanceKm || !durationMin)) {
      return res.status(400).json({
        success: false,
        message:
          "Pickup and drop coordinates are required (or distanceKm and durationMin)",
      });
    }

    // ENTERPRISE_CREDIT is a valid value on the schema's paymentMethod enum, so
    // a client could book here and label the trip as billed to an enterprise —
    // this path never touches Enterprise.usedCredit and never checks a limit, so
    // the trip would be recorded against a credit account that was never
    // charged. Credit bookings go through POST /enterprise/bookings/credit.
    if (paymentMethod === "ENTERPRISE_CREDIT") {
      return res.status(400).json({
        success: false,
        message:
          "Enterprise credit bookings must be created through the enterprise credit endpoint.",
      });
    }

    // Server-authoritative road distance, matching getFareEstimate exactly —
    // both hit the same cached route, so the booked fare can never drift from
    // the quote the customer accepted. Client figures remain only as the
    // fallback when the router is unreachable.
    let bookingDistanceKm = distanceKm;
    let bookingDurationMin = durationMin;
    if (hasRouteCoords) {
      const resolvedRoute = await getDistanceForLegs([
        pickupLocation,
        ...(Array.isArray(stops)
          ? stops.filter((st: any) => st?.lat != null && st?.lng != null)
          : []),
        dropLocation,
      ]);
      if (resolvedRoute) {
        bookingDistanceKm = resolvedRoute.distanceKm;
        bookingDurationMin = resolvedRoute.durationMin;
      }
    }

    // Resolve addon details from database.
    // This used the same shape as the estimate but omitted `priceType`, so the
    // booking priced every add-on as FIXED while the estimate priced it
    // correctly — Insurance quoted 2% of the order and then billed ₹2.
    // Both paths now go through one resolver so they cannot drift again.
    const bookingFloors = resolveFloors(loadingUnloading);
    const resolvedAddons = await resolveAddonsForFare(
      addons,
      bookingFloors,
      resolveGoodsWeight(goodsWeight)
    );

    // Calculate fare
    const fareBreakdown = await FareService.calculateFare({
      vehicleTypeId,
      distanceKm: bookingDistanceKm,
      durationMin: bookingDurationMin,
      serviceType: serviceType || "WITHIN_CITY",
      addons: resolvedAddons,
      // Was `loadingUnloading?.loadingCharge + loadingUnloading?.unloadingCharge`
      // — a price straight from the request body. Loading/unloading is priced
      // through the add-ons above; the client only declares floors.
      loadingUnloadingCharge: 0,
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

    // Generate booking number atomically, syncing with existing DB records.
    // Extracted so every path that creates a Booking uses the same sequence —
    // bookingNumber has a non-sparse unique index, so a path that omits it
    // fails with E11000 on the second such booking.
    const bookingNumber = await generateBookingNumber();

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
    // Use the figure the fare service actually charged. Re-deriving it as
    // price × quantity ignored priceType, so the stored addonTotal (and the
    // invoice built from it) disagreed with the money taken: a 2% Insurance
    // add-on on a ₹5,000 order was recorded as ₹2 instead of ₹100.
    const addonTotal = fareBreakdown.addonCharges || 0;
    // Store the fare service's OWN subtotal, not a re-derived sum.
    // Re-adding the components here dropped stopCharges, tollCharges and the
    // minimum-fare floor, so the stored subtotal disagreed with the gstAmount
    // and finalFare computed from it (subtotal + gst != finalFare on any
    // booking with stops). It is also the settlement base at completion
    // (driver.controller completeTrip), so commission and driverEarnings were
    // short by 20%/80% of every stop charge and every minimum-fare top-up.
    const subtotalAmount = fareBreakdown.subtotal;
    // Automatic admin-managed discount, applied AFTER promo/coins on the
    // remaining payable. Same settlement rules as a promo: reduces the
    // customer's finalFare via totalDiscount, never subtotal, so driver
    // earnings are untouched.
    let userDiscount = 0;
    const autoDiscount = await UserDiscountService.discountAmountFor(
      userId,
      Math.max(totalAmount, 0),
    );
    if (autoDiscount) {
      userDiscount = autoDiscount.amount;
      totalAmount -= userDiscount;
    }

    const totalDiscount = promoDiscount + coinDiscount + userDiscount;
    const finalFare = Math.max(totalAmount, 0);

    // Create booking — field names MUST match the Mongoose schema
    const booking = new Booking({
      bookingNumber,
      userId,
      serviceType: serviceType || "WITHIN_CITY",
      // Schema expects `pickup` and `drop` as LocationSchema (address, lat, lng)
      pickup: {
        address: safePickupAddress,
        lat: pickupLocation.lat,
        lng: pickupLocation.lng,
      },
      drop: {
        address: safeDropAddress,
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
      // Store the validated figure the fare was actually priced from, not the
      // raw body value — the driver needs to know the weight they're lifting.
      goodsWeight: resolveGoodsWeight(goodsWeight),
      goodsQuantity,
      // Schema field names (NOT distance/estimatedDuration).
      // The resolved road figures — the same ones the fare was priced from, so
      // the invoice and trip screen can't show a distance nobody was charged for.
      distanceKm: bookingDistanceKm,
      durationMin: bookingDurationMin,
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
      stopCharges: fareBreakdown.stopCharges || 0,
      // Store the floors the customer declared (validated/clamped), not
      // whatever the request body happened to contain — `charge` in particular
      // must never come from the client. The driver needs the floor count on
      // arrival, and it is what the PER_FLOOR add-ons were priced from.
      loadingUnloading: {
        type: loadingUnloading?.type || "NONE",
        pickupFloor: bookingFloors.pickupFloor,
        dropFloor: bookingFloors.dropFloor,
        // resolveFloors already validates it; it was computed and then dropped,
        // so the partner never learned lift vs stairs.
        isLiftAvailable: bookingFloors.isLiftAvailable,
        charge: 0,
      },
      promoCodeId,
      promoDiscount,
      coinsUsed,
      coinDiscount,
      userDiscount,
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
      // Read out by the RECEIVER at the drop; gates completeTrip.
      deliveryOtp: String(Math.floor(1000 + Math.random() * 9000)),
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

    // Record the promo usage in the same transaction as the booking, so a
    // discounted booking can never exist without its usage row. Without this
    // the discount was granted but never counted, and every code stayed
    // infinitely reusable.
    if (promoCodeId && promoDiscount > 0) {
      await PromoService.applyPromoCode(
        promoCodeId,
        userId,
        booking._id as Types.ObjectId,
        promoDiscount,
        session,
      );
    }

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
        .populate("vehicleTypeId", "name icon image")
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
      .populate("vehicleTypeId", "name icon image capacity")
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
      .populate("vehicleTypeId", "name icon image");

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    // Get driver's current location from cache.
    // driverId is POPULATED above, so interpolating it directly stringified the
    // whole document and never matched the `driver:location:<id>` key the socket
    // layer writes — driverLocation came back null on every tracked booking.
    let driverLocation = null;
    if (booking.driverId) {
      const driverIdStr = String(
        (booking.driverId as any)?._id ?? booking.driverId,
      );
      driverLocation = await cache.get(`driver:location:${driverIdStr}`);
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

/** How many intermediate stops a single booking may carry. */
const MAX_EXTRA_STOPS = 3;

/**
 * The only statuses where adding a stop makes sense: a driver exists and the
 * trip is still running. DRAFT/SEARCHING have nobody to re-route (the customer
 * should edit the booking); COMPLETED/CANCELLED have nothing left to route.
 */
const STOP_ADDABLE_STATUSES = [
  "ASSIGNED",
  "DRIVER_ARRIVED",
  "PICKED",
  "IN_PROGRESS",
];

/**
 * Add an intermediate stop to a trip that is already under way.
 *
 * The client sends only WHERE the stop is. The route, the distance and the new
 * fare are all recomputed server-side from the booking's own stored inputs, the
 * same way createBooking built them — money is never taken from the request.
 *
 * The extra money is always collected in CASH at delivery. A card that has
 * already been charged is never charged again; the difference is recorded on
 * the booking as `pendingCashTopUp` instead.
 */
export const addStop = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user._id;
    const { address, lat, lng, contactName, contactPhone } = req.body;

    // A malformed id would otherwise throw a CastError and surface as a 500.
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    const stopAddress = typeof address === "string" ? address.trim() : "";
    if (!stopAddress) {
      return res.status(400).json({
        success: false,
        message: "An address is required for the new stop.",
      });
    }

    // (0, 0) is rejected alongside out-of-range values: the router treats it as
    // an unusable waypoint and silently drops that leg, which would re-price
    // the trip as if the stop had never been added.
    const stopLat = Number(lat);
    const stopLng = Number(lng);
    if (
      !Number.isFinite(stopLat) ||
      !Number.isFinite(stopLng) ||
      Math.abs(stopLat) > 90 ||
      Math.abs(stopLng) > 180 ||
      (stopLat === 0 && stopLng === 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid coordinates are required for the new stop.",
      });
    }

    const booking = await Booking.findOne({ _id: bookingId, userId });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    if (booking.status === "DRAFT" || booking.status === "SEARCHING") {
      return res.status(400).json({
        success: false,
        message:
          "No driver has been assigned yet. Please edit the booking instead of adding a stop.",
      });
    }

    if (booking.status === "COMPLETED" || booking.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: `This trip is already ${
          booking.status === "COMPLETED" ? "completed" : "cancelled"
        }, so a stop can no longer be added.`,
      });
    }

    if (!STOP_ADDABLE_STATUSES.includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: "A stop cannot be added to this booking right now.",
      });
    }

    if ((booking.stops?.length ?? 0) >= MAX_EXTRA_STOPS) {
      return res.status(400).json({
        success: false,
        message: `You can add up to ${MAX_EXTRA_STOPS} extra stops to a booking.`,
      });
    }

    // Push rather than reassign the array: the existing entries carry
    // `completedAt`, which the driver's multi-stop flow reads to know which
    // drops are already done.
    if (!booking.stops) booking.stops = [];
    const stops = booking.stops;
    stops.push({
      address: stopAddress,
      lat: stopLat,
      lng: stopLng,
      contactName:
        typeof contactName === "string" ? contactName.trim() : undefined,
      contactPhone:
        typeof contactPhone === "string" ? contactPhone.trim() : undefined,
    });

    // Road distance through pickup → every stop in order → drop, resolved the
    // same way createBooking resolves it, so the recomputed fare is built from
    // the same kind of figure the original one was.
    const resolvedRoute = await getDistanceForLegs([
      { lat: booking.pickup.lat, lng: booking.pickup.lng },
      ...stops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
      { lat: booking.drop.lat, lng: booking.drop.lng },
    ]);

    if (!resolvedRoute) {
      return res.status(400).json({
        success: false,
        message:
          "We could not work out a route through that stop. Please check the location and try again.",
      });
    }

    // Re-price from the booking's OWN stored inputs, never from the request.
    // Floors, weight and add-ons go back through the same resolvers
    // createBooking uses, so the two paths cannot price differently.
    const bookingFloors = resolveFloors(booking.loadingUnloading);
    const resolvedAddons = await resolveAddonsForFare(
      booking.addons,
      bookingFloors,
      resolveGoodsWeight(booking.goodsWeight),
    );

    const fareBreakdown = await FareService.calculateFare({
      vehicleTypeId: booking.vehicleTypeId,
      distanceKm: resolvedRoute.distanceKm,
      durationMin: resolvedRoute.durationMin,
      serviceType: booking.serviceType || "WITHIN_CITY",
      addons: resolvedAddons,
      // Priced through the add-ons, exactly as createBooking does it.
      loadingUnloadingCharge: 0,
      stops: stops.length,
      // Pin surge to when the booking was made. calculateFare defaults to
      // "now", so a stop added after the night/peak window opened would surge
      // the WHOLE trip retroactively and bill a multiplier the customer never
      // accepted. The difference must reflect the added stop and nothing else.
      scheduledTime: booking.createdAt,
    });

    // Discounts already granted stay granted. createBooking subtracts them from
    // the fare service's figure, so the same subtraction has to happen here or
    // the top-up would quietly claw the promo/coins back.
    const previousFare = booking.finalFare;
    const carriedDiscount =
      (booking.promoDiscount || 0) + (booking.coinDiscount || 0);
    const newFinalFare =
      Math.round(Math.max(0, fareBreakdown.finalFare - carriedDiscount) * 100) /
      100;
    const fareDifference =
      Math.round((newFinalFare - previousFare) * 100) / 100;

    // Persist the recomputed trip. Same field composition createBooking stores,
    // so the invoice and the trip screen keep adding up.
    const addonTotal = fareBreakdown.addonCharges || 0;
    booking.distanceKm = resolvedRoute.distanceKm;
    booking.durationMin = resolvedRoute.durationMin;
    booking.baseFare = fareBreakdown.baseFare;
    booking.distanceCharge = fareBreakdown.distanceCharge;
    booking.timeCharge = fareBreakdown.timeCharge || 0;
    booking.surgeFare = fareBreakdown.surgeCharge || 0;
    booking.surgeMultiplier = fareBreakdown.surgeMultiplier || 1;
    booking.addonTotal = addonTotal;
    booking.gstAmount = fareBreakdown.gstAmount || 0;
    booking.gstPercentage = fareBreakdown.gstPercentage || 5;
    // Same rule as createBooking: the fare service's subtotal is the figure
    // gstAmount and finalFare were derived from, and the one the driver's
    // commission/earnings are settled on. Re-deriving it here dropped the new
    // stop's charge from the settlement base.
    booking.subtotal = fareBreakdown.subtotal;
    booking.fare = newFinalFare;
    booking.finalFare = newFinalFare;

    // CASH ONLY. If the booking was already paid, the payment stands for the
    // original amount and the difference becomes cash owed to the driver — the
    // card is never touched again.
    const payableNow = booking.paymentStatus === "PAID" && fareDifference > 0;
    if (payableNow) {
      booking.pendingCashTopUp =
        (booking.pendingCashTopUp || 0) + fareDifference;
    }

    await booking.save();

    const message = payableNow
      ? `Stop added. ₹${fareDifference.toFixed(
          2,
        )} extra is payable in cash to the driver at delivery.`
      : fareDifference > 0
        ? `Stop added. Your fare is now ₹${newFinalFare.toFixed(
            2,
          )} — ₹${fareDifference.toFixed(2)} more, payable to the driver.`
        : `Stop added. Your fare stays at ₹${newFinalFare.toFixed(2)}.`;

    // Tell the driver their route changed. Never allowed to fail the request:
    // the stop is already saved and the fare already recomputed, so a push or
    // socket failure must not report an error for work that succeeded.
    if (booking.driverId) {
      try {
        emitToUser(String(booking.driverId), "booking:stop_added", {
          bookingId: String(booking._id),
          stop: { address: stopAddress, lat: stopLat, lng: stopLng },
          stops: booking.stops,
          distanceKm: booking.distanceKm,
          durationMin: booking.durationMin,
          finalFare: newFinalFare,
          // What the driver has to collect on top of an already-paid booking.
          pendingCashTopUp: booking.pendingCashTopUp || 0,
          message: `A new stop was added: ${stopAddress}`,
        });
      } catch (socketErr) {
        console.error("Failed to emit stop_added to driver:", socketErr);
      }

      NotificationService.sendToDriver(
        booking.driverId as Types.ObjectId,
        "BOOKING",
        "Stop added",
        `The customer added a new stop: ${stopAddress}`,
        {
          bookingId: String(booking._id),
          stopAddress,
          pendingCashTopUp: String(booking.pendingCashTopUp || 0),
        },
        booking._id as Types.ObjectId,
        "Booking",
      ).catch((notifyErr) =>
        console.error("Failed to notify driver about added stop:", notifyErr),
      );
    }

    res.json({
      success: true,
      data: {
        stops: booking.stops,
        distanceKm: booking.distanceKm,
        durationMin: booking.durationMin,
        previousFare,
        finalFare: newFinalFare,
        fareDifference,
        payableNow,
        message,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to add stop",
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
      .populate("vehicleTypeId", "name icon image");

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

    // Capture the stage before the status is overwritten — the refund ceiling
    // is what the stage *was* when the customer hit cancel.
    const stageCeiling = await refundCeilingForStage(booking.status);

    booking.status = "CANCELLED";
    booking.cancelledAt = new Date();
    booking.cancelledBy = "USER";
    await booking.save();

    // Return the credit this booking consumed, capped by the same stage ceiling
    // a cash refund would honour. A scheduled booking is normally still DRAFT,
    // so this is usually a full release.
    await EnterpriseService.releaseCreditForBooking(
      booking,
      `Credit released (${stageCeiling}%) — scheduled booking ${booking.bookingNumber} cancelled by customer`,
      Math.round(((Number(booking.finalFare) || 0) * stageCeiling) / 100),
    );

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
/**
 * Refund ceiling for a booking at its CURRENT stage, straight from FareConfig.
 *
 * Shared by the cancellation preview and the cancellation itself so the figure
 * the customer is shown before confirming is the figure they actually get.
 */
const refundCeilingForStage = async (status: string): Promise<number> => {
  const cfg = await FareConfig.findOne({ isActive: true })
    .select(
      "refundBeforeAssignPercent refundAfterAssignPercent refundAfterPickupPercent",
    )
    .lean();
  if (status === "DRAFT" || status === "SEARCHING") {
    return Number((cfg as any)?.refundBeforeAssignPercent ?? 100);
  }
  if (status === "ASSIGNED" || status === "DRIVER_ARRIVED") {
    return Number((cfg as any)?.refundAfterAssignPercent ?? 100);
  }
  // PICKED / IN_PROGRESS — goods are aboard.
  return Number((cfg as any)?.refundAfterPickupPercent ?? 0);
};

/**
 * The cancellation fee a reason attaches, in rupees.
 *
 * A CancellationReason has carried penaltyType/penaltyValue since the schema was
 * written, and nothing ever read them — the admin could set a penalty and the
 * customer was refunded as though it did not exist.
 *
 * The fee comes out of the refund and is capped at it. There is no mechanism to
 * take money from a customer who has not paid (a COD trip cancelled before
 * payment), so a fee larger than the refundable amount is not "debt owed" — it
 * is simply uncollectable, and recording it as revenue would be fiction.
 */
const cancellationFeeFor = (
  reason: { penaltyType?: string; penaltyValue?: number } | null,
  finalFare: number,
  refundableSlice: number,
): number => {
  if (!reason || refundableSlice <= 0) return 0;
  const value = Number(reason.penaltyValue ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;

  const raw =
    reason.penaltyType === "FIXED"
      ? value
      : reason.penaltyType === "PERCENTAGE"
        ? (Number(finalFare) || 0) * (value / 100)
        : 0; // "NONE" or anything unrecognised

  return Math.max(0, Math.min(Math.round(raw), refundableSlice));
};

/**
 * What cancelling right now would refund — WITHOUT cancelling.
 *
 * The apps offered "Cancel" with no indication of the consequence, so a
 * customer could cancel after pickup and discover only afterwards that the
 * policy refunds nothing. The percentages are admin-configurable, so the client
 * must ask rather than hardcode them.
 */
export const getCancellationPreview = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user._id;

    const booking = await Booking.findOne({ _id: bookingId, userId }).select(
      "status finalFare paymentStatus",
    );
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    const cancellable = [
      "DRAFT",
      "SEARCHING",
      "ASSIGNED",
      "DRIVER_ARRIVED",
      "PICKED",
      "IN_PROGRESS",
    ].includes(booking.status);

    // Same arithmetic cancelBooking uses, so the quoted figure is the figure.
    // This used to report the bare stage ceiling and ignore the reason
    // entirely, so a non-refundable reason still previewed a full refund.
    // The reason is optional: the app asks for a preview before the customer
    // has picked one, then asks again once they have.
    const stageCeiling = await refundCeilingForStage(booking.status);
    let refundPercentage = stageCeiling;
    let reasonDoc: any = null;
    const previewReasonId = req.query.cancellationReasonId as string | undefined;
    if (previewReasonId && Types.ObjectId.isValid(previewReasonId)) {
      reasonDoc = await CancellationReason.findById(previewReasonId);
      if (reasonDoc) {
        refundPercentage =
          reasonDoc.isRefundable === false
            ? 0
            : Math.min(Number(reasonDoc.refundPercentage ?? 100), stageCeiling);
      }
    }
    const wasPaid = booking.paymentStatus === "PAID";

    const refundableSlice = Math.round(
      (booking.finalFare * refundPercentage) / 100,
    );
    const cancellationFee = cancellationFeeFor(
      reasonDoc,
      booking.finalFare,
      refundableSlice,
    );
    const netRefund = Math.max(0, refundableSlice - cancellationFee);

    res.json({
      success: true,
      data: {
        cancellable,
        status: booking.status,
        // Goods already collected — the app warns harder for this.
        afterPickup: ["PICKED", "IN_PROGRESS"].includes(booking.status),
        wasPaid,
        refundPercentage,
        // What the reason's penalty withholds, and what is actually returned.
        // The app shows the fee separately so "you get ₹X back" is never a
        // figure the customer then fails to receive.
        cancellationFee,
        refundAmount: wasPaid ? netRefund : 0,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to load cancellation details",
    });
  }
};

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

    // Refund policy: the reason's percentage, capped by how far the trip got.
    //
    // This used to be a flat 100% — and 100% again when no reason was sent, so
    // the commonest path refunded everything even at IN_PROGRESS with the
    // goods already loaded and the driver mid-route. (The old
    // `status !== "PENDING"` guard was dead: PENDING is a payment status, not
    // a booking one, so it was never false.) Ceilings live in FareConfig so
    // the policy stays the admin's to set, not the code's.
    const stageCeiling = await refundCeilingForStage(booking.status);

    let refundPercentage = stageCeiling;
    let reasonDoc: any = null;
    if (cancellationReasonId) {
      reasonDoc = await CancellationReason.findById(cancellationReasonId);
      if (reasonDoc) {
        // A reason can only ever reduce the refund, never raise it past the
        // stage ceiling. `isRefundable: false` means exactly that and was being
        // ignored — such a reason still paid out its refundPercentage, which
        // defaults to 100.
        refundPercentage =
          reasonDoc.isRefundable === false
            ? 0
            : Math.min(Number(reasonDoc.refundPercentage ?? 100), stageCeiling);
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
    const refundableSlice = Math.round(
      (booking.finalFare * refundPercentage) / 100,
    );

    // The reason's penalty comes out of that slice. `cancellationFee` has been
    // on the Booking schema all along and was never written; the admin's
    // penalty settings had no effect on any refund.
    const cancellationFee = cancellationFeeFor(
      reasonDoc,
      booking.finalFare,
      refundableSlice,
    );
    const netRefund = Math.max(0, refundableSlice - cancellationFee);
    booking.cancellationFee = cancellationFee;

    if (wasPaid && netRefund > 0) {
      refundResult = await PaymentService.processRefund(
        booking._id as Types.ObjectId,
        netRefund,
        cancellationFee > 0
          ? `Booking cancelled by user (₹${cancellationFee} cancellation fee withheld)`
          : "Booking cancelled by user",
      );
    }
    // Reflect refund outcome on the booking.
    booking.refundStatus = refundResult.success
      ? "PROCESSED"
      : wasPaid && netRefund > 0
        ? "PENDING"
        : booking.refundStatus;
    await booking.save();

    // 1b. Give an enterprise back the same slice a cash customer would have
    // refunded. A credit booking consumed Enterprise.usedCredit when it was
    // created and nothing ever released it, so utilisation ratcheted to 100%;
    // but releasing all of it would let an enterprise cancel after pickup for
    // free while a cash customer pays the whole fare. The unreleased remainder
    // stays on usedCredit as the cancellation charge.
    await EnterpriseService.releaseCreditForBooking(
      booking,
      `Credit released (${refundPercentage}%${cancellationFee > 0 ? `, ₹${cancellationFee} fee withheld` : ""}) — booking ${booking.bookingNumber} cancelled by customer`,
      netRefund,
    );

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

    // 3. Free the driver. Completing a trip and driver-side cancel both clear
    // currentBookingId, but user-side cancel never did — so the admin tracking
    // map kept showing the driver as busy until their NEXT trip completed.
    // Conditional on it still pointing at this booking, so a driver who has
    // already moved on is untouched.
    if (assignedDriverId) {
      await Driver.updateOne(
        { _id: assignedDriverId, currentBookingId: booking._id },
        { currentBookingId: null },
      ).catch((e) => console.error("Failed to clear currentBookingId:", e));
    }

    // 4. Notify the assigned driver (socket + push) so they stop heading there.
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
        // The app used to assert "funds have been returned" on every
        // cancellation. It needs the real figures to say anything truthful:
        // what was actually paid, and what is actually coming back.
        wasPaid,
        // Net of the reason's cancellation fee, and reported alongside it, so
        // the app can show "₹X refunded, ₹Y fee" rather than a gross figure the
        // customer never receives. Recomputing the percentage here instead of
        // reusing netRefund is what let the two disagree.
        cancellationFee,
        refundAmount: wasPaid ? netRefund : 0,
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
    const { serviceType, goodsTypeId, pickup, drop, stops } = req.body;
    let { distanceKm, durationMin } = req.body;

    // Road distance through the stops in order, resolved server-side whenever
    // coordinates are present — the same figure getFareEstimate and
    // createBooking use, so the vehicle list, the estimate and the final bill
    // all price the same trip.
    if (pickup?.lat && pickup?.lng && drop?.lat && drop?.lng) {
      const resolved = await getDistanceForLegs([
        pickup,
        ...(Array.isArray(stops)
          ? stops.filter((s: any) => s?.lat != null && s?.lng != null)
          : []),
        drop,
      ]);
      if (resolved) {
        distanceKm = resolved.distanceKm;
        durationMin = resolved.durationMin;
      }
    }

    if (!distanceKm || !durationMin) {
      // Coordinates were supplied but resolution produced nothing usable —
      // never dead-end the customer on "no vehicles" for that. Fall back to
      // the straight-line approximation (the figure this endpoint used before
      // road routing) so the list still prices, and log the payload, since
      // reaching here means the resolver misbehaved.
      const pLat = Number(pickup?.lat);
      const pLng = Number(pickup?.lng);
      const dLat = Number(drop?.lat);
      const dLng = Number(drop?.lng);
      const haveCoords =
        Number.isFinite(pLat) &&
        Number.isFinite(pLng) &&
        Number.isFinite(dLat) &&
        Number.isFinite(dLng) &&
        !(pLat === 0 && pLng === 0) &&
        !(dLat === 0 && dLng === 0);

      console.warn(
        "[VehicleOptions] distance unresolved",
        JSON.stringify({ pickup, drop, stops, distanceKm, durationMin }),
      );

      if (haveCoords) {
        const R = 6371;
        const dLatR = ((dLat - pLat) * Math.PI) / 180;
        const dLngR = ((dLng - pLng) * Math.PI) / 180;
        const h =
          Math.sin(dLatR / 2) ** 2 +
          Math.cos((pLat * Math.PI) / 180) *
            Math.cos((dLat * Math.PI) / 180) *
            Math.sin(dLngR / 2) ** 2;
        // ×1.3 road approximation, matching the resolver's own fallback.
        distanceKm =
          Math.round(2 * R * Math.asin(Math.sqrt(h)) * 1.3 * 100) / 100;
        durationMin = Math.max(5, Math.ceil((distanceKm / 25) * 60));
      }

      if (!distanceKm || !durationMin) {
        return res.status(400).json({
          success: false,
          message: "Provide distanceKm/durationMin or pickup/drop coordinates",
        });
      }
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
          // Was hardcoded to 0, so every price on Select Vehicle excluded the
          // per-stop charge the customer would actually be billed.
          stops: Array.isArray(stops) ? stops.length : 0,
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

    // Admin-managed automatic discount (strikethrough pricing). Attached per
    // option so the app can show original vs discounted; `fare` stays the
    // UNDISCOUNTED figure, so an older build shows the higher price and the
    // final bill (which applies the same discount in createBooking) can only
    // come in lower — never the other way round.
    const userDiscount = await UserDiscountService.discountAmountFor(
      (req as any).userId ?? null,
      1, // probe: fetch the campaign once; per-fare amounts computed below
    );
    const withPricing = await Promise.all(
      options.map(async (o: any) => {
        if (!userDiscount) return o;
        const applied = await UserDiscountService.discountAmountFor(
          (req as any).userId ?? null,
          o.fare,
        );
        if (!applied) return o;
        return {
          ...o,
          discountPercent: applied.percent,
          discountedFare: Math.max(
            0,
            Math.round((o.fare - applied.amount) * 100) / 100,
          ),
        };
      }),
    );

    res.json({
      success: true,
      data: withPricing,
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
    if (Number.isNaN(targetDate.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date" });
    }

    // NOTE: this used to filter on `daysAvailable: <DAY>` — a field that does
    // not exist on the TimeSlot schema — so the query matched nothing and this
    // endpoint returned an empty list on every single call.
    const slots = await TimeSlot.find({ isActive: true })
      .sort({ sortOrder: 1, startTime: 1 })
      .lean();

    // Scheduling rules (how far ahead you may book, and the minimum notice).
    const cfg = await ScheduleConfig.findOne({});
    const minAdvanceHours = cfg?.minAdvanceHours ?? 1;
    const advanceBookingDays = cfg?.advanceBookingDays ?? 7;

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTarget = new Date(targetDate);
    startOfTarget.setHours(0, 0, 0, 0);

    const daysAhead = Math.round(
      (startOfTarget.getTime() - startOfToday.getTime()) / 86_400_000,
    );
    if (daysAhead < 0 || daysAhead > advanceBookingDays) {
      return res.json({ success: true, data: [] });
    }

    // Drop slots that are already gone (or too soon) when booking for today —
    // offering "2:00 PM" at 4 PM is just a failed booking waiting to happen.
    const earliest = new Date(now.getTime() + minAdvanceHours * 3_600_000);

    const available = slots
      .map((s: any) => {
        const [h, m] = String(s.startTime || "0:0").split(":").map(Number);
        const slotStart = new Date(startOfTarget);
        slotStart.setHours(h || 0, m || 0, 0, 0);
        return { ...s, slotStart };
      })
      .filter((s: any) => s.slotStart >= earliest)
      .map(({ slotStart, ...s }: any) => ({
        ...s,
        // Absolute instant for this slot on the requested date, so the client
        // doesn't have to reassemble it from a "HH:mm" string.
        scheduledAt: slotStart.toISOString(),
      }));

    res.json({
      success: true,
      data: available,
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
