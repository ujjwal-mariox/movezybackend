import mongoose, { Schema, Types } from "mongoose";

export interface IAdmin {
  _id: Types.ObjectId;
  fullName: string;
  email: string;
  password: string;
  phone?: string;
  roleId: Types.ObjectId; // Reference to Role model
  roleName?: string; // Cached role name for quick access
  permissions: string[]; // Computed from role + custom overrides
  customPermissions?: string[]; // Additional permissions beyond role
  profileImage?: string;
  isActive: boolean;
  isDeleted: boolean;
  lastLogin?: Date;
  passwordChangedAt?: Date;
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
  createdBy?: Types.ObjectId;
  // IP Whitelisting — empty array means no restriction
  ipWhitelist?: string[];
  // Time-restricted access
  accessTimeRestriction?: {
    enabled: boolean;
    startHour: number; // 0-23
    endHour: number;   // 0-23
    timezone: string;  // e.g. "Asia/Kolkata"
  };
  // Field-level permissions
  fieldPermissions?: {
    module: string;
    readOnlyFields?: string[];
    hiddenFields?: string[];
  }[];
}

export interface IAdminSession {
  _id: Types.ObjectId;
  adminId: Types.ObjectId;
  token: string;
  ipAddress: string;
  userAgent: string;
  expiresAt: Date;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

// Admin Schema
const AdminSchema = new Schema<IAdmin>(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    phone: String,
    roleId: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      required: true,
      index: true,
    },
    roleName: {
      type: String,
      index: true,
    },
    permissions: {
      type: [String],
      default: [],
    },
    customPermissions: {
      type: [String],
      default: [],
    },
    profileImage: String,
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    lastLogin: Date,
    passwordChangedAt: Date,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    ipWhitelist: {
      type: [String],
      default: [],
    },
    accessTimeRestriction: {
      enabled: { type: Boolean, default: false },
      startHour: { type: Number, default: 0 },
      endHour: { type: Number, default: 23 },
      timezone: { type: String, default: "Asia/Kolkata" },
    },
    fieldPermissions: [
      {
        module: String,
        readOnlyFields: [String],
        hiddenFields: [String],
      },
    ],
  },
  { timestamps: true },
);

// Admin Session Schema
const AdminSessionSchema = new Schema<IAdminSession>(
  {
    adminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      index: true,
    },
    ipAddress: String,
    userAgent: String,
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// Compound indexes
AdminSchema.index({ email: 1, isDeleted: 1 });
AdminSessionSchema.index({ adminId: 1, isActive: 1 });

export const Admin = mongoose.model<IAdmin>("Admin", AdminSchema);
export const AdminSession = mongoose.model<IAdminSession>(
  "AdminSession",
  AdminSessionSchema,
);
