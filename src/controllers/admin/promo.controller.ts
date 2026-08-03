import { Request, Response } from "express";
import PromoCode from "../../models/promo-code.model";
import PromoUsage from "../../models/promo-usage.model";
import * as PromoService from "../../services/promo.service";
import { Types } from "mongoose";
import { auditFromRequest, diffFields } from "./audit-log.controller";

/**
 * Get all promo codes
 */
export const getAllPromos = async (req: Request, res: Response) => {
  const { status, search, page = 0, limit = 20 } = req.query;

  const query: any = { isDeleted: false };

  if (status === "active") {
    query.isActive = true;
    query.validTo = { $gte: new Date() };
  } else if (status === "expired") {
    query.validTo = { $lt: new Date() };
  } else if (status === "inactive") {
    query.isActive = false;
  }

  if (search) {
    query.$or = [
      { code: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
  }

  const promos = await PromoCode.find(query)
    .sort({ createdAt: -1 })
    .skip(Number(page) * Number(limit))
    .limit(Number(limit));

  const total = await PromoCode.countDocuments(query);

  // Attach REAL usage stats per promo (was faked on the client as minOrderValue*1.4):
  //   realDiscount = Σ PromoUsage.discountAmount
  //   realRevenue  = Σ finalFare of the bookings those usages are attached to
  const promoIds = promos.map((p) => p._id);
  const statsById = new Map<
    string,
    { realDiscount: number; realRevenue: number; redemptions: number }
  >();
  if (promoIds.length > 0) {
    const stats = await PromoUsage.aggregate([
      { $match: { promoCodeId: { $in: promoIds } } },
      {
        $lookup: {
          from: "bookings",
          localField: "bookingId",
          foreignField: "_id",
          as: "booking",
        },
      },
      { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$promoCodeId",
          realDiscount: { $sum: "$discountAmount" },
          realRevenue: {
            $sum: { $ifNull: ["$booking.finalFare", "$booking.fare"] },
          },
          redemptions: { $sum: 1 },
        },
      },
    ]);
    stats.forEach((s: any) =>
      statsById.set(String(s._id), {
        realDiscount: Math.round(s.realDiscount || 0),
        realRevenue: Math.round(s.realRevenue || 0),
        redemptions: s.redemptions || 0,
      }),
    );
  }

  const promosWithStats = promos.map((p) => {
    const s = statsById.get(String(p._id)) || {
      realDiscount: 0,
      realRevenue: 0,
      redemptions: 0,
    };
    return { ...p.toObject(), ...s };
  });

  // Platform-wide totals across the WHOLE filtered query, not just this page.
  // The KPI cards could only sum `promosWithStats` — the 20 rows they happened
  // to be showing — so they were labelled "(this page)" and changed meaning
  // every time an admin paged or searched. Scoped to the same `query` so the
  // headline figures always describe exactly the set being listed.
  const allMatchingIds = await PromoCode.find(query).distinct("_id");
  const overall = allMatchingIds.length
    ? await PromoUsage.aggregate([
        { $match: { promoCodeId: { $in: allMatchingIds } } },
        {
          $lookup: {
            from: "bookings",
            localField: "bookingId",
            foreignField: "_id",
            as: "booking",
          },
        },
        { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: null,
            totalDiscount: { $sum: "$discountAmount" },
            totalRevenue: {
              $sum: { $ifNull: ["$booking.finalFare", "$booking.fare"] },
            },
            totalRedemptions: { $sum: 1 },
          },
        },
      ])
    : [];

  res.locals.data = {
    promos: promosWithStats,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / Number(limit)),
    totals: {
      totalDiscount: Math.round(overall[0]?.totalDiscount || 0),
      totalRevenue: Math.round(overall[0]?.totalRevenue || 0),
      totalRedemptions: overall[0]?.totalRedemptions || 0,
    },
  };
};

/**
 * Get promo by ID
 */
export const getPromoById = async (req: Request, res: Response) => {
  const { id } = req.params;

  const promo = await PromoCode.findById(id).populate(
    "applicableVehicleTypes",
    "name",
  );

  if (!promo) {
    return res.status(404).json({
      success: false,
      message: "Promo code not found",
    });
  }

  res.locals.data = { promo };
};

/**
 * Create promo code
 */
export const createPromo = async (req: Request, res: Response) => {
  const {
    code,
    description,
    discountType,
    discountValue,
    maxDiscount,
    minOrderValue,
    maxUsage,
    perUserLimit,
    validFrom,
    validTo,
    applicableVehicleTypes,
    applicableServiceTypes,
  } = req.body;

  // Check if code already exists
  const existing = await PromoCode.findOne({
    code: code.toUpperCase(),
    isDeleted: false,
  });

  if (existing) {
    return res.status(400).json({
      success: false,
      message: "Promo code already exists",
    });
  }

  const promo = await PromoService.createPromoCode({
    code: code.toUpperCase(),
    description,
    discountType,
    discountValue,
    maxDiscount,
    minOrderValue: minOrderValue || 0,
    maxUsage: maxUsage || -1,
    perUserLimit: perUserLimit || 1,
    validFrom: new Date(validFrom),
    validTo: new Date(validTo),
    applicableVehicleTypes,
    applicableServiceTypes,
    createdBy: new Types.ObjectId(req.adminId),
  });

  res.locals.data = {
    message: "Promo code created successfully",
    promo,
  };
};

/**
 * Update promo code
 */
export const updatePromo = async (req: Request, res: Response) => {
  const { id } = req.params;
  const updateData = req.body;

  // Don't allow code change
  delete updateData.code;

  // "Unlimited" is -1 for maxUsage and 1 for perUserLimit (see createPromo
  // above). A client sending a literal 0 for either — which is what an empty
  // number input produces — used to write 0 and brick the promo: every
  // redemption then failed the usage check. Normalise both on update too.
  if (updateData.maxUsage !== undefined && !updateData.maxUsage) {
    updateData.maxUsage = -1;
  }
  if (updateData.perUserLimit !== undefined && !updateData.perUserLimit) {
    updateData.perUserLimit = 1;
  }

  // Before-image for the audit row: a promo's discount value and cap are money.
  const previous = await PromoCode.findById(id).lean();

  const promo = await PromoService.updatePromoCode(
    new Types.ObjectId(id),
    updateData,
  );

  if (!promo) {
    return res.status(404).json({
      success: false,
      message: "Promo code not found",
    });
  }

  await auditFromRequest(req, {
    action: "UPDATE",
    module: "promos",
    targetId: String(promo._id),
    targetType: "PromoCode",
    description: `Updated promo code ${promo.code}`,
    changes: diffFields(previous as any, updateData),
  });

  res.locals.data = {
    message: "Promo code updated successfully",
    promo,
  };
};

/**
 * Toggle a promo code's active state
 */
export const togglePromo = async (req: Request, res: Response) => {
  const { id } = req.params;

  const promo = await PromoCode.findById(id);
  if (!promo || promo.isDeleted) {
    return res.status(404).json({
      success: false,
      message: "Promo code not found",
    });
  }

  promo.isActive = !promo.isActive;
  await promo.save();

  await auditFromRequest(req, {
    action: "CHANGE_STATUS",
    module: "promos",
    targetId: String(promo._id),
    targetType: "PromoCode",
    description: `${promo.isActive ? "Activated" : "Deactivated"} promo code ${promo.code}`,
    changes: [
      { field: "isActive", oldValue: !promo.isActive, newValue: promo.isActive },
    ],
  });

  res.locals.data = {
    message: `Promo code ${promo.isActive ? "activated" : "deactivated"}`,
    promo,
  };
};

/**
 * Delete promo code (soft delete)
 */
export const deletePromo = async (req: Request, res: Response) => {
  const { id } = req.params;

  const promo = await PromoService.deletePromoCode(new Types.ObjectId(id));

  if (!promo) {
    return res.status(404).json({
      success: false,
      message: "Promo code not found",
    });
  }

  await auditFromRequest(req, {
    action: "DELETE",
    module: "promos",
    targetId: String(promo._id),
    targetType: "PromoCode",
    description: `Deleted promo code ${promo.code}`,
  });

  res.locals.data = {
    message: "Promo code deleted successfully",
  };
};

/**
 * Get promo code usage stats
 */
export const getPromoStats = async (req: Request, res: Response) => {
  const { id } = req.params;

  const stats = await PromoService.getPromoCodeStats(new Types.ObjectId(id));

  res.locals.data = stats;
};

/**
 * Toggle promo code status
 */
export const togglePromoStatus = async (req: Request, res: Response) => {
  const { id } = req.params;

  const promo = await PromoCode.findById(id);

  if (!promo) {
    return res.status(404).json({
      success: false,
      message: "Promo code not found",
    });
  }

  promo.isActive = !promo.isActive;
  await promo.save();

  res.locals.data = {
    message: `Promo code ${promo.isActive ? "activated" : "deactivated"}`,
    promo,
  };
};
