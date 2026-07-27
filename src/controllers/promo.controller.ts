import { Request, Response } from "express";
import { Types } from "mongoose";
import PromoCode from "../models/promo-code.model";
import PromoUsage from "../models/promo-usage.model";
import * as PromoService from "../services/promo.service";

/**
 * Validate promo code
 */
export const validatePromo = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { code, amount, vehicleTypeId, serviceType } = req.body;

    if (!code || !amount) {
      return res.status(400).json({
        success: false,
        message: "Promo code and amount are required",
      });
    }

    const result = await PromoService.validatePromoCode(
      code,
      userId,
      amount,
      vehicleTypeId,
      serviceType,
    );

    if (!result.valid) {
      return res.status(400).json({
        success: false,
        message: result.error,
      });
    }

    res.json({
      success: true,
      message: "Promo code is valid",
      data: {
        code: result.promo?.code,
        discountType: result.promo?.discountType,
        discountValue: result.promo?.discountValue,
        discount: result.discountAmount,
        description: result.promo?.description,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to validate promo code",
    });
  }
};

/**
 * Get available promos for user.
 *
 * This listing has to reproduce PromoService.validatePromoCode exactly, or the
 * app advertises offers that are rejected the instant the user taps Apply. The
 * previous query was looser than the validator in three ways: it never excluded
 * soft-deleted promos, its vehicle/service filters dropped promos whose
 * restriction array is absent rather than empty, and it read a `perUserLimit` of
 * 0 as "unlimited" when the validator reads it as "never usable".
 *
 * Rules that need the order under construction — minimum order value always, and
 * the vehicle/service restrictions when the caller sends no context — cannot be
 * decided here. Those offers are still returned, but with the constraint itself
 * in the payload (minOrderValue / applicableVehicleTypes / applicableServiceTypes)
 * so the client can label them instead of discovering the rejection on Apply.
 */
export const getAvailablePromos = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { vehicleTypeId, serviceType } = req.query;

    // A malformed id would make the ObjectId filter below throw a CastError and
    // surface as an opaque 500; reject it up front instead.
    if (vehicleTypeId && !Types.ObjectId.isValid(String(vehicleTypeId))) {
      return res.status(400).json({
        success: false,
        message: "Invalid vehicleTypeId",
      });
    }

    const now = new Date();

    // Same gate as validatePromoCode's findOne (schema fields: validFrom/validTo,
    // usedCount/maxUsage). isDeleted was missing here, so soft-deleted promos
    // were listed and then rejected as "Invalid or expired promo code".
    const query: any = {
      isActive: true,
      isDeleted: false,
      validFrom: { $lte: now },
      validTo: { $gte: now },
    };

    // Build $and conditions for multiple filters
    const andConditions: any[] = [
      // Global usage cap. validate rejects on `maxUsage !== -1 && usedCount >=
      // maxUsage`; a missing maxUsage compares as NaN there and therefore
      // passes, so $exists:false has to stay eligible here too.
      {
        $or: [
          { maxUsage: { $exists: false } },
          { maxUsage: -1 }, // -1 means unlimited
          { $expr: { $lt: ["$usedCount", "$maxUsage"] } },
        ],
      },
    ];

    // Filter by vehicle type if provided. validate only enforces the
    // restriction when the array is non-empty, so an absent/null array must
    // remain eligible — $size:0 alone does not match a missing field.
    if (vehicleTypeId) {
      andConditions.push({
        $or: [
          { applicableVehicleTypes: { $exists: false } },
          { applicableVehicleTypes: null },
          { applicableVehicleTypes: { $size: 0 } },
          { applicableVehicleTypes: new Types.ObjectId(String(vehicleTypeId)) },
        ],
      });
    }

    // Filter by service type if provided (same empty/absent rule as above)
    if (serviceType) {
      andConditions.push({
        $or: [
          { applicableServiceTypes: { $exists: false } },
          { applicableServiceTypes: null },
          { applicableServiceTypes: { $size: 0 } },
          { applicableServiceTypes: String(serviceType) },
        ],
      });
    }

    query.$and = andConditions;

    const promos = await PromoCode.find(query)
      .select(
        "code description discountType discountValue maxDiscount minOrderValue validFrom validTo perUserLimit applicableVehicleTypes applicableServiceTypes",
      )
      .sort({ createdAt: -1 });

    // Per-user cap: one grouped read rather than a countDocuments round-trip
    // per promo.
    const usageByPromo = new Map<string, number>();
    if (promos.length > 0) {
      const usageRows = await PromoUsage.aggregate([
        {
          $match: {
            userId,
            promoCodeId: { $in: promos.map((p) => p._id) },
          },
        },
        { $group: { _id: "$promoCodeId", count: { $sum: 1 } } },
      ]);
      for (const row of usageRows) {
        usageByPromo.set(String(row._id), row.count);
      }
    }

    const availablePromos = promos
      // validate rejects on `userUsageCount >= perUserLimit`, so a perUserLimit
      // of 0 means "never usable". The old truthiness guard read 0 as "no
      // limit" and listed offers that could never be applied.
      .filter((promo) => {
        const userUsageCount = usageByPromo.get(String(promo._id)) ?? 0;
        return !(
          typeof promo.perUserLimit === "number" &&
          userUsageCount >= promo.perUserLimit
        );
      })
      .map((promo) => {
        const userUsageCount = usageByPromo.get(String(promo._id)) ?? 0;

        return {
          id: promo._id,
          code: promo.code,
          description: promo.description,
          discountType: promo.discountType,
          discountValue: promo.discountValue,
          maxDiscount: promo.maxDiscount,
          // Constraints this endpoint cannot evaluate without the order —
          // surfaced so the client can label the offer.
          minOrderValue: promo.minOrderValue,
          applicableVehicleTypes: (promo.applicableVehicleTypes ?? []).map(
            (vt) => vt.toString(),
          ),
          applicableServiceTypes: promo.applicableServiceTypes ?? [],
          validFrom: promo.validFrom,
          expiresAt: promo.validTo,
          usedCount: userUsageCount,
          remainingUses:
            typeof promo.perUserLimit === "number"
              ? Math.max(0, promo.perUserLimit - userUsageCount)
              : null,
        };
      });

    res.json({
      success: true,
      data: availablePromos,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch available promos",
    });
  }
};

/**
 * Get promo details
 */
export const getPromoDetails = async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const userId = (req as any).user._id;

    // Soft-deleted promos are excluded by validatePromoCode, so surfacing their
    // details here only produced a code that fails on Apply.
    const promo = await PromoCode.findOne({
      code: code.toUpperCase(),
      isActive: true,
      isDeleted: false,
    }).select(
      "code description discountType discountValue maxDiscount minOrderValue validFrom validTo applicableVehicleTypes applicableServiceTypes perUserLimit",
    );

    if (!promo) {
      return res.status(404).json({
        success: false,
        message: "Promo code not found",
      });
    }

    // Get user's usage count
    const userUsageCount = await PromoUsage.countDocuments({
      promoCodeId: promo._id,
      userId,
    });

    res.json({
      success: true,
      data: {
        code: promo.code,
        description: promo.description,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
        maxDiscount: promo.maxDiscount,
        // Eligibility constraints were selected but never returned, leaving the
        // caller unable to tell whether this code would survive Apply.
        minOrderValue: promo.minOrderValue,
        applicableVehicleTypes: (promo.applicableVehicleTypes ?? []).map((vt) =>
          vt.toString(),
        ),
        applicableServiceTypes: promo.applicableServiceTypes ?? [],
        validFrom: promo.validFrom,
        expiresAt: promo.validTo,
        usedCount: userUsageCount,
        remainingUses: promo.perUserLimit
          ? Math.max(0, promo.perUserLimit - userUsageCount)
          : null,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch promo details",
    });
  }
};
