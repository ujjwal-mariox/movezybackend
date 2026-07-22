import { Request, Response } from "express";
import { Content } from "../../models/content.model";

/**
 * Legal / informational content management (Terms, Privacy, About, Refund,
 * Cancellation). The Content model and its seeded placeholders have existed
 * since the beginning; these are the first endpoints that let anyone read or
 * edit them — the admin CMS pages were pure mock with dead Save buttons.
 */

const EDITABLE_TYPES = [
  "TERMS",
  "PRIVACY",
  "ABOUT",
  "REFUND",
  "CANCELLATION",
] as const;

/**
 * GET /admin/content
 * One row per type (English), newest version of each.
 */
export const listContent = async (req: Request, res: Response) => {
  const contents = await Content.find({
    type: { $in: EDITABLE_TYPES },
    language: "en",
  })
    .sort({ type: 1, version: -1 })
    .populate("updatedBy", "name email")
    .lean();

  // Keep only the newest version per type.
  const seen = new Set<string>();
  const latest = contents.filter((c: any) => {
    if (seen.has(c.type)) return false;
    seen.add(c.type);
    return true;
  });

  res.locals.data = { contents: latest };
};

/**
 * GET /admin/content/:type
 */
export const getContentByType = async (req: Request, res: Response) => {
  const type = String(req.params.type || "").toUpperCase();
  if (!EDITABLE_TYPES.includes(type as any)) {
    return res
      .status(400)
      .json({ success: false, message: `Unknown content type: ${type}` });
  }

  const content = await Content.findOne({ type, language: "en" })
    .sort({ version: -1 })
    .populate("updatedBy", "name email")
    .lean();

  res.locals.data = { content };
};

/**
 * PUT /admin/content/:type
 * Body: { title, content }
 * Updates in place, bumps the version, stamps publishedAt and the editor.
 */
export const updateContent = async (req: Request, res: Response) => {
  const type = String(req.params.type || "").toUpperCase();
  if (!EDITABLE_TYPES.includes(type as any)) {
    return res
      .status(400)
      .json({ success: false, message: `Unknown content type: ${type}` });
  }

  const { title, content } = req.body;
  if (!title?.trim() || !content?.trim()) {
    return res
      .status(400)
      .json({ success: false, message: "Title and content are required" });
  }

  const updated = await Content.findOneAndUpdate(
    { type, language: "en" },
    {
      $set: {
        title: String(title).trim(),
        content: String(content),
        isActive: true,
        publishedAt: new Date(),
        updatedBy: (req as any).adminId,
      },
      $inc: { version: 1 },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );

  res.locals.data = { message: "Content published", content: updated };
};

/**
 * GET /content/:type — PUBLIC, no auth.
 * Serves the live legal text to the apps, so terms/privacy links can stop
 * pointing at hardcoded strings.
 */
export const getPublicContent = async (req: Request, res: Response) => {
  const type = String(req.params.type || "").toUpperCase();
  if (!EDITABLE_TYPES.includes(type as any)) {
    return res
      .status(404)
      .json({ success: false, message: "Content not found" });
  }

  const content = await Content.findOne({ type, language: "en", isActive: true })
    .sort({ version: -1 })
    .select("type title content version publishedAt updatedAt")
    .lean();

  if (!content) {
    return res
      .status(404)
      .json({ success: false, message: "Content not found" });
  }

  res.locals.data = { content };
};
