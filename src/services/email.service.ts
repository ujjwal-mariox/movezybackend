/**
 * Transactional email integration point.
 *
 * SMTP is intentionally NOT wired to a concrete transport here (no nodemailer
 * dependency is installed), mirroring how SMS is handled in sos.service. When
 * SMTP_* env vars are set, plug the real transport into `deliver()` below —
 * until then email is logged (dev-safe) and never faked as "sent".
 *
 * isEmailConfigured() lets callers gate behaviour honestly.
 */
import config from "../config";

export const isEmailConfigured = (): boolean =>
  Boolean(config.email.host && config.email.user && config.email.password);

interface EmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Actually deliver an email. Returns true only when a real send succeeded.
 *
 * INTEGRATION POINT: when isEmailConfigured() is true, send via SMTP here, e.g.
 *   const nodemailer = require("nodemailer");
 *   const transport = nodemailer.createTransport({ host, port, auth: { user, pass } });
 *   await transport.sendMail({ from, to, subject, html, text });
 * Install nodemailer first (npm i nodemailer @types/nodemailer).
 */
export const sendEmail = async (input: EmailInput): Promise<boolean> => {
  if (!isEmailConfigured()) {
    // Dev / unconfigured: log instead of pretending to send.
    console.log(
      `📧 [email:unconfigured] To=${input.to} | Subject="${input.subject}"\n${input.text || input.html}`,
    );
    return false;
  }

  try {
    // Real SMTP transport goes here once nodemailer is installed & SMTP_* set.
    // Kept as a no-op-with-honest-return so the app builds without the dep.
    console.warn(
      "[email] SMTP is configured but no transport is wired yet — install nodemailer and implement deliver().",
    );
    return false;
  } catch (err) {
    console.error("[email] send failed:", err);
    return false;
  }
};

/**
 * Send the admin password-reset email. Returns whether it was actually sent.
 * The reset link points at the admin panel's reset route with the raw token.
 */
export const sendAdminPasswordReset = async (
  to: string,
  rawToken: string,
): Promise<boolean> => {
  const link = `${config.email.adminBaseUrl.replace(/\/$/, "")}/reset-password?token=${rawToken}`;
  const subject = "Reset your Movezy admin password";
  const text = `You requested a password reset. Use this link within 1 hour:\n${link}\n\nIf you didn't request this, ignore this email.`;
  const html = `
    <p>You requested a password reset for your Movezy admin account.</p>
    <p><a href="${link}">Reset your password</a> (valid for 1 hour).</p>
    <p>If you didn't request this, you can safely ignore this email.</p>
  `;

  return sendEmail({ to, subject, html, text });
};
