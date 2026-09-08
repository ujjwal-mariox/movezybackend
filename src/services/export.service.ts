import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import mongoose, { Types } from "mongoose";

/**
 * Server-side Excel / PDF export of every dataset the client audits.
 *
 * Each dataset is a function from a date range to flat rows with a fixed
 * column list; the two renderers below turn those rows into an .xlsx (exceljs)
 * or a paginated landscape-A4 .pdf (pdfkit). Money is exported as numbers, not
 * pre-formatted strings, so the auditor's own formulas work on the sheet.
 *
 * The "ledger" dataset is the one the auditors asked for: every money movement
 * the platform records — customer payments, driver settlements, payouts,
 * wallet credits/debits, refunds, expenses, coin cash-outs, enterprise credit
 * — in one chronological list with a debit/credit column from the platform's
 * point of view and the reference id of the source row, so any line can be
 * traced back to the record that produced it.
 */

export interface ExportColumn {
  key: string;
  header: string;
  width?: number;
  type?: "text" | "number" | "money" | "date";
}

export interface ExportDataset {
  key: string;
  title: string;
  /** Which permission gates it: money datasets need finance:export. */
  scope: "finance" | "ops";
  columns: ExportColumn[];
  rows: (range: DateRange) => Promise<Record<string, any>[]>;
}

export interface DateRange {
  from?: Date;
  to?: Date;
}

const db = () => {
  const d = mongoose.connection.db;
  if (!d) throw new Error("Database not connected");
  return d;
};

const rangeMatch = (field: string, r: DateRange): Record<string, any> => {
  const m: any = {};
  if (r.from) m.$gte = r.from;
  if (r.to) m.$lte = r.to;
  return Object.keys(m).length ? { [field]: m } : {};
};

const oid = (v: any): string => (v ? String(v) : "");
const iso = (d: any): string => (d ? new Date(d).toISOString() : "");

/** Populate-lite: id → display name maps for a batch of rows. */
const nameMap = async (
  collection: string,
  ids: any[],
  fields: string[],
): Promise<Map<string, any>> => {
  const clean = ids.filter(Boolean).map((i) => new Types.ObjectId(String(i)));
  if (!clean.length) return new Map();
  const proj: any = {};
  fields.forEach((f) => (proj[f] = 1));
  const docs = await db()
    .collection(collection)
    .find({ _id: { $in: clean } }, { projection: proj })
    .toArray();
  return new Map(docs.map((d: any) => [String(d._id), d]));
};

// ── Datasets ──────────────────────────────────────────────────────────────

const bookings: ExportDataset = {
  key: "bookings",
  title: "Bookings",
  scope: "finance",
  columns: [
    { key: "bookingNumber", header: "Booking #", width: 12 },
    { key: "createdAt", header: "Created", type: "date", width: 20 },
    { key: "status", header: "Status", width: 14 },
    { key: "customer", header: "Customer", width: 22 },
    { key: "customerPhone", header: "Customer phone", width: 14 },
    { key: "driver", header: "Driver", width: 22 },
    { key: "driverCode", header: "Driver ID", width: 10 },
    { key: "vehicleNumber", header: "Vehicle", width: 14 },
    { key: "vehicleType", header: "Vehicle type", width: 14 },
    { key: "pickup", header: "Pickup", width: 36 },
    { key: "drop", header: "Drop", width: 36 },
    { key: "distanceKm", header: "Km", type: "number", width: 8 },
    { key: "subtotal", header: "Subtotal", type: "money", width: 12 },
    { key: "gstAmount", header: "GST", type: "money", width: 10 },
    { key: "totalDiscount", header: "Discount", type: "money", width: 10 },
    { key: "finalFare", header: "Customer paid", type: "money", width: 13 },
    { key: "commissionAmount", header: "Commission", type: "money", width: 12 },
    { key: "driverEarnings", header: "Driver earnings", type: "money", width: 14 },
    { key: "paymentMethod", header: "Payment", width: 10 },
    { key: "paymentStatus", header: "Pay status", width: 11 },
    { key: "completedAt", header: "Completed", type: "date", width: 20 },
    { key: "cancelledAt", header: "Cancelled", type: "date", width: 20 },
  ],
  rows: async (r) => {
    const docs = await db()
      .collection("bookings")
      .find({ ...rangeMatch("createdAt", r) })
      .sort({ createdAt: 1 })
      .toArray();
    const users = await nameMap("users", docs.map((d: any) => d.userId), ["fullName", "mobileNumber"]);
    const drivers = await nameMap("drivers", docs.map((d: any) => d.driverId), ["fullName", "driverCode"]);
    const types = await nameMap("vehicletypes", docs.map((d: any) => d.vehicleTypeId), ["name"]);
    return docs.map((d: any) => ({
      bookingNumber: d.bookingNumber || oid(d._id),
      createdAt: d.createdAt,
      status: d.status,
      customer: users.get(oid(d.userId))?.fullName || "",
      customerPhone: users.get(oid(d.userId))?.mobileNumber || "",
      driver: drivers.get(oid(d.driverId))?.fullName || "",
      driverCode: drivers.get(oid(d.driverId))?.driverCode || "",
      vehicleNumber: d.vehicleNumber || "",
      vehicleType: types.get(oid(d.vehicleTypeId))?.name || "",
      pickup: d.pickup?.address || "",
      drop: d.drop?.address || "",
      distanceKm: d.distanceKm ?? "",
      subtotal: d.subtotal ?? 0,
      gstAmount: d.gstAmount ?? 0,
      totalDiscount: d.totalDiscount ?? 0,
      finalFare: d.finalFare ?? 0,
      commissionAmount: d.commissionAmount ?? "",
      driverEarnings: d.driverEarnings ?? "",
      paymentMethod: d.paymentMethod || "",
      paymentStatus: d.paymentStatus || "",
      completedAt: d.completedAt,
      cancelledAt: d.cancelledAt,
    }));
  },
};

const payouts: ExportDataset = {
  key: "payouts",
  title: "Driver payouts",
  scope: "finance",
  columns: [
    { key: "createdAt", header: "Requested", type: "date", width: 20 },
    { key: "driver", header: "Driver", width: 22 },
    { key: "driverCode", header: "Driver ID", width: 10 },
    { key: "amount", header: "Amount", type: "money", width: 12 },
    { key: "method", header: "Method", width: 8 },
    { key: "status", header: "Status", width: 10 },
    { key: "reference", header: "UTR / reference", width: 20 },
    { key: "requestedByType", header: "Requested by", width: 12 },
    { key: "approvedAt", header: "Approved", type: "date", width: 20 },
    { key: "paidAt", header: "Paid", type: "date", width: 20 },
    { key: "rejectionReason", header: "Rejection reason", width: 28 },
  ],
  rows: async (r) => {
    const docs = await db().collection("payouts").find({ ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    const drivers = await nameMap("drivers", docs.map((d: any) => d.driverId), ["fullName", "driverCode"]);
    return docs.map((d: any) => ({
      createdAt: d.createdAt,
      driver: drivers.get(oid(d.driverId))?.fullName || "",
      driverCode: drivers.get(oid(d.driverId))?.driverCode || "",
      amount: d.amount ?? 0,
      method: d.method || "",
      status: d.status || "",
      reference: d.reference || "",
      requestedByType: d.requestedByType || "",
      approvedAt: d.approvedAt,
      paidAt: d.paidAt,
      rejectionReason: d.rejectionReason || "",
    }));
  },
};

const walletTransactions: ExportDataset = {
  key: "wallet-transactions",
  title: "Wallet transactions",
  scope: "finance",
  columns: [
    { key: "createdAt", header: "Date", type: "date", width: 20 },
    { key: "party", header: "Account holder", width: 22 },
    { key: "partyType", header: "Type", width: 9 },
    { key: "type", header: "Txn type", width: 14 },
    { key: "amount", header: "Amount", type: "money", width: 12 },
    { key: "balanceAfter", header: "Balance after", type: "money", width: 13 },
    { key: "status", header: "Status", width: 10 },
    { key: "description", header: "Description", width: 36 },
    { key: "reference", header: "Reference", width: 24 },
  ],
  rows: async (r) => {
    const docs = await db().collection("wallettransactions").find({ ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    const ids = docs.map((d: any) => d.userId);
    const users = await nameMap("users", ids, ["fullName"]);
    const drivers = await nameMap("drivers", ids, ["fullName"]);
    return docs.map((d: any) => {
      const u = users.get(oid(d.userId));
      const dr = drivers.get(oid(d.userId));
      return {
        createdAt: d.createdAt,
        party: u?.fullName || dr?.fullName || oid(d.userId),
        partyType: u ? "Customer" : dr ? "Driver" : "",
        type: d.type || "",
        amount: d.amount ?? 0,
        balanceAfter: d.balanceAfter ?? "",
        status: d.status || "",
        description: d.description || "",
        reference: d.referenceId || d.reference || oid(d.bookingId) || "",
      };
    });
  },
};

const refunds: ExportDataset = {
  key: "refunds",
  title: "Refunds",
  scope: "finance",
  columns: [
    { key: "createdAt", header: "Requested", type: "date", width: 20 },
    { key: "bookingNumber", header: "Booking #", width: 12 },
    { key: "customer", header: "Customer", width: 22 },
    { key: "amount", header: "Amount", type: "money", width: 12 },
    { key: "reason", header: "Reason", width: 36 },
    { key: "status", header: "Status", width: 12 },
    { key: "processedAt", header: "Processed", type: "date", width: 20 },
  ],
  rows: async (r) => {
    const docs = await db().collection("refundrequests").find({ ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    const bookings = await nameMap("bookings", docs.map((d: any) => d.bookingId), ["bookingNumber", "userId"]);
    const users = await nameMap("users", [...bookings.values()].map((b: any) => b.userId).concat(docs.map((d: any) => d.userId)), ["fullName"]);
    return docs.map((d: any) => {
      const b = bookings.get(oid(d.bookingId));
      return {
        createdAt: d.createdAt,
        bookingNumber: b?.bookingNumber || oid(d.bookingId),
        customer: users.get(oid(d.userId || b?.userId))?.fullName || "",
        amount: d.amount ?? 0,
        reason: d.reason || "",
        status: d.status || "",
        processedAt: d.processedAt,
      };
    });
  },
};

const expenses: ExportDataset = {
  key: "expenses",
  title: "Expenses",
  scope: "finance",
  columns: [
    { key: "date", header: "Date", type: "date", width: 20 },
    { key: "category", header: "Category", width: 16 },
    { key: "description", header: "Description", width: 40 },
    { key: "amount", header: "Amount", type: "money", width: 12 },
    { key: "status", header: "Status", width: 10 },
    { key: "transactionId", header: "Transaction id", width: 22 },
  ],
  rows: async (r) => {
    const docs = await db().collection("expenses").find({ ...rangeMatch("date", r) }).sort({ date: 1 }).toArray();
    return docs.map((d: any) => ({
      date: d.date || d.createdAt,
      category: d.category || "",
      description: d.description || "",
      amount: d.amount ?? 0,
      status: d.status || "",
      transactionId: d.transactionId || "",
    }));
  },
};

const invoices: ExportDataset = {
  key: "invoices",
  title: "Invoices",
  scope: "finance",
  columns: [
    { key: "invoiceNumber", header: "Invoice #", width: 16 },
    { key: "createdAt", header: "Issued", type: "date", width: 20 },
    { key: "bookingNumber", header: "Booking #", width: 12 },
    { key: "customer", header: "Customer", width: 22 },
    { key: "enterprise", header: "Enterprise", width: 22 },
    { key: "totalAmount", header: "Total", type: "money", width: 12 },
    { key: "status", header: "Status", width: 12 },
  ],
  rows: async (r) => {
    const docs = await db().collection("invoices").find({ ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    const bookings = await nameMap("bookings", docs.map((d: any) => d.bookingId), ["bookingNumber"]);
    const users = await nameMap("users", docs.map((d: any) => d.userId), ["fullName"]);
    const ents = await nameMap("enterprises", docs.map((d: any) => d.enterpriseId), ["companyName", "name"]);
    return docs.map((d: any) => ({
      invoiceNumber: d.invoiceNumber || oid(d._id),
      createdAt: d.createdAt,
      bookingNumber: bookings.get(oid(d.bookingId))?.bookingNumber || "",
      customer: users.get(oid(d.userId))?.fullName || "",
      enterprise: ents.get(oid(d.enterpriseId))?.companyName || ents.get(oid(d.enterpriseId))?.name || "",
      totalAmount: d.totalAmount ?? d.finalAmount ?? d.amount ?? 0,
      status: d.status || "",
    }));
  },
};

const enterpriseCredit: ExportDataset = {
  key: "enterprise-credit",
  title: "Enterprise credit history",
  scope: "finance",
  columns: [
    { key: "createdAt", header: "Date", type: "date", width: 20 },
    { key: "enterprise", header: "Enterprise", width: 24 },
    { key: "type", header: "Type", width: 16 },
    { key: "amount", header: "Amount", type: "money", width: 12 },
    { key: "balanceAfter", header: "Balance after", type: "money", width: 13 },
    { key: "reference", header: "Reference", width: 24 },
  ],
  rows: async (r) => {
    const docs = await db().collection("credithistories").find({ ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    const ents = await nameMap("enterprises", docs.map((d: any) => d.enterpriseId), ["companyName", "name"]);
    return docs.map((d: any) => ({
      createdAt: d.createdAt,
      enterprise: ents.get(oid(d.enterpriseId))?.companyName || ents.get(oid(d.enterpriseId))?.name || oid(d.enterpriseId),
      type: d.type || "",
      amount: d.amount ?? 0,
      balanceAfter: d.balanceAfter ?? "",
      reference: oid(d.bookingId) || d.reference || d.note || "",
    }));
  },
};

const drivers: ExportDataset = {
  key: "drivers",
  title: "Drivers",
  scope: "ops",
  columns: [
    { key: "driverCode", header: "Driver ID", width: 10 },
    { key: "fullName", header: "Name", width: 22 },
    { key: "mobileNumber", header: "Phone", width: 13 },
    { key: "email", header: "Email", width: 24 },
    { key: "status", header: "Status", width: 16 },
    { key: "isOnline", header: "Online", width: 8 },
    { key: "rating", header: "Rating", type: "number", width: 8 },
    { key: "totalRides", header: "Trips", type: "number", width: 8 },
    { key: "vehicles", header: "Vehicles", width: 30 },
    { key: "documentBlocked", header: "Doc block", width: 10 },
    { key: "createdAt", header: "Joined", type: "date", width: 20 },
  ],
  rows: async (r) => {
    const docs = await db().collection("drivers").find({ isDeleted: { $ne: true }, ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    const vehicles = await db().collection("vehicles").find({ driverId: { $in: docs.map((d: any) => d._id) }, isDeleted: { $ne: true } }, { projection: { driverId: 1, vehicleNumber: 1, isPrimary: 1 } }).toArray();
    const byDriver = new Map<string, string[]>();
    for (const v of vehicles as any[]) {
      const k = oid(v.driverId);
      byDriver.set(k, [...(byDriver.get(k) || []), `${v.vehicleNumber}${v.isPrimary ? " (active)" : ""}`]);
    }
    return docs.map((d: any) => ({
      driverCode: d.driverCode || "",
      fullName: d.fullName || "",
      mobileNumber: d.mobileNumber || "",
      email: d.email || "",
      status: d.status || "",
      isOnline: d.isOnline ? "Yes" : "No",
      rating: d.rating ?? "",
      totalRides: d.totalRides ?? 0,
      vehicles: (byDriver.get(oid(d._id)) || []).join(", "),
      documentBlocked: d.documentBlock?.blocked ? "Yes" : "No",
      createdAt: d.createdAt,
    }));
  },
};

const vehicles: ExportDataset = {
  key: "vehicles",
  title: "Vehicles",
  scope: "ops",
  columns: [
    { key: "vehicleNumber", header: "Vehicle", width: 14 },
    { key: "driver", header: "Driver", width: 22 },
    { key: "driverCode", header: "Driver ID", width: 10 },
    { key: "vehicleType", header: "Type", width: 14 },
    { key: "vehicleBodyType", header: "Body", width: 10 },
    { key: "fuelType", header: "Fuel", width: 9 },
    { key: "city", header: "City", width: 12 },
    { key: "verificationStatus", header: "Verification", width: 16 },
    { key: "isPrimary", header: "Active", width: 8 },
    { key: "onboardingFeePaid", header: "Fee paid", width: 9 },
    { key: "rcExpiryDate", header: "RC expiry", type: "date", width: 12 },
    { key: "insuranceExpiryDate", header: "Insurance expiry", type: "date", width: 14 },
    { key: "pucExpiryDate", header: "PUC expiry", type: "date", width: 12 },
    { key: "blocked", header: "Doc block", width: 10 },
    { key: "createdAt", header: "Registered", type: "date", width: 20 },
  ],
  rows: async (r) => {
    const docs = await db().collection("vehicles").find({ isDeleted: { $ne: true }, ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    const drivers = await nameMap("drivers", docs.map((d: any) => d.driverId), ["fullName", "driverCode"]);
    const types = await nameMap("vehicletypes", docs.map((d: any) => d.vehicleTypeId), ["name"]);
    return docs.map((d: any) => ({
      vehicleNumber: d.vehicleNumber || "",
      driver: drivers.get(oid(d.driverId))?.fullName || "",
      driverCode: drivers.get(oid(d.driverId))?.driverCode || "",
      vehicleType: types.get(oid(d.vehicleTypeId))?.name || d.vehicleType || "",
      vehicleBodyType: d.vehicleBodyType || "",
      fuelType: d.fuelType || "",
      city: d.city || "",
      verificationStatus: d.verificationStatus || "",
      isPrimary: d.isPrimary ? "Yes" : "No",
      onboardingFeePaid: d.onboardingFeePaid ? "Yes" : "No",
      rcExpiryDate: d.rcExpiryDate,
      insuranceExpiryDate: d.insuranceExpiryDate,
      pucExpiryDate: d.pucExpiryDate,
      blocked: d.dispatchBlock?.blocked ? "Yes" : "No",
      createdAt: d.createdAt,
    }));
  },
};

const customers: ExportDataset = {
  key: "customers",
  title: "Customers",
  scope: "ops",
  columns: [
    { key: "userCode", header: "Customer ID", width: 11 },
    { key: "fullName", header: "Name", width: 22 },
    { key: "mobileNumber", header: "Phone", width: 13 },
    { key: "email", header: "Email", width: 24 },
    { key: "isActive", header: "Active", width: 8 },
    { key: "isBlocked", header: "Blocked", width: 8 },
    { key: "referralCode", header: "Referral code", width: 12 },
    { key: "createdAt", header: "Joined", type: "date", width: 20 },
  ],
  rows: async (r) => {
    const docs = await db().collection("users").find({ isDeleted: { $ne: true }, ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    return docs.map((d: any) => ({
      userCode: d.userCode || "",
      fullName: d.fullName || "",
      mobileNumber: d.mobileNumber || "",
      email: d.email || "",
      isActive: d.isActive === false ? "No" : "Yes",
      isBlocked: d.isBlocked ? "Yes" : "No",
      referralCode: d.referralCode || "",
      createdAt: d.createdAt,
    }));
  },
};

const tickets: ExportDataset = {
  key: "support-tickets",
  title: "Support tickets",
  scope: "ops",
  columns: [
    { key: "ticketId", header: "Ticket", width: 16 },
    { key: "createdAt", header: "Opened", type: "date", width: 20 },
    { key: "type", header: "Type", width: 10 },
    { key: "category", header: "Category", width: 14 },
    { key: "priority", header: "Priority", width: 9 },
    { key: "status", header: "Status", width: 14 },
    { key: "subject", header: "Subject", width: 36 },
    { key: "raisedBy", header: "Raised by", width: 22 },
    { key: "assignedTo", header: "Assigned to", width: 18 },
    { key: "resolvedAt", header: "Resolved", type: "date", width: 20 },
  ],
  rows: async (r) => {
    const docs = await db().collection("supporttickets").find({ ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    const users = await nameMap("users", docs.map((d: any) => d.userId), ["fullName"]);
    const drivers = await nameMap("drivers", docs.map((d: any) => d.driverId), ["fullName"]);
    return docs.map((d: any) => ({
      ticketId: d.ticketId || oid(d._id),
      createdAt: d.createdAt,
      type: d.type || "",
      category: d.category || "",
      priority: d.priority || "",
      status: d.status || "",
      subject: d.subject || "",
      raisedBy: users.get(oid(d.userId))?.fullName || drivers.get(oid(d.driverId))?.fullName || "",
      assignedTo: d.assignedStaffName || "",
      resolvedAt: d.resolvedAt,
    }));
  },
};

const auditLog: ExportDataset = {
  key: "audit-log",
  title: "Audit log",
  scope: "ops",
  columns: [
    { key: "createdAt", header: "When", type: "date", width: 20 },
    { key: "adminName", header: "Admin", width: 20 },
    { key: "adminEmail", header: "Admin email", width: 24 },
    { key: "action", header: "Action", width: 14 },
    { key: "module", header: "Module", width: 12 },
    { key: "targetType", header: "Target", width: 12 },
    { key: "targetId", header: "Target id", width: 26 },
    { key: "description", header: "Description", width: 48 },
    { key: "ipAddress", header: "IP", width: 14 },
  ],
  rows: async (r) => {
    const docs = await db().collection("auditlogs").find({ ...rangeMatch("createdAt", r) }).sort({ createdAt: 1 }).toArray();
    return docs.map((d: any) => ({
      createdAt: d.createdAt,
      adminName: d.adminName || "",
      adminEmail: d.adminEmail || "",
      action: d.action || "",
      module: d.module || "",
      targetType: d.targetType || "",
      targetId: d.targetId || "",
      description: d.description || "",
      ipAddress: d.ipAddress || "",
    }));
  },
};

/**
 * The combined ledger. One row per money movement, chronological.
 * `debit` = money leaving the platform (payouts, refunds, expenses, coin
 * cash-outs, driver earnings owed); `credit` = money coming in (customer
 * payments, commission, enterprise credit repayments). Both from the
 * platform's point of view, which is the view the auditor reconciles.
 */
const ledger: ExportDataset = {
  key: "ledger",
  title: "Ledger (all money movements)",
  scope: "finance",
  columns: [
    { key: "date", header: "Date", type: "date", width: 20 },
    { key: "entryType", header: "Entry", width: 20 },
    { key: "party", header: "Counterparty", width: 24 },
    { key: "partyType", header: "Party type", width: 11 },
    { key: "reference", header: "Reference", width: 22 },
    { key: "description", header: "Description", width: 40 },
    { key: "credit", header: "Credit (in)", type: "money", width: 13 },
    { key: "debit", header: "Debit (out)", type: "money", width: 13 },
    { key: "status", header: "Status", width: 12 },
    { key: "sourceId", header: "Source record id", width: 26 },
  ],
  rows: async (r) => {
    const rows: Record<string, any>[] = [];
    const D = db();

    const completed = await D.collection("bookings").find({ status: "COMPLETED", ...rangeMatch("completedAt", r) }).toArray();
    const users = await nameMap("users", completed.map((b: any) => b.userId), ["fullName"]);
    const drivers = await nameMap("drivers", completed.map((b: any) => b.driverId), ["fullName", "driverCode"]);
    for (const b of completed as any[]) {
      const ref = b.bookingNumber || oid(b._id);
      rows.push({ date: b.completedAt, entryType: "Customer payment", party: users.get(oid(b.userId))?.fullName || "", partyType: "Customer", reference: ref, description: `Trip fare incl. GST (${b.paymentMethod || ""})`, credit: b.finalFare ?? 0, debit: "", status: b.paymentStatus || "", sourceId: oid(b._id) });
      if (b.gstAmount) rows.push({ date: b.completedAt, entryType: "GST collected", party: "Government", partyType: "Tax", reference: ref, description: "GST on trip", credit: "", debit: b.gstAmount, status: "accrued", sourceId: oid(b._id) });
      if (b.driverEarnings != null) rows.push({ date: b.completedAt, entryType: "Driver earnings", party: drivers.get(oid(b.driverId))?.fullName || "", partyType: "Driver", reference: ref, description: `Settlement after ${b.commissionPercent ?? ""}% commission`, credit: "", debit: b.driverEarnings, status: "accrued", sourceId: oid(b._id) });
      if (b.commissionAmount != null) rows.push({ date: b.completedAt, entryType: "Commission earned", party: "Movezy", partyType: "Platform", reference: ref, description: "Platform commission", credit: b.commissionAmount, debit: "", status: "earned", sourceId: oid(b._id) });
      if (b.totalDiscount) rows.push({ date: b.completedAt, entryType: "Discount given", party: users.get(oid(b.userId))?.fullName || "", partyType: "Customer", reference: ref, description: "Promo / coins / campaign discount", credit: "", debit: b.totalDiscount, status: "marketing", sourceId: oid(b._id) });
    }

    const payoutDocs = await D.collection("payouts").find({ status: "PAID", ...rangeMatch("paidAt", r) }).toArray();
    const pd = await nameMap("drivers", payoutDocs.map((p: any) => p.driverId), ["fullName"]);
    for (const p of payoutDocs as any[]) rows.push({ date: p.paidAt || p.createdAt, entryType: "Driver payout", party: pd.get(oid(p.driverId))?.fullName || "", partyType: "Driver", reference: p.reference || "", description: `Payout via ${p.method || ""}`, credit: "", debit: p.amount ?? 0, status: p.status, sourceId: oid(p._id) });

    const wt = await D.collection("wallettransactions").find({ status: "COMPLETED", ...rangeMatch("createdAt", r) }).toArray();
    const wu = await nameMap("users", wt.map((t: any) => t.userId), ["fullName"]);
    const wd = await nameMap("drivers", wt.map((t: any) => t.userId), ["fullName"]);
    for (const t of wt as any[]) {
      const isCredit = /CREDIT|RECHARGE|REFUND|BONUS|CASHBACK|EARN/i.test(String(t.type || ""));
      rows.push({ date: t.createdAt, entryType: `Wallet ${t.type || ""}`, party: wu.get(oid(t.userId))?.fullName || wd.get(oid(t.userId))?.fullName || oid(t.userId), partyType: wu.has(oid(t.userId)) ? "Customer" : "Driver", reference: t.referenceId || oid(t.bookingId) || "", description: t.description || "", credit: isCredit ? "" : t.amount ?? 0, debit: isCredit ? t.amount ?? 0 : "", status: t.status, sourceId: oid(t._id) });
    }

    const rf = await D.collection("refundrequests").find({ status: "PROCESSED", ...rangeMatch("processedAt", r) }).toArray();
    const rb = await nameMap("bookings", rf.map((x: any) => x.bookingId), ["bookingNumber"]);
    for (const x of rf as any[]) rows.push({ date: x.processedAt || x.createdAt, entryType: "Refund", party: "", partyType: "Customer", reference: rb.get(oid(x.bookingId))?.bookingNumber || "", description: x.reason || "", credit: "", debit: x.amount ?? 0, status: x.status, sourceId: oid(x._id) });

    const ex = await D.collection("expenses").find({ status: { $in: ["PAID", "APPROVED"] }, ...rangeMatch("date", r) }).toArray();
    for (const e of ex as any[]) rows.push({ date: e.date || e.createdAt, entryType: `Expense: ${e.category || ""}`, party: "", partyType: "Vendor", reference: e.transactionId || "", description: e.description || "", credit: "", debit: e.amount ?? 0, status: e.status, sourceId: oid(e._id) });

    const cp = await D.collection("coinpayouts").find({ status: "PAID", ...rangeMatch("paidAt", r) }).toArray();
    const cu = await nameMap("users", cp.map((c: any) => c.userId), ["fullName"]);
    for (const c of cp as any[]) rows.push({ date: c.paidAt || c.createdAt, entryType: "Coin cash-out", party: cu.get(oid(c.userId))?.fullName || "", partyType: "Customer", reference: c.reference || "", description: "Coins converted to bank transfer", credit: "", debit: c.amount ?? 0, status: c.status, sourceId: oid(c._id) });

    const ch = await D.collection("credithistories").find({ ...rangeMatch("createdAt", r) }).toArray();
    const ce = await nameMap("enterprises", ch.map((c: any) => c.enterpriseId), ["companyName", "name"]);
    for (const c of ch as any[]) {
      const repaid = c.type === "CREDIT_REPAID";
      const used = c.type === "CREDIT_USED";
      if (!repaid && !used) continue;
      rows.push({ date: c.createdAt, entryType: repaid ? "Enterprise credit repaid" : "Enterprise credit used", party: ce.get(oid(c.enterpriseId))?.companyName || ce.get(oid(c.enterpriseId))?.name || "", partyType: "Enterprise", reference: oid(c.bookingId) || "", description: c.note || "", credit: repaid ? c.amount ?? 0 : "", debit: used ? c.amount ?? 0 : "", status: c.type, sourceId: oid(c._id) });
    }

    rows.sort((a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());
    return rows;
  },
};

export const DATASETS: Record<string, ExportDataset> = Object.fromEntries(
  [bookings, payouts, walletTransactions, refunds, expenses, invoices, enterpriseCredit, ledger, drivers, vehicles, customers, tickets, auditLog].map((d) => [d.key, d]),
);

// ── Renderers ─────────────────────────────────────────────────────────────

const cellValue = (col: ExportColumn, v: any): any => {
  if (v === null || v === undefined || v === "") return "";
  if (col.type === "date") return v instanceof Date ? v : new Date(v);
  if (col.type === "money" || col.type === "number") return typeof v === "number" ? v : Number(v);
  return String(v);
};

export const renderXlsx = async (
  dataset: ExportDataset,
  rows: Record<string, any>[],
  range: DateRange,
): Promise<Buffer> => {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Movezy Admin";
  wb.created = new Date();
  const ws = wb.addWorksheet(dataset.title.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = dataset.columns.map((c) => ({ key: c.key, header: c.header, width: c.width || 16 }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
  for (const r of rows) {
    const out: Record<string, any> = {};
    for (const c of dataset.columns) out[c.key] = cellValue(c, r[c.key]);
    ws.addRow(out);
  }
  dataset.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.type === "money") col.numFmt = "#,##0.00";
    if (c.type === "date") col.numFmt = "yyyy-mm-dd hh:mm";
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: dataset.columns.length } };
  const meta = wb.addWorksheet("About");
  meta.addRows([
    ["Dataset", dataset.title],
    ["Generated", new Date().toISOString()],
    ["From", range.from ? range.from.toISOString() : "(all time)"],
    ["To", range.to ? range.to.toISOString() : "(now)"],
    ["Rows", rows.length],
    ["Source", "Movezy backend — generated server-side from live records"],
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
};

const fmtCell = (col: ExportColumn, v: any): string => {
  if (v === null || v === undefined || v === "") return "";
  if (col.type === "date") {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().replace("T", " ").slice(0, 16);
  }
  if (col.type === "money") return Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(v);
};

export const renderPdf = async (
  dataset: ExportDataset,
  rows: Record<string, any>[],
  range: DateRange,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width - 56;
    const totalWeight = dataset.columns.reduce((s, c) => s + (c.width || 16), 0);
    const widths = dataset.columns.map((c) => ((c.width || 16) / totalWeight) * pageW);
    const rowH = 14;
    const money = (i: number) => dataset.columns[i].type === "money" || dataset.columns[i].type === "number";

    const header = () => {
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text(`Movezy — ${dataset.title}`, 28, 24);
      doc.font("Helvetica").fontSize(8).fillColor("#666").text(
        `Generated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC · ` +
          `${range.from ? range.from.toISOString().slice(0, 10) : "all time"} → ${range.to ? range.to.toISOString().slice(0, 10) : "now"} · ${rows.length} rows`,
        28, 42,
      );
      let x = 28;
      const y = 60;
      doc.rect(28, y - 2, pageW, rowH).fill("#EFEFEF");
      doc.fillColor("#111").font("Helvetica-Bold").fontSize(7);
      dataset.columns.forEach((c, i) => {
        doc.text(c.header, x + 2, y + 1, { width: widths[i] - 4, align: money(i) ? "right" : "left", lineBreak: false });
        x += widths[i];
      });
      doc.y = y + rowH + 2;
    };

    header();
    doc.font("Helvetica").fontSize(7).fillColor("#222");
    let y = doc.y;
    const bottom = doc.page.height - 30;
    rows.forEach((r, idx) => {
      if (y + rowH > bottom) {
        doc.addPage();
        header();
        doc.font("Helvetica").fontSize(7).fillColor("#222");
        y = doc.y;
      }
      if (idx % 2 === 1) doc.rect(28, y - 1, pageW, rowH).fill("#FAFAFA").fillColor("#222");
      let x = 28;
      dataset.columns.forEach((c, i) => {
        doc.text(fmtCell(c, r[c.key]), x + 2, y + 1, { width: widths[i] - 4, align: money(i) ? "right" : "left", lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      y += rowH;
    });

    // Totals line for money columns — what an auditor checks first.
    const totals = dataset.columns.map((c) =>
      c.type === "money" ? rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) : null,
    );
    if (totals.some((t) => t !== null)) {
      if (y + rowH * 2 > bottom) { doc.addPage(); header(); y = doc.y; }
      y += 4;
      doc.moveTo(28, y).lineTo(28 + pageW, y).strokeColor("#999").lineWidth(0.5).stroke();
      y += 3;
      let x = 28;
      doc.font("Helvetica-Bold").fontSize(7).fillColor("#111");
      dataset.columns.forEach((c, i) => {
        const t = totals[i];
        doc.text(i === 0 ? "TOTAL" : t === null ? "" : t.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), x + 2, y + 1, { width: widths[i] - 4, align: money(i) ? "right" : "left", lineBreak: false });
        x += widths[i];
      });
    }
    doc.end();
  });

export const parseRange = (q: any): DateRange => {
  const r: DateRange = {};
  if (q?.dateFrom) { const d = new Date(String(q.dateFrom)); if (!Number.isNaN(d.getTime())) { d.setHours(0, 0, 0, 0); r.from = d; } }
  if (q?.dateTo) { const d = new Date(String(q.dateTo)); if (!Number.isNaN(d.getTime())) { d.setHours(23, 59, 59, 999); r.to = d; } }
  return r;
};
