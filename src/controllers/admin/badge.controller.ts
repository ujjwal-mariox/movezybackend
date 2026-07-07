import { Request, Response } from "express";
import Badge from "../../models/badge.model";

export const getBadges = async (req: Request, res: Response) => {
  const { page = 1, limit = 20, search, status } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = {};
  if (search) {
    filter.name = { $regex: search, $options: "i" };
  }
  if (status === "active") filter.isActive = true;
  else if (status === "inactive") filter.isActive = false;

  const [badges, total] = await Promise.all([
    Badge.find(filter).sort({ sortOrder: 1 }).skip(skip).limit(limitNum),
    Badge.countDocuments(filter),
  ]);

  res.locals.data = {
    badges,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

export const createBadge = async (req: Request, res: Response) => {
  const { name, description, icon, category, unlockType, unlockValue, sortOrder } = req.body;
  if (!name) {
    res.status(400);
    throw new Error("name is required");
  }

  const badge = await Badge.create({
    name,
    description: description || "",
    icon: icon || "🏆",
    category: category || "milestones",
    unlockType: unlockType || "manual",
    unlockValue: unlockValue ?? 0,
    sortOrder: sortOrder ?? 0,
    createdBy: (req as any).adminId,
  });

  res.locals.data = { message: "Badge created", badge };
};

export const updateBadge = async (req: Request, res: Response) => {
  const { id } = req.params;
  const badge = await Badge.findByIdAndUpdate(id, req.body, { new: true });
  if (!badge) {
    res.status(404);
    throw new Error("Badge not found");
  }
  res.locals.data = { message: "Badge updated", badge };
};

export const toggleBadge = async (req: Request, res: Response) => {
  const { id } = req.params;
  const badge = await Badge.findById(id);
  if (!badge) {
    res.status(404);
    throw new Error("Badge not found");
  }
  badge.isActive = !badge.isActive;
  await badge.save();
  res.locals.data = {
    message: `Badge ${badge.isActive ? "activated" : "deactivated"}`,
    badge,
  };
};

export const deleteBadge = async (req: Request, res: Response) => {
  const { id } = req.params;
  const badge = await Badge.findByIdAndDelete(id);
  if (!badge) {
    res.status(404);
    throw new Error("Badge not found");
  }
  res.locals.data = { message: "Badge deleted" };
};
