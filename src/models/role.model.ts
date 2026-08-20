import mongoose, { Schema, Types } from "mongoose";

// Define all available permissions in the system
export const PERMISSIONS = {
  // Dashboard
  DASHBOARD_VIEW: "dashboard:view",

  // User Management
  USERS_VIEW: "users:view",
  USERS_CREATE: "users:create",
  USERS_UPDATE: "users:update",
  USERS_DELETE: "users:delete",
  USERS_BLOCK: "users:block",

  // Driver Management
  DRIVERS_VIEW: "drivers:view",
  DRIVERS_CREATE: "drivers:create",
  DRIVERS_UPDATE: "drivers:update",
  DRIVERS_DELETE: "drivers:delete",
  DRIVERS_VERIFY: "drivers:verify",
  DRIVERS_BLOCK: "drivers:block",

  // Vehicle Management
  VEHICLES_VIEW: "vehicles:view",
  VEHICLES_CREATE: "vehicles:create",
  VEHICLES_UPDATE: "vehicles:update",
  VEHICLES_DELETE: "vehicles:delete",

  // Booking/Order Management
  BOOKINGS_VIEW: "bookings:view",
  BOOKINGS_CREATE: "bookings:create",
  BOOKINGS_UPDATE: "bookings:update",
  BOOKINGS_CANCEL: "bookings:cancel",
  BOOKINGS_REFUND: "bookings:refund",

  // Payment Management
  PAYMENTS_VIEW: "payments:view",
  PAYMENTS_PROCESS: "payments:process",
  PAYMENTS_REFUND: "payments:refund",

  // Promo Management
  PROMOS_VIEW: "promos:view",
  PROMOS_CREATE: "promos:create",
  PROMOS_UPDATE: "promos:update",
  PROMOS_DELETE: "promos:delete",

  // Enterprise Management
  ENTERPRISES_VIEW: "enterprises:view",
  ENTERPRISES_CREATE: "enterprises:create",
  ENTERPRISES_UPDATE: "enterprises:update",
  ENTERPRISES_APPROVE: "enterprises:approve",
  ENTERPRISES_SUSPEND: "enterprises:suspend",

  // SOS/Emergency
  SOS_VIEW: "sos:view",
  SOS_RESPOND: "sos:respond",
  SOS_RESOLVE: "sos:resolve",

  // Tracking
  TRACKING_VIEW: "tracking:view",

  // Notifications
  NOTIFICATIONS_VIEW: "notifications:view",
  NOTIFICATIONS_SEND: "notifications:send",

  // Support Tickets
  SUPPORT_VIEW: "support:view",
  SUPPORT_RESPOND: "support:respond",
  SUPPORT_RESOLVE: "support:resolve",
  SUPPORT_ASSIGN: "support:assign",

  // Staff Management
  STAFF_VIEW: "staff:view",
  STAFF_CREATE: "staff:create",
  STAFF_UPDATE: "staff:update",
  STAFF_DELETE: "staff:delete",

  // Role Management
  ROLES_VIEW: "roles:view",
  ROLES_CREATE: "roles:create",
  ROLES_UPDATE: "roles:update",
  ROLES_DELETE: "roles:delete",

  // Settings
  SETTINGS_VIEW: "settings:view",
  SETTINGS_UPDATE: "settings:update",

  // Reports
  REPORTS_VIEW: "reports:view",
  REPORTS_EXPORT: "reports:export",

  // Pricing / Fare Config
  PRICING_VIEW: "pricing:view",
  PRICING_UPDATE: "pricing:update",

  // Automation Rules
  AUTOMATION_VIEW: "automation:view",
  AUTOMATION_MANAGE: "automation:manage",

  // Audit Logs
  AUDIT_VIEW: "audit:view",

  // Finance Module
  FINANCE_VIEW: "finance:view",
  FINANCE_EXPORT: "finance:export",
  // Paying money out needs its own gate. Every payout mutation — driver
  // payouts AND customer coin cash-outs — was gated on FINANCE_VIEW, the
  // same read-only permission as the finance overview, so any role that
  // could look at revenue could also disburse funds to itself.
  PAYOUTS_CREATE: "payouts:create",
  PAYOUTS_APPROVE: "payouts:approve",
  PAYOUTS_PAY: "payouts:pay",

  // Driver Instructions
  DRIVER_INSTRUCTIONS_VIEW: "driver-instructions:view",
  DRIVER_INSTRUCTIONS_CREATE: "driver-instructions:create",
  DRIVER_INSTRUCTIONS_UPDATE: "driver-instructions:update",
  DRIVER_INSTRUCTIONS_DELETE: "driver-instructions:delete",

  // Badges
  BADGES_VIEW: "badges:view",
  BADGES_CREATE: "badges:create",
  BADGES_UPDATE: "badges:update",
  BADGES_DELETE: "badges:delete",

  // Training Materials
  TRAINING_VIEW: "training:view",
  TRAINING_CREATE: "training:create",
  TRAINING_UPDATE: "training:update",
  TRAINING_DELETE: "training:delete",

  // Refund Management (Dual Approval)
  REFUNDS_VIEW: "refunds:view",
  REFUNDS_REQUEST: "refunds:request",
  REFUNDS_APPROVE_L1: "refunds:approve_l1",
  REFUNDS_APPROVE_L2: "refunds:approve_l2",
  REFUNDS_REJECT: "refunds:reject",
  REFUNDS_PROCESS: "refunds:process",

  // Expense Management
  EXPENSES_VIEW: "expenses:view",
  EXPENSES_CREATE: "expenses:create",
  EXPENSES_APPROVE: "expenses:approve",
  EXPENSES_DELETE: "expenses:delete",

  // Enterprise Credit Management
  ENTERPRISE_CREDIT_VIEW: "enterprise-credit:view",
  ENTERPRISE_CREDIT_ADJUST: "enterprise-credit:adjust",
  ENTERPRISE_CREDIT_LIMIT: "enterprise-credit:update_limit",

  // Session Management
  SESSIONS_VIEW: "sessions:view",
  SESSIONS_TERMINATE: "sessions:terminate",
  SESSIONS_CONFIG: "sessions:config",

  // COD Management
  COD_VIEW: "cod:view",
  COD_SETTLE: "cod:settle",
} as const;

// Group permissions by module for frontend display
export const PERMISSION_GROUPS = {
  Dashboard: [PERMISSIONS.DASHBOARD_VIEW],
  "User Management": [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.USERS_UPDATE,
    PERMISSIONS.USERS_DELETE,
    PERMISSIONS.USERS_BLOCK,
  ],
  "Driver Management": [
    PERMISSIONS.DRIVERS_VIEW,
    PERMISSIONS.DRIVERS_CREATE,
    PERMISSIONS.DRIVERS_UPDATE,
    PERMISSIONS.DRIVERS_DELETE,
    PERMISSIONS.DRIVERS_VERIFY,
    PERMISSIONS.DRIVERS_BLOCK,
  ],
  "Vehicle Management": [
    PERMISSIONS.VEHICLES_VIEW,
    PERMISSIONS.VEHICLES_CREATE,
    PERMISSIONS.VEHICLES_UPDATE,
    PERMISSIONS.VEHICLES_DELETE,
  ],
  "Booking Management": [
    PERMISSIONS.BOOKINGS_VIEW,
    PERMISSIONS.BOOKINGS_CREATE,
    PERMISSIONS.BOOKINGS_UPDATE,
    PERMISSIONS.BOOKINGS_CANCEL,
    PERMISSIONS.BOOKINGS_REFUND,
  ],
  "Payment Management": [
    PERMISSIONS.PAYMENTS_VIEW,
    PERMISSIONS.PAYMENTS_PROCESS,
    PERMISSIONS.PAYMENTS_REFUND,
  ],
  "Promo Management": [
    PERMISSIONS.PROMOS_VIEW,
    PERMISSIONS.PROMOS_CREATE,
    PERMISSIONS.PROMOS_UPDATE,
    PERMISSIONS.PROMOS_DELETE,
  ],
  "Enterprise Management": [
    PERMISSIONS.ENTERPRISES_VIEW,
    PERMISSIONS.ENTERPRISES_CREATE,
    PERMISSIONS.ENTERPRISES_UPDATE,
    PERMISSIONS.ENTERPRISES_APPROVE,
    // Enforced on PUT /enterprises/:id/suspend but was in no group, so the
    // role editor could not grant it to anyone.
    PERMISSIONS.ENTERPRISES_SUSPEND,
  ],
  "SOS/Emergency": [
    PERMISSIONS.SOS_VIEW,
    PERMISSIONS.SOS_RESPOND,
    PERMISSIONS.SOS_RESOLVE,
  ],
  Tracking: [PERMISSIONS.TRACKING_VIEW],
  Notifications: [
    PERMISSIONS.NOTIFICATIONS_VIEW,
    PERMISSIONS.NOTIFICATIONS_SEND,
  ],
  "Support Tickets": [
    PERMISSIONS.SUPPORT_VIEW,
    PERMISSIONS.SUPPORT_RESPOND,
    PERMISSIONS.SUPPORT_RESOLVE,
    // Enforced on the ticket-assign route and held by the seeded Support
    // Agent role, yet absent from every group — so it was ungrantable to any
    // new role through the panel.
    PERMISSIONS.SUPPORT_ASSIGN,
  ],
  "Staff Management": [
    PERMISSIONS.STAFF_VIEW,
    PERMISSIONS.STAFF_CREATE,
    PERMISSIONS.STAFF_UPDATE,
    PERMISSIONS.STAFF_DELETE,
  ],
  "Role Management": [
    PERMISSIONS.ROLES_VIEW,
    PERMISSIONS.ROLES_CREATE,
    PERMISSIONS.ROLES_UPDATE,
    PERMISSIONS.ROLES_DELETE,
  ],
  Settings: [PERMISSIONS.SETTINGS_VIEW, PERMISSIONS.SETTINGS_UPDATE],
  Reports: [PERMISSIONS.REPORTS_VIEW, PERMISSIONS.REPORTS_EXPORT],
  Pricing: [PERMISSIONS.PRICING_VIEW, PERMISSIONS.PRICING_UPDATE],
  Automation: [PERMISSIONS.AUTOMATION_VIEW, PERMISSIONS.AUTOMATION_MANAGE],
  "Audit Logs": [PERMISSIONS.AUDIT_VIEW],
  Finance: [
    PERMISSIONS.FINANCE_VIEW,
    PERMISSIONS.FINANCE_EXPORT,
    PERMISSIONS.PAYOUTS_CREATE,
    PERMISSIONS.PAYOUTS_APPROVE,
    PERMISSIONS.PAYOUTS_PAY,
  ],
  "Driver Instructions": [
    PERMISSIONS.DRIVER_INSTRUCTIONS_VIEW,
    PERMISSIONS.DRIVER_INSTRUCTIONS_CREATE,
    PERMISSIONS.DRIVER_INSTRUCTIONS_UPDATE,
    PERMISSIONS.DRIVER_INSTRUCTIONS_DELETE,
  ],
  Badges: [
    PERMISSIONS.BADGES_VIEW,
    PERMISSIONS.BADGES_CREATE,
    PERMISSIONS.BADGES_UPDATE,
    PERMISSIONS.BADGES_DELETE,
  ],
  "Training Materials": [
    PERMISSIONS.TRAINING_VIEW,
    PERMISSIONS.TRAINING_CREATE,
    PERMISSIONS.TRAINING_UPDATE,
    PERMISSIONS.TRAINING_DELETE,
  ],
  "Refund Management": [
    PERMISSIONS.REFUNDS_VIEW,
    PERMISSIONS.REFUNDS_REQUEST,
    PERMISSIONS.REFUNDS_APPROVE_L1,
    PERMISSIONS.REFUNDS_APPROVE_L2,
    PERMISSIONS.REFUNDS_REJECT,
    PERMISSIONS.REFUNDS_PROCESS,
  ],
  "Expense Management": [
    PERMISSIONS.EXPENSES_VIEW,
    PERMISSIONS.EXPENSES_CREATE,
    PERMISSIONS.EXPENSES_APPROVE,
    PERMISSIONS.EXPENSES_DELETE,
  ],
  "Enterprise Credit": [
    PERMISSIONS.ENTERPRISE_CREDIT_VIEW,
    PERMISSIONS.ENTERPRISE_CREDIT_ADJUST,
    PERMISSIONS.ENTERPRISE_CREDIT_LIMIT,
  ],
  "Session Management": [
    PERMISSIONS.SESSIONS_VIEW,
    PERMISSIONS.SESSIONS_TERMINATE,
    PERMISSIONS.SESSIONS_CONFIG,
  ],
  "COD Management": [
    PERMISSIONS.COD_VIEW,
    PERMISSIONS.COD_SETTLE,
  ],
};

// Sidebar modules mapping to permissions.
//
// This object is the single source of truth for the nav: login and /auth/me
// return the ids whose permissions the admin holds (admin-auth.controller), and
// the panel renders ONLY those for non-Super-Admins. Ten sidebar ids were
// missing from here — compliance, reports, commissions, cms, wallet,
// categories, addon-services, cancellation-reasons, audit-logs, automation — so
// those items were invisible to every staff member even when they held the
// matching permission (Document Compliance was unreachable from the nav for an
// Operations Manager with drivers:view). Each entry lists the permission that
// actually gates the page's own read endpoint, so an item never appears for
// someone who would then get a 403.
export const SIDEBAR_MODULES = {
  dashboard: [PERMISSIONS.DASHBOARD_VIEW],
  "app-users": [PERMISSIONS.USERS_VIEW],
  riders: [PERMISSIONS.DRIVERS_VIEW],
  // GET /admin/drivers — the compliance page's only request.
  compliance: [PERMISSIONS.DRIVERS_VIEW],
  "vehicle-management": [PERMISSIONS.VEHICLES_VIEW],
  orders: [PERMISSIONS.BOOKINGS_VIEW],
  payments: [PERMISSIONS.PAYMENTS_VIEW],
  // GET /wallet/admin/* (wallet.routes.ts) is gated on payments:view.
  wallet: [PERMISSIONS.PAYMENTS_VIEW],
  // GET /admin/reports/* is gated on reports:view.
  reports: [PERMISSIONS.REPORTS_VIEW],
  // Commission & Charges edits FareConfig via /admin/config/fare.
  commissions: [PERMISSIONS.SETTINGS_VIEW],
  // GET /admin/config/goods-types (delivery categories).
  categories: [PERMISSIONS.SETTINGS_VIEW],
  "addon-services": [PERMISSIONS.SETTINGS_VIEW],
  "cancellation-reasons": [PERMISSIONS.SETTINGS_VIEW],
  // Content & Policies — GET /admin/content.
  cms: [PERMISSIONS.SETTINGS_VIEW],
  "audit-logs": [PERMISSIONS.AUDIT_VIEW],
  automation: [PERMISSIONS.AUTOMATION_VIEW],
  enterprises: [PERMISSIONS.ENTERPRISES_VIEW],
  sos: [PERMISSIONS.SOS_VIEW],
  tracking: [PERMISSIONS.TRACKING_VIEW],
  notifications: [PERMISSIONS.NOTIFICATIONS_VIEW],
  promos: [PERMISSIONS.PROMOS_VIEW],
  support: [PERMISSIONS.SUPPORT_VIEW],
  staff: [PERMISSIONS.STAFF_VIEW],
  settings: [PERMISSIONS.SETTINGS_VIEW],
  "prohibited-items": [PERMISSIONS.SETTINGS_VIEW],
  "master-data": [PERMISSIONS.SETTINGS_VIEW],
  "driver-instructions": [PERMISSIONS.DRIVER_INSTRUCTIONS_VIEW],
  badges: [PERMISSIONS.BADGES_VIEW],
  training: [PERMISSIONS.TRAINING_VIEW],
  refunds: [PERMISSIONS.REFUNDS_VIEW],
  expenses: [PERMISSIONS.EXPENSES_VIEW],
  finance: [PERMISSIONS.FINANCE_VIEW],
  "enterprise-credit": [PERMISSIONS.ENTERPRISE_CREDIT_VIEW],
  sessions: [PERMISSIONS.SESSIONS_VIEW],
  "cod-management": [PERMISSIONS.COD_VIEW],
};

export interface IRole {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  permissions: string[];
  isSystem: boolean; // System roles can't be deleted
  isActive: boolean;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const RoleSchema = new Schema<IRole>(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    permissions: {
      type: [String],
      default: [],
      validate: {
        validator: function (permissions: string[]) {
          const allPermissions = Object.values(PERMISSIONS);
          return permissions.every((p) => allPermissions.includes(p as any));
        },
        message: "Invalid permission found",
      },
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
  },
  { timestamps: true },
);

// Index for faster lookups
RoleSchema.index({ name: 1 });
RoleSchema.index({ isActive: 1 });

export const Role = mongoose.model<IRole>("Role", RoleSchema);

// Default system roles
export const DEFAULT_ROLES = {
  SUPER_ADMIN: {
    name: "Super Admin",
    description: "Full access to all features",
    permissions: Object.values(PERMISSIONS),
    isSystem: true,
  },
  ADMIN: {
    name: "Admin",
    description: "Administrative access with most features",
    permissions: Object.values(PERMISSIONS).filter(
      (p) => !p.startsWith("roles:") && p !== PERMISSIONS.STAFF_DELETE,
    ),
    isSystem: true,
  },
  OPERATIONS_MANAGER: {
    name: "Operations Manager",
    description: "Operational management — can view revenue, edit pricing, suspend drivers",
    permissions: [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.USERS_UPDATE,
      PERMISSIONS.DRIVERS_VIEW,
      PERMISSIONS.DRIVERS_UPDATE,
      PERMISSIONS.DRIVERS_VERIFY,
      PERMISSIONS.DRIVERS_BLOCK,
      PERMISSIONS.VEHICLES_VIEW,
      PERMISSIONS.VEHICLES_UPDATE,
      PERMISSIONS.BOOKINGS_VIEW,
      PERMISSIONS.BOOKINGS_UPDATE,
      PERMISSIONS.BOOKINGS_CANCEL,
      PERMISSIONS.PAYMENTS_VIEW,
      PERMISSIONS.PROMOS_VIEW,
      PERMISSIONS.PROMOS_UPDATE,
      PERMISSIONS.SOS_VIEW,
      PERMISSIONS.SOS_RESPOND,
      PERMISSIONS.TRACKING_VIEW,
      PERMISSIONS.SUPPORT_VIEW,
      PERMISSIONS.SUPPORT_RESPOND,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.PRICING_VIEW,
      PERMISSIONS.PRICING_UPDATE,
      PERMISSIONS.SETTINGS_VIEW,
      PERMISSIONS.SETTINGS_UPDATE,
      PERMISSIONS.FINANCE_VIEW,
    ],
    isSystem: true,
  },
  SUPPORT_AGENT: {
    name: "Support Agent",
    description: "Customer support — view users/drivers/bookings, manage tickets & SOS",
    permissions: [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.DRIVERS_VIEW,
      PERMISSIONS.BOOKINGS_VIEW,
      PERMISSIONS.SOS_VIEW,
      PERMISSIONS.SOS_RESPOND,
      PERMISSIONS.SUPPORT_VIEW,
      PERMISSIONS.SUPPORT_RESPOND,
      PERMISSIONS.SUPPORT_RESOLVE,
      PERMISSIONS.SUPPORT_ASSIGN,
      PERMISSIONS.TRACKING_VIEW,
    ],
    isSystem: true,
  },
  FINANCE_MANAGER: {
    name: "Finance Manager",
    description: "Financial operations — view revenue, approve refunds, export data",
    permissions: [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.PAYMENTS_VIEW,
      PERMISSIONS.PAYMENTS_PROCESS,
      PERMISSIONS.PAYMENTS_REFUND,
      PERMISSIONS.BOOKINGS_VIEW,
      PERMISSIONS.BOOKINGS_REFUND,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.REPORTS_EXPORT,
      PERMISSIONS.ENTERPRISES_VIEW,
      PERMISSIONS.FINANCE_VIEW,
      PERMISSIONS.FINANCE_EXPORT,
      // Money-out. Deliberately NOT granted to Operations Manager.
      PERMISSIONS.PAYOUTS_CREATE,
      PERMISSIONS.PAYOUTS_APPROVE,
      PERMISSIONS.PAYOUTS_PAY,
      PERMISSIONS.AUDIT_VIEW,
    ],
    isSystem: true,
  },
};

export default Role;
