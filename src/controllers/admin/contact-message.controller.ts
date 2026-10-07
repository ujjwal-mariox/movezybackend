import { Request, Response } from "express";
import { Types } from "mongoose";
import ContactMessage from "../../models/contact-message.model";
import { CONTACT_CATEGORIES, contactCategory } from "../../services/contact-category.service";
import { auditFromRequest } from "./audit-log.controller";

const STATUSES = ["NEW", "REPLIED", "CLOSED"];
export const listContactMessages = async (req: Request, res: Response) => {
  const page = Number(req.query.page || 1), limit = Number(req.query.limit || 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ success: false, message: "Invalid pagination." });
  }
  const filter: Record<string, unknown> = {};
  if (req.query.category) {
    const category = contactCategory(req.query.category);
    if (!category) return res.status(400).json({ success: false, message: "Invalid category." });
    if (category === "OTHER") filter.$or = [{ category: "OTHER" }, { category: { $exists: false } }, { category: null }];
    else filter.category = category;
  }
  if (req.query.status) {
    if (!STATUSES.includes(String(req.query.status))) return res.status(400).json({ success: false, message: "Invalid status." });
    filter.status = req.query.status;
  }
  const [messages, total] = await Promise.all([
    ContactMessage.find(filter).select("-ip -userAgent").sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ContactMessage.countDocuments(filter),
  ]);
  res.locals.data = { messages, categories: CONTACT_CATEGORIES, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

export const updateContactMessageStatus = async (req: Request, res: Response) => {
  const id = String(req.params.id || ""), status = req.body?.status;
  if (!Types.ObjectId.isValid(id) || !STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid enquiry or status." });
  }
  const previous = await ContactMessage.findById(id).select("status").lean();
  if (!previous) return res.status(404).json({ success: false, message: "Enquiry not found." });
  const message = await ContactMessage.findByIdAndUpdate(id, { $set: { status } }, { new: true }).select("-ip -userAgent").lean();
  if (!message) return res.status(404).json({ success: false, message: "Enquiry not found." });
  await auditFromRequest(req, { action: "CHANGE_STATUS", module: "support", targetId: id, targetType: "ContactMessage", description: `Website enquiry marked ${status}`, changes: [{ field: "status", oldValue: previous.status, newValue: status }] });
  res.locals.data = { message };
};
