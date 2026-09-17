import "dotenv/config";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import fs from "fs";
import connectDB from "../models";
import config from "../config";
import Booking from "../models/booking.model";
import Driver from "../models/driver.model";
import User from "../models/Users";
import VehicleType from "../models/vehicle-type.model";
import { Admin, AdminSession } from "../models/admin.model";

/**
 * QA pass against the running API from each role's point of view, using the
 * exact endpoints the apps call. Read-only apart from one short-lived admin
 * session row (tagged movezy-qa-script) and the audit-log entries the export
 * endpoints write by design.
 *
 *   npx ts-node src/scripts/qa-live-check.ts [--base URL] [--token-file PATH]
 *   npx ts-node src/scripts/qa-live-check.ts --cleanup   # deactivate QA admin sessions
 */
const args = process.argv.slice(2);
const opt = (k: string, d = "") => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? String(args[i + 1]) : d;
};
const BASE = opt("--base", "https://movezybackend.onrender.com/v1/api");
const TOKEN_FILE = opt("--token-file", "");
const QA_UA = "movezy-qa-script";

type Row = { id: string; area: string; check: string; status: "PASS" | "FAIL" | "INFO"; evidence: string };
const rows: Row[] = [];
const add = (id: string, area: string, check: string, status: Row["status"], evidence: string) => {
  rows.push({ id, area, check, status, evidence });
  console.log(`${status.padEnd(4)} ${id.padEnd(4)} ${check} — ${evidence}`);
};

async function call(path: string, token: string | null, init?: { method?: string; body?: any }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method: init?.method || "GET",
    headers,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) {
    const json: any = await res.json();
    return { status: res.status, ct, json, bytes: 0, buf: null as Buffer | null };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ct, json: null as any, bytes: buf.length, buf };
}
const dataOf = (j: any) => (j && typeof j === "object" && "data" in j ? j.data : j);
const firstArray = (d: any): any[] => {
  if (Array.isArray(d)) return d;
  if (d && typeof d === "object") for (const v of Object.values(d)) if (Array.isArray(v)) return v as any[];
  return [];
};
const idOf = (x: any) => String(x?.vehicleTypeId?._id ?? x?.vehicleTypeId ?? x?.vehicleType?._id ?? x?.vehicleType?.id ?? x?._id ?? x?.id ?? "");
const nameOf = (x: any) => x?.name ?? x?.vehicleType?.name ?? x?.vehicleTypeName ?? x?.title ?? "?";
const catOf = (x: any) => x?.categoryCode ?? x?.vehicleType?.categoryCode ?? x?.category ?? "?";
const bookingArrays = (d: any): Record<string, any[]> => {
  const out: Record<string, any[]> = {};
  const walk = (o: any, prefix: string, depth: number) => {
    if (!o || typeof o !== "object" || depth > 2) return;
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v) && v.some((x: any) => x && typeof x === "object" && ("bookingNumber" in x || "estimatedEarnings" in x))) out[prefix + k] = v as any[];
      else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, prefix + k + ".", depth + 1);
    }
  };
  walk(d, "", 0);
  return out;
};
const short = (v: any) => JSON.stringify(v)?.slice(0, 160);

(async () => {
  await connectDB();

  if (args.includes("--cleanup")) {
    const r = await AdminSession.updateMany({ userAgent: QA_UA, isActive: true }, { isActive: false });
    console.log(`deactivated ${r.modifiedCount} QA admin session(s)`);
    await mongoose.disconnect();
    return;
  }

  // ── subjects ────────────────────────────────────────────────────────────
  const booking: any = await Booking.findOne({ status: "COMPLETED", driverId: { $exists: true }, userId: { $exists: true } })
    .sort({ completedAt: -1, updatedAt: -1 })
    .lean();
  if (!booking) throw new Error("no completed booking to test with");
  const driver: any = await Driver.findById(booking.driverId).select("fullName status isActive isDeleted").lean();
  const user: any = await User.findById(booking.userId).select("fullName isActive").lean();
  const admin: any = await Admin.findOne({ isActive: true, isDeleted: false }).sort({ createdAt: 1 }).select("fullName email roleId").lean();
  if (!driver || !user || !admin) throw new Error(`missing subject: driver=${!!driver} user=${!!user} admin=${!!admin}`);
  console.log(`subjects: booking ${booking.bookingNumber} | driver ${driver.fullName} (${driver.status}) | customer ${user.fullName} | admin ${admin.email}\nbase: ${BASE}\n`);

  const secret = config.auth.jwtSecret;
  const driverToken = jwt.sign({ driverId: String(driver._id) }, secret, { expiresIn: "3h" });
  const userToken = jwt.sign({ userId: String(user._id) }, secret, { expiresIn: "3h" });
  const adminToken = jwt.sign({ adminId: String(admin._id), role: String(admin.roleId) }, secret, { expiresIn: "3h" });
  await AdminSession.create({
    adminId: admin._id,
    token: adminToken,
    userAgent: QA_UA,
    ipAddress: "qa",
    expiresAt: new Date(Date.now() + 3 * 3600 * 1000),
    isActive: true,
  });
  if (TOKEN_FILE) fs.writeFileSync(TOKEN_FILE, adminToken, "utf8");

  const step = async (id: string, area: string, check: string, fn: () => Promise<[Row["status"], string]>) => {
    try {
      const [s, e] = await fn();
      add(id, area, check, s, e);
    } catch (e: any) {
      add(id, area, check, "FAIL", `threw: ${e?.message || e}`);
    }
  };

  // ── driver app ──────────────────────────────────────────────────────────
  await step("D1", "Driver", "Dashboard loads (no 'Unable to load dashboard')", async () => {
    const r = await call("/driver/app/dashboard", driverToken);
    const d = dataOf(r.json);
    const arrays = bookingArrays(d);
    const all = Object.values(arrays).flat();
    const c = all.find((b: any) => b.customerTotal !== undefined) || all[0];
    const ok = r.status === 200 && d?.driver && (r.json?.code === 1 || r.json?.code === 200);
    return [ok ? "PASS" : "FAIL", `HTTP ${r.status} code ${r.json?.code} keys ${Object.keys(d || {}).join(",")} | commission ${d?.commissionPercent}% | lists ${Object.entries(arrays).map(([k, v]) => `${k}:${v.length}`).join(" ")} | sample booking: earnings ${c?.estimatedEarnings} customerTotal ${c?.customerTotal} gst ${c?.gstAmount} commission ${c?.commissionAmount} (${c?.commissionPercent}%)`];
  });
  await step("D2", "Driver", "Current booking endpoint", async () => {
    const r = await call("/driver/app/bookings/current", driverToken);
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} code ${r.json?.code} msg ${r.json?.message} data ${r.json?.data ? "booking" : "none"}`];
  });
  await step("D3", "Driver", "Recommended (offered) bookings endpoint", async () => {
    const r = await call("/driver/app/bookings/recommended", driverToken);
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} code ${r.json?.code} offers ${firstArray(dataOf(r.json)).length}`];
  });
  await step("D4", "Driver", "My vehicles: exactly one live vehicle", async () => {
    const r = await call("/driver/app/my-vehicles", driverToken);
    const list = firstArray(dataOf(r.json));
    const live = list.filter((v: any) => v.isPrimary || v.isActive);
    return [r.status === 200 && live.length <= 1 ? "PASS" : "FAIL", `HTTP ${r.status} vehicles ${list.length} live ${live.length}: ${list.map((v: any) => `${v.vehicleNumber} ${v.isPrimary || v.isActive ? "LIVE" : "idle"} ${v.verificationStatus || ""}`).join("; ")}`];
  });
  await step("D5", "Driver", "Earnings scoped to the active vehicle", async () => {
    const r = await call("/driver/app/earnings", driverToken);
    const d = dataOf(r.json);
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} keys ${Object.keys(d || {}).slice(0, 12).join(",")} ${d?.activeVehicleId ? "activeVehicleId " + d.activeVehicleId : ""}`];
  });
  await step("D6", "Driver", "Quick replies for drivers include the client's phrases", async () => {
    // The driver app calls its own mount of this endpoint.
    const r = await call("/driver/app/chat/quick-replies", driverToken);
    const list = firstArray(dataOf(r.json)).map((x: any) => (typeof x === "string" ? x : x.text));
    const ok = list.includes("I am coming.") && list.includes("I am at the pickup point.");
    return [r.status === 200 && ok ? "PASS" : "FAIL", `HTTP ${r.status} ${list.length} replies: ${list.slice(0, 4).join(" | ")}`];
  });
  await step("D7", "Driver", "Support contact (in-trip call button source)", async () => {
    const r = await call("/support-contact", null);
    const d = dataOf(r.json);
    return [r.status === 200 ? (d?.supportPhone ? "PASS" : "INFO") : "FAIL", `HTTP ${r.status} supportPhone=${JSON.stringify(d?.supportPhone)} ${d?.supportPhone ? "" : "(blank → call option hidden until set in Admin › Support contact)"}`];
  });
  await step("D8", "Driver", "Booking history endpoint", async () => {
    const r = await call("/driver/app/bookings/history", driverToken);
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} rows ${firstArray(dataOf(r.json)).length}`];
  });

  // ── customer app ────────────────────────────────────────────────────────
  const pune = { lat: 18.5204, lng: 73.8567, address: "Shivajinagar, Pune", city: "Pune" };
  const baner = { lat: 18.559, lng: 73.7868, address: "Baner, Pune", city: "Pune" };
  const mumbai = { lat: 19.076, lng: 72.8777, address: "Mumbai", city: "Mumbai" };
  const types: any[] = await VehicleType.find({ isActive: true, isDeleted: { $ne: true } }).select("name categoryCode maxRangeKm").lean();
  const fourW = types.find((t) => t.categoryCode === "4W");
  let intra: any[] = [];
  await step("U1", "Customer", "Vehicle options (within city): all active types, selected one pinned first", async () => {
    const r = await call("/bookings/vehicle-options", userToken, {
      method: "POST",
      body: { serviceType: "WITHIN_CITY", pickup: pune, drop: baner, distanceKm: 12, durationMin: 30, preferredVehicleTypeId: String(fourW?._id || "") },
    });
    intra = firstArray(dataOf(r.json));
    const names = intra.map((v: any) => `${nameOf(v)}/${catOf(v)}`);
    const activeCount = types.filter((t) => !(t.maxRangeKm > 0 && 12 > t.maxRangeKm)).length;
    const pinned = intra[0] && fourW && idOf(intra[0]) === String(fourW._id);
    const ok = r.status === 200 && intra.length === activeCount && pinned;
    return [ok ? "PASS" : "FAIL", `HTTP ${r.status} ${intra.length}/${activeCount} types (${names.join(", ")}) | first=${nameOf(intra[0])} pinned=${pinned} (wanted ${fourW?.name}) | item keys ${Object.keys(intra[0] || {}).slice(0, 14).join(",")}`];
  });
  await step("U2", "Customer", "Vehicle options (outstation 150 km): no two-wheelers, other categories present", async () => {
    const r = await call("/bookings/vehicle-options", userToken, {
      method: "POST",
      body: { serviceType: "OUTSTATION", pickup: pune, drop: mumbai, distanceKm: 150, durationMin: 200 },
    });
    const list = firstArray(dataOf(r.json));
    const cats = new Set(list.map((v: any) => catOf(v)));
    const has2W = list.some((v: any) => catOf(v) === "2W");
    const excludedByRange = types.filter((t) => t.categoryCode !== "2W" && t.maxRangeKm > 0 && 150 > t.maxRangeKm).map((t) => `${t.name}(${t.maxRangeKm}km)`);
    return [r.status === 200 && !has2W && list.length > 0 ? "PASS" : "FAIL", `HTTP ${r.status} ${list.length} types, categories ${[...cats].join("/")}, 2W shown=${has2W}; hidden by max range: ${excludedByRange.join(", ") || "none"}`];
  });
  await step("U3", "Customer", "Time slots for scheduled pickup", async () => {
    const r = await call("/bookings/time-slots", userToken);
    const list = firstArray(dataOf(r.json));
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} ${list.length} slots e.g. ${list.slice(0, 3).map((s: any) => s.label || s.name || `${s.startTime}-${s.endTime}`).join(", ")}`];
  });
  await step("U4", "Customer", "Quick questions for customers include the client's phrases", async () => {
    const r = await call("/chat/quick-replies", userToken);
    const list = firstArray(dataOf(r.json)).map((x: any) => (typeof x === "string" ? x : x.text));
    const ok = list.includes("Are you coming?") && list.includes("I am waiting at the pickup point.");
    return [r.status === 200 && ok ? "PASS" : "FAIL", `HTTP ${r.status} ${list.length} replies: ${list.slice(0, 4).join(" | ")}`];
  });
  await step("U5", "Customer", "Completed booking detail: fare breakup incl. GST and total", async () => {
    const r = await call(`/bookings/${booking._id}`, userToken);
    const d = dataOf(r.json);
    const b = d?.booking || d;
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} ${b?.bookingNumber} status ${b?.status} subtotal ${b?.subtotal} gst ${b?.gstAmount} (${b?.gstPercentage}%) finalFare ${b?.finalFare} receiver ${b?.receiverName ? "yes" : "no"}`];
  });
  await step("U6", "Customer", "Invoice PDF generated with embedded logo", async () => {
    const r = await call(`/bookings/${booking._id}/invoice`, userToken);
    let buf = r.buf;
    let via = r.ct;
    if (r.json) {
      const d = dataOf(r.json);
      const url = d?.pdfUrl || d?.invoiceUrl || d?.url || d?.invoice?.pdfUrl;
      if (url) {
        const p = await fetch(url);
        buf = Buffer.from(await p.arrayBuffer());
        via = `json → ${p.headers.get("content-type")}`;
      } else return ["INFO", `HTTP ${r.status} json keys ${Object.keys(d || {}).join(",")}`];
    }
    const isPdf = !!buf && buf.subarray(0, 5).toString() === "%PDF-";
    const hasImage = !!buf && buf.includes(Buffer.from("/Subtype /Image")) || (!!buf && buf.includes(Buffer.from("/Image")));
    return [isPdf ? "PASS" : "FAIL", `HTTP ${r.status} ${via} bytes ${buf?.length ?? 0} pdf=${isPdf} embedded image=${hasImage}`];
  });

  // ── admin panel ─────────────────────────────────────────────────────────
  await step("A1", "Admin", "Staff list shows staff with roles", async () => {
    const r = await call("/admin/staff", adminToken);
    const list = firstArray(dataOf(r.json));
    return [r.status === 200 && list.length > 0 ? "PASS" : "FAIL", `HTTP ${r.status} ${list.length} staff: ${list.slice(0, 6).map((s: any) => `${s.fullName || s.name} (${s.roleId?.name || s.role?.name || s.roleName || "role?"})`).join("; ")}`];
  });
  await step("A2", "Admin", "Roles list", async () => {
    const r = await call("/admin/roles", adminToken);
    const list = firstArray(dataOf(r.json));
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} ${list.length} roles: ${list.map((x: any) => x.name).join(", ")}`];
  });
  let datasets: any[] = [];
  await step("A3", "Admin", "Export datasets available (Excel + PDF)", async () => {
    const r = await call("/admin/exports", adminToken);
    datasets = firstArray(dataOf(r.json));
    return [r.status === 200 && datasets.length > 0 ? "PASS" : "FAIL", `HTTP ${r.status} ${datasets.length} datasets: ${datasets.map((d: any) => d.key).join(", ")}`];
  });
  const ledger = datasets.find((d: any) => /ledger/i.test(d.key)) || datasets[0];
  const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  for (const fmt of ["xlsx", "pdf"]) {
    await step(fmt === "xlsx" ? "A4" : "A5", "Admin", `Export ${ledger?.key} as ${fmt.toUpperCase()} (last 7 days)`, async () => {
      if (!ledger) return ["FAIL", "no dataset"];
      const r = await call(`/admin/exports/${ledger.key}?format=${fmt}&dateFrom=${from}`, adminToken);
      const magic = r.buf ? r.buf.subarray(0, 4).toString("latin1") : "";
      const ok = r.status === 200 && (fmt === "xlsx" ? magic.startsWith("PK") : magic === "%PDF");
      return [ok ? "PASS" : "FAIL", `HTTP ${r.status} ${r.ct} bytes ${r.bytes} magic ${JSON.stringify(magic)}`];
    });
  }
  await step("A6", "Admin", "Completed order detail: bill, GST split, commission, start/end times", async () => {
    const r = await call(`/admin/bookings/${booking._id}`, adminToken);
    const d = dataOf(r.json);
    const b = d?.booking || d;
    const t = b?.taxBreakdown;
    return [r.status === 200 && b ? "PASS" : "FAIL", `HTTP ${r.status} ${b?.bookingNumber} subtotal ${b?.subtotal} tax ${t ? `${t.type || ""} cgst ${t.cgstAmount} sgst ${t.sgstAmount} igst ${t.igstAmount}` : "n/a"} commission ${b?.commissionAmount} (${b?.commissionPercent}%) driverEarnings ${b?.driverEarnings} times: ${Object.keys(b || {}).filter((k) => /At$/.test(k) && b[k]).join(",")}`];
  });
  await step("A7", "Admin", "Vehicle types: dimensions, free waiting, category, city rate cards with commission", async () => {
    const r = await call("/admin/config/vehicle-types", adminToken);
    const list = firstArray(dataOf(r.json));
    const summary = list.map((t: any) => `${t.name}[${t.categoryCode || "?"} ${t.lengthFt || "-"}x${t.breadthFt || "-"}x${t.heightFt || "-"}ft wait ${t.freeWaitingMinutes ?? "inherit"} range ${t.minRangeKm ?? "-"}-${t.maxRangeKm ?? "-"} cards ${(t.cityOverrides || []).map((c: any) => `${c.city ?? c.cityName ?? (c.cities || []).join("+") ?? "?"}:${c.commissionPercent ?? "inherit"}%`).join("/") || "none"}]`);
    const anyCard = list.flatMap((t: any) => t.cityOverrides || [])[0];
    return [r.status === 200 && list.length > 0 ? "PASS" : "FAIL", `HTTP ${r.status} ${list.length} types: ${summary.join(" ")} | rate-card keys ${Object.keys(anyCard || {}).join(",")}`];
  });
  await step("A8", "Admin", "Fare config: peak/night rows, commission, no base/waiting fields", async () => {
    const r = await call("/admin/config/fare", adminToken);
    const d = dataOf(r.json);
    const f = d?.fareConfig || d?.config || d;
    const keys = Object.keys(f || {});
    const legacy = keys.filter((k) => /baseFare|waitingCharge|perMinuteWaiting/i.test(k));
    const pw = (f?.peakWindows || []).map((w: any) => `${w.label || ""} ${w.start || w.startTime}-${w.end || w.endTime} x${w.multiplier}${w.cities?.length ? " [" + w.cities.join(",") + "]" : ""}`);
    const nw = (f?.nightWindows || []).map((w: any) => `${w.label || ""} ${w.start || w.startTime}-${w.end || w.endTime} x${w.multiplier}`);
    return [r.status === 200 && f ? "PASS" : "FAIL", `HTTP ${r.status} commission ${f?.driverCommissionPercent}% gst ${f?.gstPercentage}% peak rows ${pw.length} (${pw.join("; ")}) night rows ${nw.length} (${nw.join("; ")}) weather rows ${(f?.weatherSurges || []).length} legacy keys ${legacy.join(",") || "none"}`];
  });
  await step("A9", "Admin", "GST split config: jurisdictions + company state", async () => {
    const r = await call("/admin/config/tax", adminToken);
    const d = dataOf(r.json);
    const j = d?.jurisdictions || firstArray(d);
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} jurisdictions ${j.length} companyState ${d?.companyState || d?.company?.state || "?"} gstin ${d?.companyGstin || d?.company?.gstin ? "set" : "?"}`];
  });
  await step("A10", "Admin", "Document expiry summary (cached daily job)", async () => {
    const r = await call("/admin/compliance/expiry", adminToken);
    const d = dataOf(r.json);
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} ${short(d?.summary || d)}`];
  });
  await step("A11", "Admin", "SOS module stats", async () => {
    const r = await call("/admin/sos/stats", adminToken);
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} ${short(dataOf(r.json))}`];
  });
  await step("A12", "Admin", "Time slots master", async () => {
    const r = await call("/admin/config/time-slots", adminToken);
    const list = firstArray(dataOf(r.json));
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} ${list.length} slots`];
  });
  await step("A13", "Admin", "Cities master (city-specific config source)", async () => {
    const r = await call("/admin/config/cities", adminToken);
    const list = firstArray(dataOf(r.json));
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} ${list.map((c: any) => `${c.name}${c.aliases?.length ? "(" + c.aliases.join("/") + ")" : ""}`).join(", ")}`];
  });
  await step("A14", "Admin", "App settings flags", async () => {
    const r = await call("/admin/config/app-settings", adminToken);
    const list = firstArray(dataOf(r.json));
    const get = (k: string) => list.find((x: any) => x.key === k)?.value;
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} SUPPORT_PHONE=${JSON.stringify(get("SUPPORT_PHONE"))} HIDE_CONTACT_NUMBERS=${JSON.stringify(get("HIDE_CONTACT_NUMBERS"))} DISPATCH_OFFER_SECONDS=${JSON.stringify(get("DISPATCH_OFFER_SECONDS"))} COMPANY_STATE=${JSON.stringify(get("COMPANY_STATE"))}`];
  });
  await step("A15", "Admin", "Chat quick replies editable (both audiences)", async () => {
    const r = await call("/admin/chat/quick-replies", adminToken);
    const d = dataOf(r.json);
    const all: any[] = Array.isArray(d) ? d : Object.values(d || {}).flatMap((v: any) => (Array.isArray(v) ? v : []));
    const by = (a: string) => all.filter((x: any) => x.audience === a).length;
    return [r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status} shape ${Array.isArray(d) ? "array" : Object.keys(d || {}).join(",")} DRIVER ${by("DRIVER")} USER ${by("USER")}`];
  });

  const counts = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {} as Record<string, number>);
  console.log(`\n${rows.length} checks: ${JSON.stringify(counts)}`);
  const out = opt("--out", "");
  if (out) fs.writeFileSync(out, JSON.stringify({ base: BASE, booking: booking.bookingNumber, rows }, null, 2), "utf8");
  await mongoose.disconnect();
})().catch((e) => {
  console.error("QA FAILED", e);
  process.exit(1);
});
