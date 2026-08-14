import { Request, Response } from "express";
import { FAQ } from "../../models/content.model";
import { cache } from "../../utils/redis.util";
import { auditFromRequest } from "./audit-log.controller";

/**
 * Admin CRUD for the Help & Support FAQs.
 *
 * The customer/driver apps have always read FAQs from the database
 * (support.controller getFAQs, cached per category), but nothing could WRITE
 * them — the only way to change an answer was a manual DB edit. This closes
 * that gap.
 *
 * Every write invalidates both the all-FAQs cache and the touched categories'
 * caches; getFAQs caches for an hour, so without this an edit would take up to
 * an hour to reach the apps and look broken to the admin who made it.
 */

const invalidate = async (...categories: (string | undefined)[]) => {
  await cache.del("faqs:all");
  for (const c of categories) {
    if (c) await cache.del(`faqs:${c}`);
  }
};

/** GET /admin/faqs — everything, inactive included, for management. */
export const listFaqs = async (req: Request, res: Response) => {
  const { category } = req.query;
  const query: any = {};
  if (category) query.category = category;
  const faqs = await FAQ.find(query).sort({ category: 1, sortOrder: 1 }).lean();
  const categories = await FAQ.distinct("category");
  res.locals.data = { faqs, categories, total: faqs.length };
};

/** POST /admin/faqs */
export const createFaq = async (req: Request, res: Response) => {
  const { question, answer, category, sortOrder, language } = req.body;
  if (!question || !answer || !category) {
    return res.status(400).json({
      success: false,
      message: "question, answer and category are required",
    });
  }
  const faq = await FAQ.create({
    question: String(question).trim(),
    answer: String(answer).trim(),
    category: String(category).trim(),
    sortOrder: Number(sortOrder) || 0,
    language: language || "en",
    isActive: true,
  });
  await invalidate(faq.category);
  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "cms",
    description: `Created FAQ "${faq.question.slice(0, 60)}" in ${faq.category}`,
    targetType: "FAQ",
    targetId: String(faq._id),
  });
  res.locals.data = { faq };
};

/** PUT /admin/faqs/:id */
export const updateFaq = async (req: Request, res: Response) => {
  const { id } = req.params;
  const faq = await FAQ.findById(id);
  if (!faq) {
    return res.status(404).json({ success: false, message: "FAQ not found" });
  }
  const previousCategory = faq.category;

  const { question, answer, category, sortOrder, isActive, language } =
    req.body;
  if (question !== undefined) faq.question = String(question).trim();
  if (answer !== undefined) faq.answer = String(answer).trim();
  if (category !== undefined) faq.category = String(category).trim();
  if (sortOrder !== undefined) faq.sortOrder = Number(sortOrder) || 0;
  if (isActive !== undefined) faq.isActive = !!isActive;
  if (language !== undefined) faq.language = language;
  await faq.save();

  // Both the old and new category caches go stale on a move.
  await invalidate(previousCategory, faq.category);
  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "cms",
    description: `Updated FAQ "${faq.question.slice(0, 60)}" (active=${faq.isActive})`,
    targetType: "FAQ",
    targetId: String(faq._id),
  });
  res.locals.data = { faq };
};

/** DELETE /admin/faqs/:id */
export const deleteFaq = async (req: Request, res: Response) => {
  const { id } = req.params;
  const faq = await FAQ.findByIdAndDelete(id);
  if (!faq) {
    return res.status(404).json({ success: false, message: "FAQ not found" });
  }
  await invalidate(faq.category);
  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "cms",
    description: `Deleted FAQ "${faq.question.slice(0, 60)}"`,
    targetType: "FAQ",
    targetId: String(faq._id),
  });
  res.locals.data = { message: "FAQ deleted" };
};
