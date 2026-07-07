import mongoose, { Schema, Types } from "mongoose";

export type SupportTicketType = "CUSTOMER" | "DRIVER" | "PAYMENT" | "TECHNICAL";
export type SupportResolutionType = "RESOLVED" | "REJECTED" | "DUPLICATE" | "ESCALATED";
export type SupportChannel = "CUSTOMER" | "DRIVER" | "INTERNAL";

export interface ISupportTicket {
  _id: Types.ObjectId;
  ticketId: string;
  userId?: Types.ObjectId;
  driverId?: Types.ObjectId;
  bookingId?: Types.ObjectId;
  type: SupportTicketType;
  category: string;
  subcategory?: string;
  subject: string;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  status: "OPEN" | "IN_PROGRESS" | "WAITING_FOR_USER" | "RESOLVED" | "CLOSED";
  slaMinutes: number;
  slaDueAt?: Date;
  assignedTo?: Types.ObjectId;
  assignedStaffName?: string;
  assignedStaffRole?: string;
  assignedAt?: Date;
  respondedAt?: Date;
  linked?: {
    orderId?: Types.ObjectId;
    paymentId?: Types.ObjectId;
    customerId?: Types.ObjectId;
    driverId?: Types.ObjectId;
  };
  escalated: boolean;
  escalatedAt?: Date;
  escalationReason?: string;
  resolutionType?: SupportResolutionType;
  repeatCount: number;
  attachments: string[];
  resolution?: string;
  resolvedAt?: Date;
  closedAt?: Date;
  closedBy?: Types.ObjectId;
  lastMessageAt?: Date;
  rating?: number;
  feedback?: string;
}

export interface ISupportMessage {
  _id: Types.ObjectId;
  ticketId: Types.ObjectId;
  senderId: Types.ObjectId;
  senderType: "USER" | "DRIVER" | "ADMIN" | "SYSTEM";
  channel: SupportChannel;
  message: string;
  attachments: string[];
  isRead: boolean;
}

export interface ISupportQuickReply {
  _id: Types.ObjectId;
  title: string;
  body: string;
  type?: SupportTicketType;
  category?: string;
  tags: string[];
  createdBy?: Types.ObjectId;
  isActive: boolean;
  useCount: number;
}

// Support Ticket Schema
const SupportTicketSchema = new Schema<ISupportTicket>(
  {
    ticketId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      index: true,
    },
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
    },
    type: {
      type: String,
      enum: ["CUSTOMER", "DRIVER", "PAYMENT", "TECHNICAL"],
      default: "CUSTOMER",
      index: true,
    },
    category: {
      type: String,
      required: true,
      index: true,
    },
    subcategory: String,
    subject: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    priority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "URGENT"],
      default: "MEDIUM",
      index: true,
    },
    status: {
      type: String,
      enum: ["OPEN", "IN_PROGRESS", "WAITING_FOR_USER", "RESOLVED", "CLOSED"],
      default: "OPEN",
      index: true,
    },
    slaMinutes: {
      type: Number,
      default: 240,
    },
    slaDueAt: Date,
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    assignedStaffName: String,
    assignedStaffRole: String,
    assignedAt: Date,
    respondedAt: Date,
    linked: {
      orderId: { type: Schema.Types.ObjectId, ref: "Booking" },
      paymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
      customerId: { type: Schema.Types.ObjectId, ref: "User" },
      driverId: { type: Schema.Types.ObjectId, ref: "Driver" },
    },
    escalated: {
      type: Boolean,
      default: false,
    },
    escalatedAt: Date,
    escalationReason: String,
    resolutionType: {
      type: String,
      enum: ["RESOLVED", "REJECTED", "DUPLICATE", "ESCALATED"],
    },
    repeatCount: {
      type: Number,
      default: 0,
    },
    attachments: [String],
    resolution: String,
    resolvedAt: Date,
    closedAt: Date,
    closedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    lastMessageAt: Date,
    rating: Number,
    feedback: String,
  },
  { timestamps: true },
);

// Support Message Schema
const SupportMessageSchema = new Schema<ISupportMessage>(
  {
    ticketId: {
      type: Schema.Types.ObjectId,
      ref: "SupportTicket",
      required: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    senderType: {
      type: String,
      enum: ["USER", "DRIVER", "ADMIN", "SYSTEM"],
      required: true,
    },
    channel: {
      type: String,
      enum: ["CUSTOMER", "DRIVER", "INTERNAL"],
      default: "CUSTOMER",
      index: true,
    },
    message: {
      type: String,
      required: true,
    },
    attachments: [String],
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Support Quick Reply (templates used by admins for faster responses)
const SupportQuickReplySchema = new Schema<ISupportQuickReply>(
  {
    title: { type: String, required: true, index: true },
    body: { type: String, required: true },
    type: {
      type: String,
      enum: ["CUSTOMER", "DRIVER", "PAYMENT", "TECHNICAL"],
      index: true,
    },
    category: { type: String, index: true },
    tags: [String],
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    isActive: { type: Boolean, default: true, index: true },
    useCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Compound indexes
SupportTicketSchema.index({ userId: 1, status: 1, createdAt: -1 });
SupportTicketSchema.index({ driverId: 1, status: 1, createdAt: -1 });
SupportTicketSchema.index({ status: 1, priority: 1, createdAt: -1 });
SupportTicketSchema.index({ type: 1, status: 1, createdAt: -1 });
SupportTicketSchema.index({ slaDueAt: 1, status: 1 });
SupportMessageSchema.index({ ticketId: 1, createdAt: 1 });
SupportMessageSchema.index({ ticketId: 1, channel: 1, createdAt: 1 });

export const SupportTicket = mongoose.model<ISupportTicket>(
  "SupportTicket",
  SupportTicketSchema,
);
export const SupportMessage = mongoose.model<ISupportMessage>(
  "SupportMessage",
  SupportMessageSchema,
);
export const SupportQuickReply = mongoose.model<ISupportQuickReply>(
  "SupportQuickReply",
  SupportQuickReplySchema,
);
