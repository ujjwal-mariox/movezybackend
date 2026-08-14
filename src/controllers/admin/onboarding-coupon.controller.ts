import { Request, Response } from "express";
import OnboardingCoupon from "../../models/onboarding-coupon.model";
import { auditFromRequest } from "./audit-log.controller";

/**
 * Admin CRUD for driver onboarding-fee coupons. Separate from the customer
 * PromoCode collection — those apply to bookings and the onboarding payment
 * never reads them.
 */

/** GET /admin/onboarding-coupons */
export const listCoupons = async (_req: Request, res: Response) => {
  const coupons = await OnboardingCoupon.find({})
    .sort({ createdAt: -1 })
    .lean();
  res.locals.data = { coupons, total: coupons.length };
};

/** POST /admin/onboarding-coupons */
export const createCoupon = async (req: Request, res: Response) => {
  const { code, description, discountType, value, maxUses, validFrom, validTo } =
    req.body;

  const normalized = String(code || "")
    .trim()
    .toUpperCase();
  const val = Number(value);
  if (!normalized || !["PERCENT", "FLAT"].includes(discountType)) {
    return res.status(400).json({
      success: false,
      message: "code and discountType (PERCENT|FLAT) are required",
    });
  }
  if (
    !Number.isFinite(val) ||
    val < 1 ||
    (discountType === "PERCENT" && val > 100)
  ) {
    return res.status(400).json({
      success: false,
      message:
        discountType === "PERCENT"
          ? "value must be 1–100 for PERCENT"
          : "value must be a positive rupee amount",
    });
  }
  const from = new Date(validFrom);
  const to = new Date(validTo);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) {
    return res.status(400).json({
      success: false,
      message: "validFrom/validTo must be dates with validTo after validFrom",
    });
  }

  const existing = await OnboardingCoupon.findOne({ code: normalized });
  if (existing) {
    return res
      .status(400)
      .json({ success: false, message: "Coupon code already exists" });
  }

  const coupon = await OnboardingCoupon.create({
    code: normalized,
    description,
    discountType,
    value: val,
    maxUses: Number.isFinite(Number(maxUses)) && Number(maxUses) > 0 ? Number(maxUses) : -1,
    validFrom: from,
    validTo: to,
    isActive: true,
    createdBy: (req as any).adminId,
  });

  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "promos",
    description: `Created onboarding coupon ${coupon.code} (${coupon.discountType} ${coupon.value})`,
    targetType: "OnboardingCoupon",
    targetId: String(coupon._id),
  });

  res.locals.data = { coupon };
};

/** PUT /admin/onboarding-coupons/:id — toggle or edit */
export const updateCoupon = async (req: Request, res: Response) => {
  const { id } = req.params;
  const coupon = await OnboardingCoupon.findById(id);
  if (!coupon) {
    return res
      .status(404)
      .json({ success: false, message: "Coupon not found" });
  }

  const { description, value, maxUses, isActive, validFrom, validTo } =
    req.body;
  if (description !== undefined) coupon.description = description;
  if (value !== undefined) {
    const val = Number(value);
    if (
      !Number.isFinite(val) ||
      val < 1 ||
      (coupon.discountType === "PERCENT" && val > 100)
    ) {
      return res
        .status(400)
        .json({ success: false, message: "invalid value for this coupon type" });
    }
    coupon.value = val;
  }
  if (maxUses !== undefined) {
    coupon.maxUses =
      Number.isFinite(Number(maxUses)) && Number(maxUses) > 0
        ? Number(maxUses)
        : -1;
  }
  if (isActive !== undefined) coupon.isActive = !!isActive;
  if (validFrom !== undefined) coupon.validFrom = new Date(validFrom);
  if (validTo !== undefined) coupon.validTo = new Date(validTo);
  if (coupon.validTo <= coupon.validFrom) {
    return res
      .status(400)
      .json({ success: false, message: "validTo must be after validFrom" });
  }
  await coupon.save();

  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "promos",
    description: `Updated onboarding coupon ${coupon.code} (active=${coupon.isActive})`,
    targetType: "OnboardingCoupon",
    targetId: String(coupon._id),
  });

  res.locals.data = { coupon };
};

/** DELETE /admin/onboarding-coupons/:id */
export const deleteCoupon = async (req: Request, res: Response) => {
  const { id } = req.params;
  const coupon = await OnboardingCoupon.findByIdAndDelete(id);
  if (!coupon) {
    return res
      .status(404)
      .json({ success: false, message: "Coupon not found" });
  }
  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "promos",
    description: `Deleted onboarding coupon ${coupon.code}`,
    targetType: "OnboardingCoupon",
    targetId: String(coupon._id),
  });
  res.locals.data = { message: "Coupon deleted" };
};
