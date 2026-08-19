import {
  SupportTicket,
  SupportMessage,
  SupportQuickReply,
  ISupportTicket,
  ISupportMessage,
  SupportTicketType,
  SupportResolutionType,
  SupportChannel,
} from "../models/support-ticket.model";
import { Types } from "mongoose";

const PRIORITY_SLA_MINUTES: Record<string, number> = {
  URGENT: 30,
  HIGH: 120,
  MEDIUM: 240,
  LOW: 480,
};

const inferTicketType = (data: {
  userId?: Types.ObjectId;
  driverId?: Types.ObjectId;
  category?: string;
}): SupportTicketType => {
  const cat = (data.category || "").toLowerCase();
  if (cat.includes("payment") || cat.includes("refund") || cat.includes("wallet"))
    return "PAYMENT";
  if (cat.includes("technical") || cat.includes("app") || cat.includes("bug"))
    return "TECHNICAL";
  if (data.driverId && !data.userId) return "DRIVER";
  return "CUSTOMER";
};

/**
 * Generate unique ticket ID
 */
const generateTicketId = async (): Promise<string> => {
  const prefix = "TKT";
  const date = new Date();
  const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;

  const count = await SupportTicket.countDocuments({
    createdAt: {
      $gte: new Date(date.setHours(0, 0, 0, 0)),
      $lt: new Date(date.setHours(23, 59, 59, 999)),
    },
  });

  return `${prefix}${dateStr}${String(count + 1).padStart(4, "0")}`;
};

/**
 * Create support ticket
 */
const URGENT_HINTS = ["sos", "emergency", "safety", "accident", "harass", "theft"];
const HIGH_HINTS = ["payment", "refund", "wallet", "damage", "charge", "overcharg"];
const BOOKING_HIGH_HINTS = ["driver", "late", "cancel", "delay", "pickup", "delivery"];

const derivePriority = (
  category: string,
  hasBooking: boolean,
): ISupportTicket["priority"] => {
  const c = (category || "").toLowerCase();
  if (URGENT_HINTS.some((h) => c.includes(h))) return "URGENT";
  if (HIGH_HINTS.some((h) => c.includes(h))) return "HIGH";
  // A trip-related complaint tied to an actual booking is time-sensitive in a
  // way the same category without a booking is not.
  if (hasBooking && BOOKING_HIGH_HINTS.some((h) => c.includes(h))) return "HIGH";
  return "MEDIUM";
};

export const createTicket = async (data: {
  userId?: Types.ObjectId;
  driverId?: Types.ObjectId;
  bookingId?: Types.ObjectId;
  type?: SupportTicketType;
  category: string;
  subcategory?: string;
  subject: string;
  description: string;
  priority?: ISupportTicket["priority"];
  slaMinutes?: number;
  linked?: ISupportTicket["linked"];
  attachments?: string[];
}) => {
  const ticketId = await generateTicketId();
  const type = data.type || inferTicketType(data);
  // Neither app sends a priority, so every ticket landed at the MEDIUM
  // default "regardless of urgency". When the caller doesn't specify one,
  // derive it from what the category says and whether a live booking is
  // attached. An explicit priority from a client still wins.
  const priority = data.priority || derivePriority(data.category, !!data.bookingId);
  const slaMinutes = data.slaMinutes ?? PRIORITY_SLA_MINUTES[priority] ?? 240;
  const slaDueAt = new Date(Date.now() + slaMinutes * 60 * 1000);

  // Repeat detection — count previous tickets from same user/driver within 30 days
  const repeatQuery: any = {
    createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
  };
  if (data.userId) repeatQuery.userId = data.userId;
  else if (data.driverId) repeatQuery.driverId = data.driverId;
  const repeatCount =
    data.userId || data.driverId
      ? await SupportTicket.countDocuments(repeatQuery)
      : 0;

  const ticket = await SupportTicket.create({
    ticketId,
    ...data,
    type,
    priority,
    slaMinutes,
    slaDueAt,
    repeatCount,
    status: "OPEN",
  });

  return ticket;
};

/**
 * Get tickets for user
 */
export const getUserTickets = async (
  userId: Types.ObjectId,
  status?: ISupportTicket["status"],
  page = 0,
  limit = 10,
) => {
  const query: any = { userId };
  if (status) query.status = status;

  return await SupportTicket.find(query)
    .populate("bookingId", "bookingNumber status")
    .sort({ createdAt: -1 })
    .skip(page * limit)
    .limit(limit);
};

/**
 * Get tickets for driver
 */
export const getDriverTickets = async (
  driverId: Types.ObjectId,
  status?: ISupportTicket["status"],
  page = 0,
  limit = 10,
) => {
  const query: any = { driverId };
  if (status) query.status = status;

  return await SupportTicket.find(query)
    .populate("bookingId", "bookingNumber status")
    .sort({ createdAt: -1 })
    .skip(page * limit)
    .limit(limit);
};

/**
 * Get all tickets (Admin)
 */
export const getAllTickets = async (
  filters: {
    status?: ISupportTicket["status"];
    priority?: ISupportTicket["priority"];
    category?: string;
    type?: SupportTicketType;
    assignedTo?: Types.ObjectId;
    escalated?: boolean;
    search?: string;
    dateFrom?: Date;
    dateTo?: Date;
    /// One customer's tickets — the admin user panel's "issues" view. The
    /// field and its index existed all along; nothing filtered on it.
    userId?: Types.ObjectId;
  },
  page = 0,
  limit = 20,
) => {
  const query: any = {};

  if (filters.status) query.status = filters.status;
  if (filters.userId) query.userId = filters.userId;
  if (filters.priority) query.priority = filters.priority;
  if (filters.category) query.category = filters.category;
  if (filters.type) query.type = filters.type;
  if (filters.assignedTo) query.assignedTo = filters.assignedTo;
  if (typeof filters.escalated === "boolean") query.escalated = filters.escalated;
  if (filters.search) {
    const rx = new RegExp(filters.search.trim(), "i");
    query.$or = [{ ticketId: rx }, { subject: rx }, { description: rx }];
  }
  if (filters.dateFrom || filters.dateTo) {
    query.createdAt = {};
    if (filters.dateFrom) query.createdAt.$gte = filters.dateFrom;
    if (filters.dateTo) query.createdAt.$lte = filters.dateTo;
  }

  const tickets = await SupportTicket.find(query)
    .populate("userId", "fullName mobileNumber email")
    .populate("driverId", "fullName mobileNumber email")
    .populate("bookingId", "bookingNumber status")
    .populate("assignedTo", "fullName email")
    .sort({ priority: -1, createdAt: -1 })
    .skip(page * limit)
    .limit(limit);

  const total = await SupportTicket.countDocuments(query);

  return { tickets, total, page, limit };
};

/**
 * Get ticket by ID
 */
export const getTicketById = async (ticketId: string) => {
  return await SupportTicket.findOne({ ticketId })
    .populate("userId", "fullName mobileNumber email")
    .populate("driverId", "fullName mobileNumber email")
    .populate("bookingId")
    .populate("assignedTo", "fullName email");
};

/**
 * Update ticket status
 */
export const updateTicketStatus = async (
  ticketId: string,
  status: ISupportTicket["status"],
  resolution?: string,
  resolutionType?: SupportResolutionType,
  closedBy?: Types.ObjectId,
) => {
  const update: any = { status };

  if (status === "RESOLVED") {
    update.resolvedAt = new Date();
    if (resolution) update.resolution = resolution;
    if (resolutionType) update.resolutionType = resolutionType;
  } else if (status === "CLOSED") {
    update.closedAt = new Date();
    if (closedBy) update.closedBy = closedBy;
    if (resolutionType) update.resolutionType = resolutionType;
  }

  return await SupportTicket.findOneAndUpdate({ ticketId }, update, {
    new: true,
  });
};

/**
 * Assign ticket to admin
 */
export const assignTicket = async (
  ticketId: string,
  adminId: Types.ObjectId,
  staffName?: string,
  staffRole?: string,
) => {
  return await SupportTicket.findOneAndUpdate(
    { ticketId },
    {
      assignedTo: adminId,
      assignedStaffName: staffName,
      assignedStaffRole: staffRole,
      assignedAt: new Date(),
      status: "IN_PROGRESS",
    },
    { new: true },
  );
};

/**
 * Escalate ticket
 */
export const escalateTicket = async (
  ticketId: string,
  reason: string,
  escalatedBy: Types.ObjectId,
) => {
  return await SupportTicket.findOneAndUpdate(
    { ticketId },
    {
      escalated: true,
      escalatedAt: new Date(),
      escalationReason: reason,
      priority: "URGENT",
      closedBy: escalatedBy,
    },
    { new: true },
  );
};

/**
 * Add message to ticket
 */
export const addMessage = async (data: {
  ticketId: Types.ObjectId;
  senderId: Types.ObjectId;
  senderType: ISupportMessage["senderType"];
  channel?: SupportChannel;
  message: string;
  attachments?: string[];
}) => {
  const channel: SupportChannel =
    data.channel ||
    (data.senderType === "DRIVER"
      ? "DRIVER"
      : data.senderType === "ADMIN"
        ? "INTERNAL"
        : "CUSTOMER");

  const message = await SupportMessage.create({ ...data, channel });

  const ticketUpdate: any = { lastMessageAt: new Date() };

  if (data.senderType === "USER" || data.senderType === "DRIVER") {
    ticketUpdate.status = "OPEN";
  } else if (data.senderType === "ADMIN" && channel !== "INTERNAL") {
    ticketUpdate.status = "WAITING_FOR_USER";
    const ticket = await SupportTicket.findById(data.ticketId).select(
      "respondedAt",
    );
    if (ticket && !ticket.respondedAt) {
      ticketUpdate.respondedAt = new Date();
    }
  }

  await SupportTicket.findByIdAndUpdate(data.ticketId, ticketUpdate);

  return message;
};

/**
 * Get messages for ticket
 */
export const getTicketMessages = async (
  ticketId: Types.ObjectId,
  channel?: SupportChannel,
  page = 0,
  limit = 50,
) => {
  const query: any = { ticketId };
  if (channel) query.channel = channel;
  return await SupportMessage.find(query)
    .sort({ createdAt: 1 })
    .skip(page * limit)
    .limit(limit);
};

/**
 * Mark messages as read
 */
export const markMessagesAsRead = async (
  ticketId: Types.ObjectId,
  readerId: Types.ObjectId,
) => {
  return await SupportMessage.updateMany(
    { ticketId, senderId: { $ne: readerId }, isRead: false },
    { isRead: true },
  );
};

/**
 * Get support ticket stats (Admin)
 */
export const getTicketStats = async () => {
  const stats = await SupportTicket.aggregate([
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
      },
    },
  ]);

  const priorityStats = await SupportTicket.aggregate([
    { $match: { status: { $nin: ["RESOLVED", "CLOSED"] } } },
    {
      $group: {
        _id: "$priority",
        count: { $sum: 1 },
      },
    },
  ]);

  const categoryStats = await SupportTicket.aggregate([
    { $match: { status: { $nin: ["RESOLVED", "CLOSED"] } } },
    {
      $group: {
        _id: "$category",
        count: { $sum: 1 },
      },
    },
  ]);

  const typeStats = await SupportTicket.aggregate([
    { $match: { status: { $nin: ["RESOLVED", "CLOSED"] } } },
    { $group: { _id: "$type", count: { $sum: 1 } } },
  ]);

  const now = new Date();
  const slaBreached = await SupportTicket.countDocuments({
    status: { $nin: ["RESOLVED", "CLOSED"] },
    slaDueAt: { $lt: now },
  });

  const escalated = await SupportTicket.countDocuments({
    escalated: true,
    status: { $nin: ["RESOLVED", "CLOSED"] },
  });

  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const new24h = await SupportTicket.countDocuments({ createdAt: { $gte: last24h } });

  // Resolution time average (minutes)
  const resolved = await SupportTicket.aggregate([
    { $match: { resolvedAt: { $exists: true }, createdAt: { $exists: true } } },
    {
      $project: {
        minutes: {
          $divide: [{ $subtract: ["$resolvedAt", "$createdAt"] }, 1000 * 60],
        },
      },
    },
    { $group: { _id: null, avgMinutes: { $avg: "$minutes" }, count: { $sum: 1 } } },
  ]);

  return {
    byStatus: stats,
    byPriority: priorityStats,
    byCategory: categoryStats,
    byType: typeStats,
    slaBreached,
    escalated,
    new24h,
    avgResolutionMinutes: resolved[0]?.avgMinutes || 0,
    totalResolved: resolved[0]?.count || 0,
  };
};

/* ============================================================
   Quick Reply Templates
   ============================================================ */

export const listQuickReplies = async (filters: {
  type?: SupportTicketType;
  category?: string;
  search?: string;
  isActive?: boolean;
}) => {
  const query: any = {};
  if (filters.type) query.type = filters.type;
  if (filters.category) query.category = filters.category;
  if (typeof filters.isActive === "boolean") query.isActive = filters.isActive;
  if (filters.search) {
    const rx = new RegExp(filters.search.trim(), "i");
    query.$or = [{ title: rx }, { body: rx }, { tags: rx }];
  }
  return await SupportQuickReply.find(query).sort({ useCount: -1, createdAt: -1 });
};

export const createQuickReply = async (data: {
  title: string;
  body: string;
  type?: SupportTicketType;
  category?: string;
  tags?: string[];
  createdBy?: Types.ObjectId;
}) => {
  return await SupportQuickReply.create({ ...data, tags: data.tags || [] });
};

export const updateQuickReply = async (
  id: string,
  data: Partial<{
    title: string;
    body: string;
    type: SupportTicketType;
    category: string;
    tags: string[];
    isActive: boolean;
  }>,
) => {
  return await SupportQuickReply.findByIdAndUpdate(id, data, { new: true });
};

export const deleteQuickReply = async (id: string) => {
  return await SupportQuickReply.findByIdAndDelete(id);
};

export const incrementQuickReplyUse = async (id: string) => {
  return await SupportQuickReply.findByIdAndUpdate(
    id,
    { $inc: { useCount: 1 } },
    { new: true },
  );
};

/**
 * Get predefined categories
 */
export const getSupportCategories = () => {
  return [
    {
      category: "Booking Issues",
      subcategories: [
        "Driver not arriving",
        "Wrong address",
        "Price mismatch",
        "Booking cancelled",
      ],
    },
    {
      category: "Payment Issues",
      subcategories: [
        "Payment failed",
        "Refund not received",
        "Overcharged",
        "Wallet issues",
      ],
    },
    {
      category: "Driver Complaints",
      subcategories: [
        "Rude behavior",
        "Unprofessional conduct",
        "Safety concern",
        "Vehicle condition",
      ],
    },
    {
      category: "Account Issues",
      subcategories: [
        "Login problems",
        "Profile update",
        "Delete account",
        "OTP not received",
      ],
    },
    {
      category: "Others",
      subcategories: ["Feedback", "Suggestion", "General inquiry"],
    },
  ];
};
