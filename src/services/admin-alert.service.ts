import { Types } from "mongoose";
import AdminAlert, { IAdminAlert } from "../models/admin-alert.model";
import { Admin } from "../models/admin.model";
import { PERMISSIONS } from "../models/role.model";
import { getIO } from "../utils/socket.util";

/**
 * Sections that raise admin alerts, keyed by the admin sidebar id, with the
 * permissions that open that page. Same gates as the admin's
 * SIDEBAR_PERMISSION_MAP, so "role-based access" means: you get the alerts of
 * the pages your role can already open, nothing to configure separately.
 */
export const ALERT_SECTIONS: Record<string, string[]> = {
  orders: [PERMISSIONS.BOOKINGS_VIEW],
  sos: [PERMISSIONS.SOS_VIEW],
  support: [PERMISSIONS.SUPPORT_VIEW],
  "website-enquiries": [PERMISSIONS.SUPPORT_VIEW],
  riders: [PERMISSIONS.DRIVERS_VIEW],
  compliance: [PERMISSIONS.DRIVERS_VIEW],
  payouts: [PERMISSIONS.FINANCE_VIEW],
  enterprises: [PERMISSIONS.ENTERPRISES_VIEW],
};

const isSuperAdmin = (admin: { roleName?: string; role?: string; permissions?: string[] }) =>
  admin.roleName === "Super Admin" ||
  admin.role === "SUPER_ADMIN" ||
  (admin.permissions || []).includes("all");

/** The alert sections an admin (as attached by verifyAdminToken) may see. */
export const sectionsFor = (admin: { roleName?: string; role?: string; permissions?: string[] }): string[] => {
  if (isSuperAdmin(admin)) return Object.keys(ALERT_SECTIONS);
  const perms = admin.permissions || [];
  return Object.entries(ALERT_SECTIONS)
    .filter(([, need]) => need.some((p) => perms.includes(p)))
    .map(([section]) => section);
};

/** Same, from an admin id (the socket handshake only has the id). */
export const sectionsForAdminId = async (adminId: string): Promise<string[]> => {
  if (!Types.ObjectId.isValid(adminId)) return [];
  const admin: any = await Admin.findById(adminId)
    .select("roleName role permissions customPermissions roleId isActive")
    .populate("roleId", "name permissions")
    .lean();
  if (!admin || admin.isActive === false) return [];
  const role = admin.roleId || {};
  return sectionsFor({
    roleName: role.name || admin.roleName,
    role: admin.role,
    permissions: [...(role.permissions || []), ...(admin.customPermissions || []), ...(admin.permissions || [])],
  });
};

export const sectionRoom = (section: string) => `admin:section:${section}`;

export interface AdminAlertInput {
  section: keyof typeof ALERT_SECTIONS | string;
  type: string;
  title: string;
  message?: string;
  link?: string;
  entityId?: string;
  severity?: IAdminAlert["severity"];
  /**
   * Fold a repeat of the same type + entity within this many minutes into the
   * existing alert (bumped to the top, unread again) instead of stacking rows
   * — e.g. a customer sending five replies on one ticket.
   */
  foldMinutes?: number;
}

/**
 * Raise an alert for every admin whose role can open `section`, and push it to
 * their open panels. Never throws: an alert is a side effect and must not fail
 * the booking, ticket or payout that triggered it.
 */
export const notifyAdmins = async (input: AdminAlertInput): Promise<void> => {
  try {
    if (!ALERT_SECTIONS[input.section]) return;
    const fields = {
      section: input.section,
      type: input.type,
      severity: input.severity || "info",
      title: input.title.slice(0, 200),
      message: input.message ? input.message.slice(0, 400) : undefined,
      link: input.link || `/admin/${input.section}`,
      entityId: input.entityId,
      readBy: [],
      at: new Date(),
    };

    let alert: any = null;
    if (input.foldMinutes && input.entityId) {
      alert = await AdminAlert.findOneAndUpdate(
        {
          type: input.type,
          entityId: input.entityId,
          at: { $gte: new Date(Date.now() - input.foldMinutes * 60_000) },
        },
        { $set: fields },
        { new: true, sort: { at: -1 } },
      ).lean();
    }
    if (!alert) alert = (await AdminAlert.create(fields)).toObject();

    try {
      getIO()
        ?.to(sectionRoom(input.section))
        .emit("admin:alert", present(alert, null));
    } catch {
      // Socket server not up (scripts, tests): the feed still has it.
    }
  } catch (e: any) {
    console.error("[admin-alert] could not record alert:", e?.message);
  }
};

export const present = (a: any, adminId: string | null) => ({
  _id: String(a._id),
  section: a.section,
  type: a.type,
  severity: a.severity,
  title: a.title,
  message: a.message || "",
  link: a.link || `/admin/${a.section}`,
  entityId: a.entityId || null,
  at: a.at,
  read: adminId ? (a.readBy || []).some((id: any) => String(id) === adminId) : false,
});

/** "₹1,234" for alert text. */
export const rupees = (n: unknown) =>
  `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/** "Ravi Kumar · +91 98xxxxxx10" style label for a partner, for alert text. */
export const partnerName = async (driverId: unknown): Promise<string> => {
  try {
    const { default: Driver } = await import("../models/driver.model");
    const d: any = await Driver.findById(String(driverId)).select("fullName mobileNumber").lean();
    if (!d) return "Partner";
    return [d.fullName, d.mobileNumber].filter(Boolean).join(" · ") || "Partner";
  } catch {
    return "Partner";
  }
};

/** First part of a long address, for one-line alert text. */
export const shortAddress = (a: unknown) =>
  String(a || "").split(",").slice(0, 2).join(",").trim().slice(0, 60);
