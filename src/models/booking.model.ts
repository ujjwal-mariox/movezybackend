import mongoose, { Schema, Types } from "mongoose";
import { IBooking } from "../interfaces/booking";

// Location sub-schema
const LocationSchema = new Schema(
  {
    address: { type: String, required: true },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    contactName: String,
    contactPhone: String,
    floor: Number,
    isLiftAvailable: Boolean,
    // Set when the driver marks this drop delivered. Only meaningful on
    // `stops` entries — pickup/drop progress lives in the booking status.
    // Without it multi-drop rides had no per-stop state at all: nothing to
    // advance the driver to the next stop, nothing for the customer to watch.
    completedAt: Date,
  },
  { _id: false },
);

// Addon service in booking
const BookingAddonSchema = new Schema(
  {
    addonId: { type: Schema.Types.ObjectId, ref: "AddonService" },
    name: String,
    price: Number,
    quantity: { type: Number, default: 1 },
  },
  { _id: false },
);

const BookingSchema = new Schema<IBooking>(
  {
    // Booking ID for display (e.g., MZ1233)
    bookingNumber: {
      type: String,
      unique: true,
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      index: true,
    },
    enterpriseId: {
      type: Schema.Types.ObjectId,
      ref: "Enterprise",
      index: true,
    },
    vehicleTypeId: {
      type: Schema.Types.ObjectId,
      ref: "VehicleType",
      required: true,
    },

    // Service type (Within City / Outstation)
    serviceType: {
      type: String,
      enum: ["WITHIN_CITY", "OUTSTATION"],
      default: "WITHIN_CITY",
      index: true,
    },

    // Locations - Multi-stop support
    pickup: LocationSchema,
    drop: LocationSchema,
    stops: [LocationSchema], // Additional stops

    // Goods information
    goodsType: {
      type: String,
      enum: ["BUSINESS", "PERSONAL"],
      default: "PERSONAL",
    },
    goodsDescription: String,
    goodsWeight: Number, // in kg
    goodsQuantity: Number,

    // Fare breakdown
    distanceKm: { type: Number, required: true },
    durationMin: { type: Number, required: true },
    baseFare: { type: Number, required: true },
    distanceCharge: { type: Number, default: 0 },
    timeCharge: { type: Number, default: 0 },
    surgeFare: { type: Number, default: 0 },
    surgeMultiplier: { type: Number, default: 1 },

    // Add-on services (Loading/Unloading)
    addons: [BookingAddonSchema],
    addonTotal: { type: Number, default: 0 },
    /** Per-stop charge, kept apart from addonTotal so the bill can itemise it. */
    stopCharges: { type: Number, default: 0 },

    // Loading/Unloading specific
    loadingUnloading: {
      type: {
        type: String,
        enum: ["LOADING", "UNLOADING", "BOTH", "NONE"],
        default: "NONE",
      },
      pickupFloor: Number,
      dropFloor: Number,
      // Declared by the customer; the app collected this but it was never
      // stored, so the partner arrived not knowing lift vs stairs.
      isLiftAvailable: { type: Boolean, default: false },
      charge: { type: Number, default: 0 },
    },

    // Waiting charges
    waitingMinutes: { type: Number, default: 0 },
    waitingCharge: { type: Number, default: 0 },

    // Toll and other charges
    tollCharges: { type: Number, default: 0 },
    parkingCharges: { type: Number, default: 0 },

    // Promo/Discount
    promoCodeId: { type: Schema.Types.ObjectId, ref: "PromoCode" },
    promoCode: String,
    promoDiscount: { type: Number, default: 0 },

    // Coins
    coinsUsed: { type: Number, default: 0 },
    coinDiscount: { type: Number, default: 0 },
    coinsEarned: { type: Number, default: 0 },

    // Driver settlement, frozen at completion. Payouts sum `driverEarnings`
    // rather than deriving from finalFare, which included the customer's GST.
    // The admin earnings report already summed `$driverEarnings` before this
    // field existed, so it silently reported 0 for every driver.
    driverEarnings: { type: Number },
    commissionPercent: { type: Number },
    commissionAmount: { type: Number },

    // Enterprise discount
    enterpriseDiscount: { type: Number, default: 0 },

    // Tax
    gstAmount: { type: Number, default: 0 },
    gstPercentage: { type: Number, default: 5 },
    gstin: { type: String, trim: true, uppercase: true },
    gstBusinessName: { type: String, trim: true },

    // Final amounts
    subtotal: { type: Number, required: true },
    totalDiscount: { type: Number, default: 0 },
    fare: { type: Number, required: true }, // Deprecated, use finalFare
    finalFare: { type: Number, required: true },
    discount: { type: Number, default: 0 }, // Deprecated, use totalDiscount

    // Status
    status: {
      type: String,
      enum: [
        "DRAFT",
        "SEARCHING",
        "ASSIGNED",
        "DRIVER_ARRIVED",
        "PICKED",
        "IN_PROGRESS",
        "COMPLETED",
        "CANCELLED",
      ],
      default: "SEARCHING",
      index: true,
    },

    // Payment
    paymentMethod: {
      type: String,
      enum: [
        "CASH",
        "WALLET",
        // Generic online/Razorpay checkout (covers UPI / Card / Net Banking).
        // The user app sends "ONLINE" for the "Pay Online" option; without it
        // here Mongoose rejected the booking with "online is not a valid enum".
        "ONLINE",
        "CARD",
        "UPI",
        "GOOGLE_PAY",
        "PAYTM",
        "PHONEPE",
        "ENTERPRISE_CREDIT",
      ],
      default: "CASH",
    },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"],
      default: "PENDING",
      index: true,
    },
    paymentTransactionId: String,

    // Fare added after the payment was captured (stops added mid-trip). The
    // delta is never auto-charged to the card — the driver collects it in cash
    // at delivery — so the booking stays PAID for what was actually paid and
    // this holds what is still owed.
    pendingCashTopUp: { type: Number, default: 0 },

    // Cancellation
    cancellationReasonId: {
      type: Schema.Types.ObjectId,
      ref: "CancellationReason",
    },
    cancellationReason: String,
    cancelledBy: {
      type: String,
      enum: ["USER", "DRIVER", "SYSTEM"],
    },
    cancellationFee: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },
    refundStatus: {
      type: String,
      enum: ["NONE", "PENDING", "PROCESSED", "FAILED"],
      default: "NONE",
    },

    // Rating & Feedback
    rating: {
      type: Number,
      min: 1,
      max: 5,
    },
    // The customer's written review + selected tags (rateBooking writes this).
    // It was declared on IBooking but had no schema path, so strict mode dropped
    // it on save: the star persisted and every typed comment silently vanished.
    review: String,
    feedback: String,
    driverRatingForUser: Number, // Driver rates user

    // Scheduling
    isScheduled: { type: Boolean, default: false, index: true },
    scheduledAt: Date,
    /** Human label of the chosen slot, e.g. "2:00 PM - 2:30 PM". */
    scheduledSlot: String,
    /**
     * The TimeSlot the customer picked. createBooking has always passed this,
     * but there was no schema path for it — strict mode dropped it silently, so
     * the chosen slot was lost on every scheduled booking.
     */
    scheduledTimeSlotId: {
      type: Schema.Types.ObjectId,
      ref: "TimeSlot",
    },

    // Timestamps
    assignedAt: Date,
    driverArrivedAt: Date,
    pickedAt: Date,
    completedAt: Date,
    cancelledAt: Date,

    // ETA
    estimatedArrivalTime: Number, // in minutes
    estimatedPickupTime: Date,
    estimatedDropTime: Date,

    // OTP for verification
    otp: {
      type: String,
      length: 4,
    },

    // Delivery OTP: the receiver reads this out at the drop, proving the goods
    // actually reached them — the delivery-side counterpart of `otp`. Absent on
    // bookings created before it existed; completeTrip only enforces it when set.
    deliveryOtp: {
      type: String,
      length: 4,
    },

    // Consignee (the person receiving the parcel at the drop location). They are
    // not an app user, so the only way to reach them is SMS to receiverPhone.
    // NOTE: booking.controller has always passed these; without schema paths
    // Mongoose's strict mode silently dropped them on save.
    receiverName: String,
    receiverPhone: String,
    // Set once the "your parcel is on the way" SMS is actually delivered, so a
    // retry or a second pickup event can't double-send.
    consigneeNotifiedAt: Date,

    // Delivery Performance Tracking
    deliveryPerformance: {
      wasOnTime: Boolean,
      delayMinutes: Number,
      actualDropTime: Date,
    },

    // Consignment/Invoice
    consignmentNumber: String,
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice" },

    // COD Settlement
    codSettlement: {
      status: { type: String, enum: ["pending", "settled"], default: "pending" },
      amount: Number,
      settledAt: Date,
      settledBy: { type: Schema.Types.ObjectId, ref: "Admin" },
      transactionId: String,
      notes: String,
    },

    // Driver vehicle info at time of booking
    vehicleNumber: String,
    vehicleModel: String,

    // Tracking
    trackingUrl: String,
    liveLocation: {
      lat: Number,
      lng: Number,
      updatedAt: Date,
    },
  },
  { timestamps: true },
);

// Compound indexes
BookingSchema.index({ userId: 1, status: 1, createdAt: -1 });
BookingSchema.index({ driverId: 1, status: 1, createdAt: -1 });
BookingSchema.index({ status: 1, createdAt: -1 });
BookingSchema.index({ paymentStatus: 1, status: 1 });

export default mongoose.model<IBooking>("Booking", BookingSchema);
