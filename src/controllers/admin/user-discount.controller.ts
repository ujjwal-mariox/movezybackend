import { Request, Response } from "express";
import { Types } from "mongoose";
import UserDiscount from "../../models/user-discount.model";
import Users from "../../models/Users";
import { auditFromRequest } from "./audit-log.controller";

/**
 * Admin CRUD for automatic customer discounts ("strikethrough pricing").
 *
 * Admins target users by MOBILE NUMBER — the identifier they actually know —
 * and the controller resolves numbers to user ids. Unresolvable numbers are
 * reported back rather than silently dropped, so a typo can't quietly exclude
 * the one customer the discount was created for.
 */

const resolveUsers = async (
  mobileNumbers: unknown,
): Promise<{ ids: Types.ObjectId[]; unresolved: string[] }> => {
  const list = Array.isArray(mobileNumbers)
    ? mobileNumbers.map((m) => String(m).trim()).filter(Boolean)
    : [];
  if (list.length === 0) return { ids: [], unresolved: [] };

  const users = await Users.find({ mobileNumber: { $in: list } })
    .select("_id mobileNumber")
    .lean();
  const found = new Set(users.map((u: any) => String(u.mobileNumber)));
  return {
    ids: users.map((u: any) => u._id),
    unresolved: list.filter((m) => !found.has(m)),
  };
};

/** GET /admin/user-discounts */
export const listUserDiscounts = async (_req: Request, res: Response) => {
  const rows = await UserDiscount.find({})
    .sort({ createdAt: -1 })
    .populate("userIds", "fullName mobileNumber")
    .lean();
  res.locals.data = { discounts: rows, total: rows.length };
};

/** POST /admin/user-discounts */
export const createUserDiscount = async (req: Request, res: Response) => {
  const {
    name,
    percent,
    maxDiscountAmount,
    appliesTo,
    userMobileNumbers,
    validFrom,
    validTo,
  } = req.body;

  const pct = Number(percent);
  if (!name || !Number.isFinite(pct) || pct < 1 || pct > 90) {
    return res.status(400).json({
      success: false,
      message: "name and a percent between 1 and 90 are required",
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

  let userIds: Types.ObjectId[] = [];
  let unresolved: string[] = [];
  if (appliesTo === "USERS") {
    ({ ids: userIds, unresolved } = await resolveUsers(userMobileNumbers));
    if (userIds.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          unresolved.length > 0
            ? `No registered customer matches: ${unresolved.join(", ")}`
            : "appliesTo USERS needs at least one customer mobile number",
      });
    }
  }

  const row = await UserDiscount.create({
    name: String(name).trim(),
    percent: pct,
    maxDiscountAmount: Math.max(0, Number(maxDiscountAmount) || 0),
    appliesTo: appliesTo === "USERS" ? "USERS" : "ALL",
    userIds,
    validFrom: from,
    validTo: to,
    isActive: true,
    createdBy: (req as any).adminId,
  });

  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "promos",
    description: `Created customer discount "${row.name}" (${row.percent}%, ${row.appliesTo})`,
    targetType: "UserDiscount",
    targetId: String(row._id),
  });

  // `unresolved` travels back so the admin sees exactly which numbers did not
  // match a customer, instead of assuming everyone they typed is covered.
  res.locals.data = { discount: row, unresolvedMobileNumbers: unresolved };
};

/** PUT /admin/user-discounts/:id — toggle or edit */
export const updateUserDiscount = async (req: Request, res: Response) => {
  const { id } = req.params;
  const row = await UserDiscount.findById(id);
  if (!row) {
    return res
      .status(404)
      .json({ success: false, message: "Discount not found" });
  }

  const {
    name,
    percent,
    maxDiscountAmount,
    isActive,
    validFrom,
    validTo,
    appliesTo,
    userMobileNumbers,
  } = req.body;

  if (name !== undefined) row.name = String(name).trim();
  if (percent !== undefined) {
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct < 1 || pct > 90) {
      return res
        .status(400)
        .json({ success: false, message: "percent must be 1–90" });
    }
    row.percent = pct;
  }
  if (maxDiscountAmount !== undefined) {
    row.maxDiscountAmount = Math.max(0, Number(maxDiscountAmount) || 0);
  }
  if (isActive !== undefined) row.isActive = !!isActive;
  if (validFrom !== undefined) row.validFrom = new Date(validFrom);
  if (validTo !== undefined) row.validTo = new Date(validTo);

  let unresolved: string[] = [];
  if (appliesTo !== undefined) {
    row.appliesTo = appliesTo === "USERS" ? "USERS" : "ALL";
  }
  if (userMobileNumbers !== undefined) {
    const resolved = await resolveUsers(userMobileNumbers);
    unresolved = resolved.unresolved;
    row.userIds = resolved.ids;
    if (row.appliesTo === "USERS" && row.userIds.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          unresolved.length > 0
            ? `No registered customer matches: ${unresolved.join(", ")}`
            : "appliesTo USERS needs at least one customer mobile number",
      });
    }
  }

  if (row.validTo <= row.validFrom) {
    return res
      .status(400)
      .json({ success: false, message: "validTo must be after validFrom" });
  }

  await row.save();

  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "promos",
    description: `Updated customer discount "${row.name}" (active=${row.isActive})`,
    targetType: "UserDiscount",
    targetId: String(row._id),
  });

  res.locals.data = { discount: row, unresolvedMobileNumbers: unresolved };
};

/** DELETE /admin/user-discounts/:id */
export const deleteUserDiscount = async (req: Request, res: Response) => {
  const { id } = req.params;
  const row = await UserDiscount.findByIdAndDelete(id);
  if (!row) {
    return res
      .status(404)
      .json({ success: false, message: "Discount not found" });
  }
  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "promos",
    description: `Deleted customer discount "${row.name}"`,
    targetType: "UserDiscount",
    targetId: String(row._id),
  });
  res.locals.data = { message: "Discount deleted" };
};
