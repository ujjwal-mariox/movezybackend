import mongoose, { Schema, Types } from "mongoose";

/**
 * An in-panel alert for admin staff (client feedback, 2026-11-12): a new
 * booking, an SOS, a support reply, a partner waiting for verification...
 *
 * `section` is the admin sidebar id the alert belongs to. It decides who sees
 * it (an admin only gets alerts for sections their role can open, see
 * admin-alert.service) and which sidebar item shows the unread count.
 *
 * Not to be confused with `Notification`, which is the push/in-app message
 * sent TO customers and partners.
 */
export interface IAdminAlert {
  _id?: Types.ObjectId;
  section: string;
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message?: string;
  /** Admin route to open, e.g. "/admin/orders". */
  link?: string;
  entityId?: string;
  /** Admins who have read it. */
  readBy: Types.ObjectId[];
  /** When it last happened (bumped when a repeat is folded into it). */
  at: Date;
}

const AdminAlertSchema = new Schema<IAdminAlert>({
  section: { type: String, required: true, index: true },
  type: { type: String, required: true },
  severity: { type: String, enum: ["info", "warning", "critical"], default: "info" },
  title: { type: String, required: true, maxlength: 200 },
  message: { type: String, maxlength: 400 },
  link: String,
  entityId: String,
  readBy: { type: [Schema.Types.ObjectId], default: [] },
  at: { type: Date, default: Date.now },
});

AdminAlertSchema.index({ section: 1, at: -1 });
AdminAlertSchema.index({ type: 1, entityId: 1, at: -1 });
// Alerts are a working feed, not a record: drop them after 30 days.
AdminAlertSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model<IAdminAlert>("AdminAlert", AdminAlertSchema);
