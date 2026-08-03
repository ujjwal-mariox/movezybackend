import mongoose, { Schema, Types } from "mongoose";

export interface INotification {
  _id: Types.ObjectId;
  userId?: Types.ObjectId;
  driverId?: Types.ObjectId;
  title: string;
  body: string;
  type: "BOOKING" | "PAYMENT" | "PROMO" | "SYSTEM" | "CHAT" | "REWARD";
  data?: Record<string, any>;
  isRead: boolean;
  isSent: boolean;
  sentAt?: Date;
  readAt?: Date;
}

export type NotificationAudience = "ALL" | "USERS" | "DRIVERS" | "ENTERPRISES";

export interface IPushTemplate {
  _id: Types.ObjectId;
  name: string;
  code: string;
  title: string;
  body: string;
  type: "BOOKING" | "PAYMENT" | "PROMO" | "SYSTEM" | "CHAT" | "REWARD";
  audience: NotificationAudience;
  variables: string[];
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  tags: string[];
  isActive: boolean;
  useCount: number;
}

export interface INotificationCampaign {
  _id: Types.ObjectId;
  title: string;
  body: string;
  type: "BOOKING" | "PAYMENT" | "PROMO" | "SYSTEM" | "CHAT" | "REWARD";
  audience: NotificationAudience;
  templateId?: Types.ObjectId;
  targetedCount: number;
  /**
   * How many of the targeted recipients actually had a push token, i.e. the
   * most pushes this campaign could ever have delivered. Without it a campaign
   * with 5,000 targeted / 0 sent is indistinguishable from a delivery failure —
   * it usually means nobody has registered a device.
   */
  pushTargetedCount: number;
  sentCount: number;
  readCount: number;
  failedCount: number;
  status: "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "FAILED";
  scheduledAt?: Date;
  sentAt?: Date;
  createdBy?: Types.ObjectId;
  data?: Record<string, any>;
}

// Notification Schema
const NotificationSchema = new Schema<INotification>(
  {
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
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["BOOKING", "PAYMENT", "PROMO", "SYSTEM", "CHAT", "REWARD"],
      required: true,
      index: true,
    },
    data: {
      type: Schema.Types.Mixed,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    isSent: {
      type: Boolean,
      default: false,
    },
    sentAt: Date,
    readAt: Date,
  },
  { timestamps: true },
);

// Push Template Schema
const PushTemplateSchema = new Schema<IPushTemplate>(
  {
    name: {
      type: String,
      required: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["BOOKING", "PAYMENT", "PROMO", "SYSTEM", "CHAT", "REWARD"],
      required: true,
      index: true,
    },
    audience: {
      type: String,
      enum: ["ALL", "USERS", "DRIVERS", "ENTERPRISES"],
      default: "ALL",
      index: true,
    },
    variables: [String],
    priority: {
      type: String,
      enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
      default: "NORMAL",
    },
    tags: [String],
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    useCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

// Notification Campaign Schema — tracks broadcast sends + analytics
const NotificationCampaignSchema = new Schema<INotificationCampaign>(
  {
    title: { type: String, required: true },
    body: { type: String, required: true },
    type: {
      type: String,
      enum: ["BOOKING", "PAYMENT", "PROMO", "SYSTEM", "CHAT", "REWARD"],
      required: true,
      index: true,
    },
    audience: {
      type: String,
      enum: ["ALL", "USERS", "DRIVERS", "ENTERPRISES"],
      required: true,
      index: true,
    },
    templateId: { type: Schema.Types.ObjectId, ref: "PushTemplate" },
    targetedCount: { type: Number, default: 0 },
    // Recipients that had a push token — see INotificationCampaign.
    pushTargetedCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    readCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "SCHEDULED", "SENDING", "SENT", "FAILED"],
      default: "DRAFT",
      index: true,
    },
    scheduledAt: Date,
    sentAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    data: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Compound indexes
NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
NotificationSchema.index({ driverId: 1, isRead: 1, createdAt: -1 });
NotificationSchema.index({ type: 1, createdAt: -1 });
NotificationCampaignSchema.index({ createdAt: -1 });
NotificationCampaignSchema.index({ status: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>(
  "Notification",
  NotificationSchema,
);
export const PushTemplate = mongoose.model<IPushTemplate>(
  "PushTemplate",
  PushTemplateSchema,
);
export const NotificationCampaign = mongoose.model<INotificationCampaign>(
  "NotificationCampaign",
  NotificationCampaignSchema,
);
