import { Request, Response } from "express";
import ChatQuickReply, { seedChatQuickReplies } from "../../models/chat-quick-reply.model";

/**
 * Admin: the predefined chat lines drivers and customers can tap to send.
 * Stored as one list per audience; the apps fetch them on demand, so an edit
 * here is live without an app release.
 */
export const getQuickReplies = async (_req: Request, res: Response) => {
  if ((await ChatQuickReply.countDocuments({})) === 0) await seedChatQuickReplies();
  const rows = await ChatQuickReply.find({}).sort({ audience: 1, sortOrder: 1, createdAt: 1 }).lean();
  res.locals.data = {
    DRIVER: rows.filter((r) => r.audience === "DRIVER"),
    USER: rows.filter((r) => r.audience === "USER"),
  };
};

/**
 * PUT /admin/chat/quick-replies  { audience: "DRIVER"|"USER", lines: string[] }
 * The list becomes exactly `lines` in that order: present lines are upserted
 * and re-ordered, missing ones are switched off (kept for history).
 */
export const replaceQuickReplies = async (req: Request, res: Response) => {
  const audience = String(req.body?.audience || "").toUpperCase();
  if (audience !== "DRIVER" && audience !== "USER") {
    return res.status(400).json({ success: false, message: "audience must be DRIVER or USER" });
  }
  const raw = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const lines: string[] = [];
  for (const l of raw) {
    const t = String(l ?? "").trim().slice(0, 160);
    if (t && !lines.some((x) => x.toLowerCase() === t.toLowerCase())) lines.push(t);
  }
  if (lines.length > 30) {
    return res.status(400).json({ success: false, message: "Keep it to 30 lines per side" });
  }

  const existing = await ChatQuickReply.find({ audience }).lean();
  const keep = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const match = existing.find((e) => e.text.toLowerCase() === lines[i].toLowerCase());
    if (match) {
      keep.add(String(match._id));
      await ChatQuickReply.updateOne({ _id: match._id }, { $set: { text: lines[i], sortOrder: (i + 1) * 10, isActive: true } });
    } else {
      const created = await ChatQuickReply.create({ audience, text: lines[i], sortOrder: (i + 1) * 10, isActive: true });
      keep.add(String(created._id));
    }
  }
  await ChatQuickReply.updateMany(
    { audience, _id: { $nin: Array.from(keep) } },
    { $set: { isActive: false } },
  );

  const rows = await ChatQuickReply.find({ audience, isActive: true }).sort({ sortOrder: 1 }).lean();
  res.locals.data = { audience, replies: rows };
  res.locals.message = `${rows.length} quick replies saved for ${audience === "DRIVER" ? "drivers" : "customers"}.`;
};
