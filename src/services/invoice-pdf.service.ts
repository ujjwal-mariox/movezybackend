import PDFDocument from "pdfkit";
import { IInvoice } from "../models/invoice.model";

/**
 * Invoice PDF rendering.
 *
 * Kept separate from invoice.service so the money math and the presentation
 * stay independent — this module only formats what it is handed.
 */

const INK = "#1F2937";
const MUTED = "#6B7280";
const RULE = "#E5E7EB";
const BRAND = "#EE6A2C";

const PAGE_MARGIN = 50;
const CONTENT_WIDTH = 595.28 - PAGE_MARGIN * 2; // A4 width minus margins

/** ₹ is not in PDFKit's built-in WinAnsi fonts, so use "Rs." rather than a tofu box. */
const money = (n: number): string =>
  `Rs. ${Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatDate = (d?: Date): string => {
  if (!d) return "-";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

interface InvoicePdfInput {
  invoice: IInvoice;
  /** Populated booking, if available — used for route/customer detail only. */
  booking?: any;
}

/** One label/amount line. `negative` renders discounts as "- Rs. x". */
const row = (
  doc: PDFKit.PDFDocument,
  label: string,
  amount: number,
  opts: { bold?: boolean; negative?: boolean } = {},
) => {
  const y = doc.y;
  doc
    .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(10)
    .fillColor(opts.bold ? INK : MUTED)
    .text(label, PAGE_MARGIN, y, { width: CONTENT_WIDTH - 120 });

  doc
    .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
    .fillColor(opts.bold ? INK : MUTED)
    .text(
      `${opts.negative ? "- " : ""}${money(amount)}`,
      PAGE_MARGIN + CONTENT_WIDTH - 120,
      y,
      { width: 120, align: "right" },
    );

  doc.moveDown(0.45);
};

const rule = (doc: PDFKit.PDFDocument) => {
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y)
    .strokeColor(RULE)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.6);
};

/**
 * Render an invoice to a PDF buffer.
 *
 * Only non-zero charge lines are printed, so a simple trip doesn't show a wall
 * of "Rs. 0.00" rows.
 */
export const renderInvoicePdf = async ({
  invoice,
  booking,
}: InvoicePdfInput): Promise<Buffer> => {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Header
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor(BRAND)
    .text("MOVEZY", PAGE_MARGIN, PAGE_MARGIN);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text("Goods delivery & logistics");

  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor(INK)
    .text("TAX INVOICE", PAGE_MARGIN, PAGE_MARGIN, {
      width: CONTENT_WIDTH,
      align: "right",
    });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(invoice.invoiceNumber, { width: CONTENT_WIDTH, align: "right" })
    .text(formatDate(invoice.generatedAt), {
      width: CONTENT_WIDTH,
      align: "right",
    });

  doc.moveDown(2);
  doc.x = PAGE_MARGIN;
  rule(doc);

  // Parties
  const user = booking?.userId;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text("Billed to");
  doc.font("Helvetica").fontSize(10).fillColor(MUTED);
  doc.text(user?.fullName || "Customer");
  if (user?.mobileNumber) doc.text(String(user.mobileNumber));
  if (invoice.customerGstin) doc.text(`GSTIN: ${invoice.customerGstin}`);
  doc.moveDown(0.5);
  doc.text(`Company GSTIN: ${invoice.companyGstin}`);
  doc.moveDown(0.8);

  // Trip
  if (booking) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text("Trip");
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    if (booking.bookingNumber) doc.text(`Booking: ${booking.bookingNumber}`);
    if (booking.pickup?.address) doc.text(`From: ${booking.pickup.address}`);
    if (booking.drop?.address) doc.text(`To: ${booking.drop.address}`);
    if (booking.completedAt)
      doc.text(`Completed: ${formatDate(booking.completedAt)}`);
    doc.moveDown(0.8);
  }

  rule(doc);

  // Charges — only what actually applies to this trip.
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text("Charges");
  doc.moveDown(0.5);

  const charges: [string, number][] = [
    ["Base fare", invoice.baseFare],
    ["Distance charge", invoice.distanceCharge],
    ["Time charge", invoice.timeCharge],
    ["Surge charge", invoice.surgeCharge],
    ["Add-ons", invoice.addonCharges],
    ["Loading / unloading", invoice.loadingUnloadingCharge],
    ["Waiting charge", invoice.waitingCharge],
    ["Toll charges", invoice.tollCharges],
  ];
  charges
    .filter(([, amount]) => Number(amount) > 0)
    .forEach(([label, amount]) => row(doc, label, amount));

  doc.moveDown(0.2);
  row(doc, "Subtotal", invoice.subtotal, { bold: true });

  const discounts: [string, number][] = [
    ["Promo discount", invoice.promoDiscount],
    ["Coin discount", invoice.coinDiscount],
    ["Enterprise discount", invoice.enterpriseDiscount],
  ];
  const anyDiscount = discounts.some(([, a]) => Number(a) > 0);
  if (anyDiscount) {
    doc.moveDown(0.2);
    discounts
      .filter(([, amount]) => Number(amount) > 0)
      .forEach(([label, amount]) => row(doc, label, amount, { negative: true }));
  }

  if (Number(invoice.totalTax) > 0) {
    row(doc, `GST (${invoice.gstPercentage || 5}%)`, invoice.totalTax);
  }

  doc.moveDown(0.3);
  rule(doc);
  row(doc, "Total", invoice.grandTotal, { bold: true });

  // Status
  doc.moveDown(0.6);
  const paid = invoice.status === "PAID";
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(paid ? "#10B981" : BRAND)
    .text(
      paid ? `PAID${invoice.paidAt ? ` on ${formatDate(invoice.paidAt)}` : ""}` : invoice.status,
      PAGE_MARGIN,
      doc.y,
      { width: CONTENT_WIDTH, align: "right" },
    );

  // Footer
  doc.moveDown(2);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      "This is a computer-generated invoice and does not require a signature.",
      PAGE_MARGIN,
      doc.y,
      { width: CONTENT_WIDTH, align: "center" },
    );

  doc.end();
  return done;
};

export default { renderInvoicePdf };
