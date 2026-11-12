import { Request, Response } from "express";
import { Types } from "mongoose";
import AdminAlert from "../../models/admin-alert.model";
import { present, sectionsFor } from "../../services/admin-alert.service";

/**
 * The admin alert feed (bell + sidebar counts). Every query is limited to the
 * sections the signed-in admin's role can open.
 */
const scope = (req: Request) => {
  const admin: any = (req as any).admin || {};
  const adminId = String(admin._id || (req as any).adminId || "");
  return { adminId, sections: sectionsFor(admin) };
};

const unreadFilter = (adminId: string) =>
  Types.ObjectId.isValid(adminId)
    ? { readBy: { $ne: new Types.ObjectId(adminId) } }
    : {};

/** GET /admin/alerts?section=&unread=1&limit= */
export const listAlerts = async (req: Request, res: Response) => {
  const { adminId, sections } = scope(req);
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const wanted = req.query.section ? String(req.query.section) : null;
  const allowed = wanted ? sections.filter((s) => s === wanted) : sections;

  const filter: any = { section: { $in: allowed } };
  if (String(req.query.unread || "") === "1") Object.assign(filter, unreadFilter(adminId));

  const rows = allowed.length
    ? await AdminAlert.find(filter).sort({ at: -1 }).limit(limit).lean()
    : [];
  res.locals.data = { alerts: rows.map((a) => present(a, adminId)), sections };
};

/** GET /admin/alerts/counts — unread per section, plus the total. */
export const alertCounts = async (req: Request, res: Response) => {
  const { adminId, sections } = scope(req);
  const counts: Record<string, number> = {};
  for (const s of sections) counts[s] = 0;
  if (sections.length) {
    const rows = await AdminAlert.aggregate([
      { $match: { section: { $in: sections }, ...unreadFilter(adminId) } },
      { $group: { _id: "$section", n: { $sum: 1 } } },
    ]);
    for (const r of rows) counts[r._id] = r.n;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  res.locals.data = { counts, total, sections };
};

/**
 * PUT /admin/alerts/read — body { ids?: string[], section?: string, all?: true }.
 * Marks read for THIS admin only; colleagues keep their own unread state.
 */
export const markAlertsRead = async (req: Request, res: Response) => {
  const { adminId, sections } = scope(req);
  if (!Types.ObjectId.isValid(adminId)) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }
  const body = req.body || {};
  const filter: any = { section: { $in: sections }, ...unreadFilter(adminId) };

  if (Array.isArray(body.ids) && body.ids.length) {
    filter._id = { $in: body.ids.filter((id: any) => Types.ObjectId.isValid(String(id))) };
  } else if (body.section) {
    if (!sections.includes(String(body.section))) {
      res.locals.data = { updated: 0 };
      return;
    }
    filter.section = String(body.section);
  } else if (body.all !== true) {
    return res.status(400).json({ success: false, message: "Nothing to mark as read." });
  }

  const out = await AdminAlert.updateMany(filter, {
    $addToSet: { readBy: new Types.ObjectId(adminId) },
  });
  res.locals.data = { updated: out.modifiedCount || 0 };
};
