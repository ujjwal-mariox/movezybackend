import mongoose, { Schema, Types } from "mongoose";

export type AuditImpactLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface IAuditLog {
  _id: Types.ObjectId;
  adminId: Types.ObjectId;
  adminName: string;
  adminEmail: string;
  adminRole?: string;
  action: string;
  module: string;
  targetId?: string;
  targetType?: string;
  description: string;
  changes?: {
    field: string;
    oldValue: any;
    newValue: any;
  }[];
  before?: Record<string, any>;
  after?: Record<string, any>;
  impactLevel?: AuditImpactLevel;
  device?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
  revertedFromId?: Types.ObjectId;
  revertedAt?: Date;
  revertedBy?: Types.ObjectId;
  createdAt: Date;
}

export const deriveImpactLevel = (action: string): AuditImpactLevel => {
  switch ((action || "").toUpperCase()) {
    case "DELETE":
    case "BLOCK":
    case "CONFIG_CHANGE":
    case "REFUND":
    case "RESET_PASSWORD":
      return "CRITICAL";
    case "UPDATE":
    case "REJECT":
    case "APPROVE":
    case "UNBLOCK":
    case "SUSPEND":
    case "CHANGE_ROLE":
    case "CHANGE_STATUS":
      return "HIGH";
    case "CREATE":
    case "VERIFY":
    case "EXPORT":
    case "ASSIGN":
    case "RESOLVE":
    case "SEND_NOTIFICATION":
      return "MEDIUM";
    default:
      return "LOW";
  }
};

const AuditLogSchema = new Schema<IAuditLog>(
  {
    adminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
      index: true,
    },
    adminName: { type: String, required: true },
    adminEmail: { type: String, required: true },
    adminRole: { type: String },
    action: {
      type: String,
      required: true,
      enum: [
        "CREATE",
        "UPDATE",
        "DELETE",
        "BLOCK",
        "UNBLOCK",
        "APPROVE",
        "REJECT",
        "SUSPEND",
        "VERIFY",
        "LOGIN",
        "LOGOUT",
        "EXPORT",
        "REFUND",
        "ASSIGN",
        "RESOLVE",
        "SEND_NOTIFICATION",
        "CHANGE_STATUS",
        "CHANGE_ROLE",
        "RESET_PASSWORD",
        "CONFIG_CHANGE",
      ],
      index: true,
    },
    module: {
      type: String,
      required: true,
      enum: [
        "auth",
        "users",
        "drivers",
        "bookings",
        "payments",
        "promos",
        "enterprises",
        "sos",
        "support",
        "staff",
        "roles",
        "settings",
        "vehicles",
        "notifications",
        "reports",
        "automation",
      ],
      index: true,
    },
    targetId: { type: String, index: true },
    targetType: String,
    description: { type: String, required: true },
    changes: [
      {
        field: String,
        oldValue: Schema.Types.Mixed,
        newValue: Schema.Types.Mixed,
      },
    ],
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    impactLevel: {
      type: String,
      enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
      index: true,
    },
    device: String,
    ipAddress: String,
    userAgent: String,
    metadata: Schema.Types.Mixed,
    revertedFromId: { type: Schema.Types.ObjectId, ref: "AuditLog" },
    revertedAt: Date,
    revertedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true },
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ module: 1, action: 1, createdAt: -1 });
AuditLogSchema.index({ impactLevel: 1, createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
export default AuditLog;
