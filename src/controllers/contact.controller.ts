import { Request, Response } from "express";
import ContactMessage from "../models/contact-message.model";
import { AppConfig } from "../models/app-config.model";
import { isEmailConfigured, sendEmail } from "../services/email.service";
import config from "../config";

/**
 * POST /contact — the website's contact form.
 *
 * Validates, drops obvious bots (honeypot field, absurd lengths), stores the
 * message, then emails the team (the address in Settings → contact email,
 * falling back to EMAIL_FROM) and acknowledges the sender. Email failures are
 * recorded on the row, never surfaced as a failure to the visitor — the
 * message is already safe in the database.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const teamInbox = async (): Promise<string | null> => {
  const rows = await AppConfig.find({ key: { $in: ["general.contact_email", "SUPPORT_EMAIL"] } })
    .select("key value")
    .lean();
  const byKey: Record<string, string> = {};
  for (const r of rows as any[]) byKey[r.key] = String(r.value || "").trim();
  return byKey.SUPPORT_EMAIL || byKey["general.contact_email"] || config.email.from || null;
};

export const submitContact = async (req: Request, res: Response) => {
  const body = req.body || {};
  // Honeypot: real people never see this field.
  if (String(body.website || "").trim()) {
    res.locals.data = { received: true };
    return;
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const phone = String(body.phone || "").replace(/[^\d+ ]/g, "").trim();
  const subject = String(body.subject || "General enquiry").trim().slice(0, 120);
  const message = String(body.message || "").trim();

  if (name.length < 2 || name.length > 120) {
    return res.status(400).json({ success: false, message: "Please enter your name." });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, message: "Please enter a valid email address." });
  }
  if (message.length < 10 || message.length > 4000) {
    return res.status(400).json({ success: false, message: "Please write a message of at least 10 characters." });
  }

  const row = await ContactMessage.create({
    name,
    email,
    phone: phone || undefined,
    subject,
    message,
    source: String(body.source || "website").slice(0, 40),
    ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip,
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
  });

  let emailedToTeam = false;
  let acknowledged = false;
  if (isEmailConfigured()) {
    const inbox = await teamInbox();
    const safe = {
      name: escapeHtml(name),
      email: escapeHtml(email),
      phone: escapeHtml(phone),
      subject: escapeHtml(subject),
      message: escapeHtml(message).replace(/\n/g, "<br/>"),
    };
    if (inbox) {
      emailedToTeam = await sendEmail({
        to: inbox,
        subject: `[Movezy website] ${subject} — ${name}`,
        text: `From: ${name} <${email}>${phone ? ` (${phone})` : ""}\nSubject: ${subject}\n\n${message}\n\nReference: ${row._id}`,
        html: `<p><strong>From:</strong> ${safe.name} &lt;${safe.email}&gt;${safe.phone ? ` (${safe.phone})` : ""}<br/><strong>Subject:</strong> ${safe.subject}</p><p>${safe.message}</p><p style="color:#6b7280;font-size:12px">Reference ${row._id}</p>`,
      });
    }
    acknowledged = await sendEmail({
      to: email,
      subject: "We received your message — Movezy",
      text: `Hi ${name},\n\nThanks for writing to Movezy. We've received your message about "${subject}" and will reply within one working day.\n\nYour message:\n${message}\n\n— Team Movezy`,
      html: `<p>Hi ${safe.name},</p><p>Thanks for writing to Movezy. We've received your message about "<strong>${safe.subject}</strong>" and will reply within one working day.</p><blockquote style="border-left:3px solid #FF6200;margin:0;padding:8px 12px;color:#374151">${safe.message}</blockquote><p>— Team Movezy</p>`,
    });
    if (emailedToTeam || acknowledged) {
      await ContactMessage.updateOne({ _id: row._id }, { $set: { emailedToTeam, acknowledged } });
    }
  }

  res.locals.data = { received: true, reference: String(row._id), emailed: emailedToTeam, acknowledged };
  res.locals.message = "Thanks — we'll get back to you within one working day.";
};
