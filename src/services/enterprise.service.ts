import { Types, ClientSession } from "mongoose";
import {
  Enterprise,
  EnterpriseUser,
  IEnterprise,
} from "../models/enterprise.model";
import User from "../models/Users";
import Booking from "../models/booking.model";
import { CreditHistory } from "../models/credit-history.model";
import * as FareService from "./fare.service";
import { getDistanceForLegs } from "./routing.service";
import { generateBookingNumber } from "./booking-number.service";

/**
 * Create enterprise account request
 */
export const createEnterpriseRequest = async (
  userId: Types.ObjectId,
  data: {
    companyName: string;
    gstin?: string;
    email: string;
    phone: string;
    contactPerson: string;
    address: string;
    city: string;
    state: string;
    pincode: string;
  },
): Promise<IEnterprise> => {
  // Check if user already has an enterprise
  const existingUser = await EnterpriseUser.findOne({ userId });
  if (existingUser) {
    throw new Error("User already belongs to an enterprise");
  }

  // Check if enterprise with same email/GSTIN exists
  const existingEnterprise = await Enterprise.findOne({
    $or: [
      { email: data.email.toLowerCase() },
      ...(data.gstin ? [{ gstin: data.gstin.toUpperCase() }] : []),
    ],
  });

  if (existingEnterprise) {
    throw new Error("Enterprise with this email or GSTIN already exists");
  }

  // Create enterprise
  const enterprise = new Enterprise({
    ...data,
    email: data.email.toLowerCase(),
    gstin: data.gstin?.toUpperCase(),
    status: "PENDING",
    creditLimit: 0,
    usedCredit: 0,
    paymentTerms: 30,
    discountPercentage: 0,
    isActive: false,
  });
  await enterprise.save();

  // Add user as enterprise admin
  await EnterpriseUser.create({
    enterpriseId: enterprise._id,
    userId,
    role: "ADMIN",
    permissions: ["ALL"],
    isActive: true,
  });

  return enterprise;
};

/**
 * Get enterprise by ID
 */
export const getEnterpriseById = async (
  enterpriseId: Types.ObjectId,
): Promise<IEnterprise | null> => {
  return Enterprise.findById(enterpriseId);
};

/**
 * Get user's enterprise
 */
export const getUserEnterprise = async (userId: Types.ObjectId) => {
  const enterpriseUser = await EnterpriseUser.findOne({
    userId,
    isActive: true,
  }).populate("enterpriseId");

  if (!enterpriseUser) {
    return null;
  }

  return {
    enterprise: enterpriseUser.enterpriseId,
    role: enterpriseUser.role,
    permissions: enterpriseUser.permissions,
  };
};

/**
 * Update enterprise details
 */
export const updateEnterprise = async (
  enterpriseId: Types.ObjectId,
  userId: Types.ObjectId,
  data: Partial<IEnterprise>,
): Promise<IEnterprise | null> => {
  // Verify user is admin
  const enterpriseUser = await EnterpriseUser.findOne({
    enterpriseId,
    userId,
    role: "ADMIN",
    isActive: true,
  });

  if (!enterpriseUser) {
    throw new Error("Only admin can update enterprise details");
  }

  // Don't allow updating sensitive fields
  const { status, creditLimit, usedCredit, isActive, ...updateData } =
    data as any;

  return Enterprise.findByIdAndUpdate(
    enterpriseId,
    { $set: updateData },
    { new: true },
  );
};

/**
 * Add user to enterprise
 */
export const addEnterpriseUser = async (
  enterpriseId: Types.ObjectId,
  adminUserId: Types.ObjectId,
  newUserData: {
    userId?: Types.ObjectId;
    email?: string;
    phone?: string;
    role: "ADMIN" | "MANAGER" | "USER";
    permissions: string[];
  },
): Promise<any> => {
  // Verify admin permissions
  const adminUser = await EnterpriseUser.findOne({
    enterpriseId,
    userId: adminUserId,
    role: { $in: ["ADMIN", "MANAGER"] },
    isActive: true,
  });

  if (!adminUser) {
    throw new Error("Insufficient permissions");
  }

  // Only admin can add other admins
  if (newUserData.role === "ADMIN" && adminUser.role !== "ADMIN") {
    throw new Error("Only admin can add other admins");
  }

  // Find user by ID, email, or phone
  let targetUser;
  if (newUserData.userId) {
    targetUser = await User.findById(newUserData.userId);
  } else if (newUserData.email) {
    targetUser = await User.findOne({ email: newUserData.email.toLowerCase() });
  } else if (newUserData.phone) {
    targetUser = await User.findOne({ mobileNumber: newUserData.phone });
  }

  if (!targetUser) {
    throw new Error("User not found");
  }

  // Check if user already in an enterprise
  const existingEnterpriseUser = await EnterpriseUser.findOne({
    userId: targetUser._id,
    isActive: true,
  });

  if (existingEnterpriseUser) {
    throw new Error("User already belongs to an enterprise");
  }

  // Add user
  const enterpriseUser = new EnterpriseUser({
    enterpriseId,
    userId: targetUser._id,
    role: newUserData.role,
    permissions: newUserData.permissions,
    isActive: true,
  });
  await enterpriseUser.save();

  return enterpriseUser;
};

/**
 * Remove user from enterprise
 */
export const removeEnterpriseUser = async (
  enterpriseId: Types.ObjectId,
  adminUserId: Types.ObjectId,
  targetUserId: Types.ObjectId,
): Promise<boolean> => {
  // Verify admin permissions
  const adminUser = await EnterpriseUser.findOne({
    enterpriseId,
    userId: adminUserId,
    role: "ADMIN",
    isActive: true,
  });

  if (!adminUser) {
    throw new Error("Only admin can remove users");
  }

  // Can't remove yourself
  if (adminUserId.equals(targetUserId)) {
    throw new Error("Cannot remove yourself");
  }

  const result = await EnterpriseUser.updateOne(
    { enterpriseId, userId: targetUserId },
    { isActive: false },
  );

  return result.modifiedCount > 0;
};

/**
 * Get enterprise users
 */
export const getEnterpriseUsers = async (
  enterpriseId: Types.ObjectId,
  page: number = 1,
  limit: number = 20,
) => {
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    EnterpriseUser.find({ enterpriseId, isActive: true })
      // User model's name field is `fullName`, not `name`.
      .populate("userId", "fullName email mobileNumber profileImage")
      .skip(skip)
      .limit(limit),
    EnterpriseUser.countDocuments({ enterpriseId, isActive: true }),
  ]);

  return {
    users,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A caller-fixable failure. Carries `status` so the controller answers 400
 * instead of reporting a client mistake as a 500 server error.
 */
const badRequest = (message: string) =>
  Object.assign(new Error(message), { status: 400 });

/** A location is usable only with real coordinates. */
const hasCoords = (loc: any) =>
  loc &&
  Number.isFinite(Number(loc.lat)) &&
  Number.isFinite(Number(loc.lng)) &&
  !(Number(loc.lat) === 0 && Number(loc.lng) === 0);

/**
 * Create booking using enterprise credit.
 *
 * Everything about money here is server-derived. This used to take the price
 * straight from the request body — `bookingAmount = bookingData.finalFare ||
 * bookingData.fare` and then `new Booking({ ...bookingData })` — so an
 * enterprise user could book a real trip for ₹1 and Finance would report ₹1, and
 * the booking's subtotal/baseFare/distanceKm were all whatever the client posted.
 * It also omitted `bookingNumber`, which carries a non-sparse unique index, so
 * the second credit booking ever created failed with E11000.
 *
 * Add-ons, promo codes and coin redemption are NOT supported on this path: they
 * need the resolvers in booking.controller to be priced from the database, and
 * accepting them here would either mis-price the trip or drop them silently. The
 * request is rejected instead of quietly ignoring them.
 */
export const createCreditBooking = async (
  enterpriseId: Types.ObjectId,
  userId: Types.ObjectId,
  bookingData: any,
  session?: ClientSession,
): Promise<any> => {
  // Verify user belongs to enterprise
  const enterpriseUser = await EnterpriseUser.findOne({
    enterpriseId,
    userId,
    isActive: true,
  });

  if (!enterpriseUser) {
    throw badRequest("User does not belong to this enterprise");
  }

  // Get enterprise
  const enterprise = await Enterprise.findById(enterpriseId);
  if (!enterprise || enterprise.status !== "APPROVED" || !enterprise.isActive) {
    throw badRequest("Enterprise account is not active");
  }

  const pickup = bookingData.pickup || bookingData.pickupLocation;
  const drop = bookingData.drop || bookingData.dropLocation;
  const vehicleTypeId = bookingData.vehicleTypeId;

  if (!hasCoords(pickup) || !hasCoords(drop) || !vehicleTypeId) {
    throw badRequest(
      "pickup and drop coordinates and vehicleTypeId are required",
    );
  }

  if (
    (Array.isArray(bookingData.addons) && bookingData.addons.length > 0) ||
    bookingData.promoCode ||
    bookingData.useCoins
  ) {
    throw badRequest(
      "Add-on services, promo codes and coins are not supported on enterprise credit bookings yet",
    );
  }

  const stops = (Array.isArray(bookingData.stops) ? bookingData.stops : [])
    .map((s: any) => ({
      address: s?.address || "Stop",
      lat: Number(s?.location?.lat ?? s?.lat),
      lng: Number(s?.location?.lng ?? s?.lng),
      contactName: s?.contactName,
      contactPhone: s?.contactPhone,
    }))
    .filter(hasCoords);

  // Server-authoritative road distance, exactly as createBooking resolves it.
  const route = await getDistanceForLegs([pickup, ...stops, drop]);
  if (!route) {
    throw badRequest(
      "Could not work out a route for this trip. Please check the pickup and drop locations.",
    );
  }

  const serviceType =
    bookingData.serviceType === "OUTSTATION" ? "OUTSTATION" : "WITHIN_CITY";

  const fareBreakdown = await FareService.calculateFare({
    vehicleTypeId,
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    serviceType,
    stops: stops.length,
  });

  // The enterprise's negotiated discount comes off the priced fare.
  const discountAmount = round2(
    (fareBreakdown.finalFare * enterprise.discountPercentage) / 100,
  );
  const finalAmount = round2(fareBreakdown.finalFare - discountAmount);

  // One conditional update instead of read-then-$inc. The old code compared
  // creditLimit - usedCredit in application memory and incremented in a separate
  // write, so two concurrent bookings both passed the check and drove usedCredit
  // past the limit. $expr does the comparison inside the same atomic update.
  const claimed = await Enterprise.findOneAndUpdate(
    {
      _id: enterpriseId,
      status: "APPROVED",
      isActive: true,
      $expr: { $lte: [{ $add: ["$usedCredit", finalAmount] }, "$creditLimit"] },
    },
    { $inc: { usedCredit: finalAmount } },
    { new: true, session },
  );
  if (!claimed) {
    throw badRequest("Insufficient enterprise credit");
  }

  const creditBefore = round2(claimed.usedCredit - finalAmount);

  try {
    const booking = new Booking({
      bookingNumber: await generateBookingNumber(),
      userId,
      enterpriseId,
      vehicleTypeId,
      serviceType,
      pickup: {
        address: pickup.address || "Pickup Location",
        lat: Number(pickup.lat),
        lng: Number(pickup.lng),
      },
      drop: {
        address: drop.address || "Drop Location",
        lat: Number(drop.lat),
        lng: Number(drop.lng),
      },
      stops,
      goodsType:
        bookingData.goodsType === "BUSINESS" ? "BUSINESS" : "PERSONAL",
      goodsDescription: bookingData.goodsDescription,
      goodsQuantity: bookingData.goodsQuantity,
      // Money: every figure below is the fare service's, never the client's.
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      baseFare: fareBreakdown.baseFare,
      distanceCharge: fareBreakdown.distanceCharge,
      timeCharge: fareBreakdown.timeCharge || 0,
      surgeFare: fareBreakdown.surgeCharge || 0,
      surgeMultiplier: fareBreakdown.surgeMultiplier || 1,
      stopCharges: fareBreakdown.stopCharges || 0,
      gstAmount: fareBreakdown.gstAmount || 0,
      gstPercentage: fareBreakdown.gstPercentage || 5,
      subtotal: fareBreakdown.subtotal,
      enterpriseDiscount: discountAmount,
      totalDiscount: discountAmount,
      fare: finalAmount,
      finalFare: finalAmount,
      // The driver flow is gated on these, so a credit booking that lacks them
      // can never be picked up or completed.
      otp: String(Math.floor(1000 + Math.random() * 9000)),
      deliveryOtp: String(Math.floor(1000 + Math.random() * 9000)),
      notes: bookingData.notes,
      receiverName: bookingData.receiverName,
      receiverPhone: bookingData.receiverPhone,
      status: "SEARCHING",
      paymentMethod: "ENTERPRISE_CREDIT",
      paymentStatus: "PENDING", // Settled against the enterprise invoice later
    });
    await booking.save({ session });

    // Ledger row for the credit consumed. usedCredit was previously moved with a
    // bare $inc and no history at all, so the admin's credit screens could not be
    // reconciled against anything.
    await CreditHistory.create(
      [
        {
          enterpriseId,
          type: "CREDIT_USED",
          amount: finalAmount,
          balanceBefore: creditBefore,
          balanceAfter: claimed.usedCredit,
          bookingId: booking._id,
          reason: `Booking ${booking.bookingNumber} on enterprise credit`,
          performedByType: "CUSTOMER",
        },
      ],
      { session },
    );

    return booking;
  } catch (err) {
    // Release the credit we just claimed — otherwise a failed booking would
    // permanently consume the enterprise's limit.
    await Enterprise.updateOne(
      { _id: enterpriseId },
      { $inc: { usedCredit: -finalAmount } },
      { session },
    );
    throw err;
  }
};

/**
 * Give an enterprise its credit back when a credit booking is cancelled.
 *
 * Nothing decremented usedCredit anywhere in the codebase, so an enterprise's
 * utilisation only ever ratcheted upwards and the admin's only remedy was a
 * manual CREDIT_REPAID adjustment. Returns the amount released (0 if nothing to
 * release), and never throws: releasing credit must not fail a cancellation.
 */
export const releaseCreditForBooking = async (
  booking: any,
  reason: string,
  releaseAmount?: number,
): Promise<number> => {
  try {
    if (
      !booking?.enterpriseId ||
      booking.paymentMethod !== "ENTERPRISE_CREDIT" ||
      booking.paymentStatus === "PAID"
    ) {
      return 0;
    }

    // A credit booking draws the whole fare up-front, so releasing all of it on
    // cancellation would charge an enterprise nothing for a trip a cash
    // customer pays in full — the stage ceilings refund 0% once the goods are
    // aboard. Callers that know the cancellation stage pass the refundable
    // slice; whatever is not released stays on usedCredit as a real charge.
    const fare = round2(Number(booking.finalFare) || 0);
    const amount =
      releaseAmount === undefined
        ? fare
        : round2(Math.max(0, Math.min(fare, Number(releaseAmount) || 0)));
    if (amount <= 0) return 0;

    // Already released? One CREDIT_REPAID row per booking is enough.
    const existing = await CreditHistory.findOne({
      bookingId: booking._id,
      type: "CREDIT_REPAID",
    });
    if (existing) return 0;

    // Never take usedCredit below zero, even if the booking's fare changed after
    // the credit was claimed.
    const updated = await Enterprise.findOneAndUpdate(
      { _id: booking.enterpriseId, usedCredit: { $gte: amount } },
      { $inc: { usedCredit: -amount } },
      { new: true },
    );
    if (!updated) return 0;

    await CreditHistory.create({
      enterpriseId: booking.enterpriseId,
      type: "CREDIT_REPAID",
      amount,
      balanceBefore: round2(updated.usedCredit + amount),
      balanceAfter: updated.usedCredit,
      bookingId: booking._id,
      reason,
      performedByType: "SYSTEM",
    });

    return amount;
  } catch (err) {
    console.error("Failed to release enterprise credit:", err);
    return 0;
  }
};

/**
 * Get enterprise bookings
 */
export const getEnterpriseBookings = async (
  enterpriseId: Types.ObjectId,
  filters: {
    startDate?: Date;
    endDate?: Date;
    userId?: Types.ObjectId;
    status?: string;
  },
  page: number = 1,
  limit: number = 20,
) => {
  const skip = (page - 1) * limit;
  const query: any = { enterpriseId };

  if (filters.startDate || filters.endDate) {
    query.createdAt = {};
    if (filters.startDate) query.createdAt.$gte = filters.startDate;
    if (filters.endDate) query.createdAt.$lte = filters.endDate;
  }

  if (filters.userId) query.userId = filters.userId;
  if (filters.status) query.status = filters.status;

  const [bookings, total] = await Promise.all([
    Booking.find(query)
      .populate("userId", "fullName email")
      .populate("vehicleTypeId", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Booking.countDocuments(query),
  ]);

  return {
    bookings,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

/**
 * Get enterprise dashboard stats
 */
export const getEnterpriseDashboard = async (enterpriseId: Types.ObjectId) => {
  const enterprise = await Enterprise.findById(enterpriseId);
  if (!enterprise) {
    throw new Error("Enterprise not found");
  }

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  const [
    totalBookings,
    thisMonthBookings,
    lastMonthBookings,
    activeUsers,
    totalSpent,
    thisMonthSpent,
  ] = await Promise.all([
    Booking.countDocuments({ enterpriseId }),
    Booking.countDocuments({ enterpriseId, createdAt: { $gte: startOfMonth } }),
    Booking.countDocuments({
      enterpriseId,
      createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth },
    }),
    EnterpriseUser.countDocuments({ enterpriseId, isActive: true }),
    Booking.aggregate([
      { $match: { enterpriseId: new Types.ObjectId(enterpriseId) } },
      { $group: { _id: null, total: { $sum: "$finalFare" } } },
    ]),
    Booking.aggregate([
      {
        $match: {
          enterpriseId: new Types.ObjectId(enterpriseId),
          createdAt: { $gte: startOfMonth },
        },
      },
      { $group: { _id: null, total: { $sum: "$finalFare" } } },
    ]),
  ]);

  return {
    enterprise: {
      name: enterprise.companyName,
      status: enterprise.status,
      creditLimit: enterprise.creditLimit,
      usedCredit: enterprise.usedCredit,
      availableCredit: enterprise.creditLimit - enterprise.usedCredit,
      discountPercentage: enterprise.discountPercentage,
      paymentTerms: enterprise.paymentTerms,
    },
    stats: {
      totalBookings,
      thisMonthBookings,
      lastMonthBookings,
      bookingGrowth:
        lastMonthBookings > 0
          ? ((thisMonthBookings - lastMonthBookings) / lastMonthBookings) * 100
          : 0,
      activeUsers,
      totalSpent: totalSpent[0]?.total || 0,
      thisMonthSpent: thisMonthSpent[0]?.total || 0,
    },
  };
};

/**
 * Admin: Approve enterprise
 */
export const approveEnterprise = async (
  enterpriseId: Types.ObjectId,
  adminId: Types.ObjectId,
  creditLimit: number,
  discountPercentage: number,
  paymentTerms: number,
): Promise<IEnterprise | null> => {
  return Enterprise.findByIdAndUpdate(
    enterpriseId,
    {
      status: "APPROVED",
      creditLimit,
      discountPercentage,
      paymentTerms,
      isActive: true,
      approvedBy: adminId,
      approvedAt: new Date(),
    },
    { new: true },
  );
};

/**
 * Admin: Reject enterprise
 */
export const rejectEnterprise = async (
  enterpriseId: Types.ObjectId,
  reason: string,
): Promise<IEnterprise | null> => {
  return Enterprise.findByIdAndUpdate(
    enterpriseId,
    {
      status: "REJECTED",
      rejectionReason: reason,
      isActive: false,
    },
    { new: true },
  );
};

/**
 * Admin: Suspend enterprise
 */
export const suspendEnterprise = async (
  enterpriseId: Types.ObjectId,
  reason: string,
): Promise<IEnterprise | null> => {
  return Enterprise.findByIdAndUpdate(
    enterpriseId,
    {
      status: "SUSPENDED",
      suspensionReason: reason,
      isActive: false,
    },
    { new: true },
  );
};

/**
 * Admin: Get all enterprises
 */
export const getAllEnterprises = async (
  filters: {
    status?: string;
    search?: string;
  },
  page: number = 1,
  limit: number = 20,
) => {
  const skip = (page - 1) * limit;
  const query: any = {};

  if (filters.status) query.status = filters.status;
  if (filters.search) {
    query.$or = [
      { companyName: { $regex: filters.search, $options: "i" } },
      { email: { $regex: filters.search, $options: "i" } },
      { gstin: { $regex: filters.search, $options: "i" } },
    ];
  }

  const [enterprises, total] = await Promise.all([
    Enterprise.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Enterprise.countDocuments(query),
  ]);

  // Per-enterprise order count and completed revenue, one aggregation for the
  // page. The spec's table wants Orders and Revenue columns and the strip
  // wants a revenue-contribution figure; nothing returned them before.
  const ids = enterprises.map((e) => e._id);
  const orderAgg = ids.length
    ? await Booking.aggregate([
        { $match: { enterpriseId: { $in: ids } } },
        {
          $group: {
            _id: "$enterpriseId",
            orderCount: { $sum: 1 },
            completedRevenue: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "COMPLETED"] },
                  { $ifNull: ["$finalFare", 0] },
                  0,
                ],
              },
            },
          },
        },
      ])
    : [];
  const orderByEnterprise = new Map<string, any>(
    orderAgg.map((o: any) => [String(o._id), o]),
  );
  const enterprisesWithStats = enterprises.map((e) => {
    const o = orderByEnterprise.get(String(e._id));
    return {
      ...e.toObject(),
      orderCount: o?.orderCount ?? 0,
      completedRevenue: o?.completedRevenue ?? 0,
    };
  });

  return {
    enterprises: enterprisesWithStats,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

/**
 * Admin: Update enterprise credit limit
 */
export const updateCreditLimit = async (
  enterpriseId: Types.ObjectId,
  creditLimit: number,
): Promise<IEnterprise | null> => {
  return Enterprise.findByIdAndUpdate(
    enterpriseId,
    { creditLimit },
    { new: true },
  );
};
