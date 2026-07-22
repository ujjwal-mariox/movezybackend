/**
 * Verifies that fare quoting uses real ROAD distance rather than an inflated
 * straight line, and that a client-supplied distance can no longer influence
 * the price.
 *
 * Calls the real controllers (getFareEstimate, getVehicleOptions) in-process
 * with stub req/res objects — no HTTP, no auth token, and no writes: nothing
 * here creates a booking or notifies a driver.
 *
 * Run: npx ts-node src/scripts/verify-road-fare.ts
 */
import "dotenv/config";
import mongoose from "mongoose";

import config from "../config";
import * as BookingController from "../controllers/booking.controller";
import { getDistanceForLegs } from "../services/routing.service";
import * as FareService from "../services/fare.service";
import { initRedis } from "../utils/redis.util";

/**
 * The distance the old code priced from: haversine × 1.3, rounded to 1dp.
 * Reproduced here exactly so the comparison below is against what actually
 * shipped, not against a bare straight line.
 */
const legacyKm = (
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number => {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 1.3 * 10) / 10;
};

const call = async (
  handler: (req: any, res: any) => Promise<any>,
  body: any,
): Promise<{ status: number; body: any }> => {
  let status = 200;
  let payload: any = null;
  const res: any = {
    status(code: number) {
      status = code;
      return res;
    },
    json(data: any) {
      payload = data;
      return res;
    },
  };
  await handler({ body } as any, res);
  return { status, body: payload };
};

const PICKUP = { lat: 28.6139, lng: 77.209 }; // Connaught Place, Delhi
const DROP = { lat: 28.5355, lng: 77.391 }; // Noida
const STOP = { lat: 28.5672, lng: 77.321 }; // between the two

/** Routes chosen to show where the old ×1.3 guess lands high and low. */
const ROUTES: { name: string; from: typeof PICKUP; to: typeof PICKUP }[] = [
  { name: "Delhi CP → Noida", from: PICKUP, to: DROP },
  {
    name: "Delhi CP → Gurgaon Cyber City",
    from: PICKUP,
    to: { lat: 28.4949, lng: 77.089 },
  },
  {
    name: "Bandra → Navi Mumbai (across the creek)",
    from: { lat: 19.0596, lng: 72.8295 },
    to: { lat: 19.033, lng: 73.0297 },
  },
  {
    name: "Short hop: CP → India Gate",
    from: PICKUP,
    to: { lat: 28.6129, lng: 77.2295 },
  },
];

const run = async () => {
  await mongoose.connect(config.database.url as string);
  // getVehicleOptions reads the vehicle-type cache directly, so the harness
  // needs the same Redis connection the server has.
  await initRedis();

  const vt: any = await mongoose.connection
    .collection("vehicletypes")
    .findOne({ isActive: true, isDeleted: { $ne: true } });
  if (!vt) throw new Error("no active vehicle type to price against");
  const vehicleTypeId = String(vt._id);
  console.log(
    `Pricing with: ${vt.name} (base ₹${vt.baseFare}, ₹${vt.perKmRate}/km, ₹${vt.perMinuteRate ?? 0}/min)\n`,
  );

  console.log("── old (haversine ×1.3) vs new (OSRM road), priced end to end ──");
  for (const r of ROUTES) {
    const oldKm = legacyKm(r.from.lat, r.from.lng, r.to.lat, r.to.lng);
    const road = await getDistanceForLegs([r.from, r.to]);
    if (!road) {
      console.log(`${r.name}: router unavailable`);
      continue;
    }

    // Price both distances through the real fare service, so the comparison is
    // the actual bill rather than the per-km line alone.
    const priceOf = async (km: number, mins: number) =>
      (
        await FareService.calculateFare({
          vehicleTypeId: vt._id,
          distanceKm: km,
          durationMin: mins,
          serviceType: "WITHIN_CITY",
        })
      ).finalFare;
    const oldFare = await priceOf(oldKm, Math.max(5, Math.ceil((oldKm / 25) * 60)));
    const newFare = await priceOf(road.distanceKm, road.durationMin);

    const kmPct = ((road.distanceKm - oldKm) / oldKm) * 100;
    console.log(
      `${r.name}\n` +
        `   distance ${oldKm} → ${road.distanceKm} km ` +
        `(${kmPct >= 0 ? "+" : ""}${kmPct.toFixed(1)}%) [${road.source}]\n` +
        `   duration billed ${road.durationMin} min ` +
        `(router free-flow: ${road.routedDurationMin} min — not used)\n` +
        `   fare ₹${oldFare.toFixed(2)} → ₹${newFare.toFixed(2)} ` +
        `(${newFare >= oldFare ? "+" : "−"}₹${Math.abs(newFare - oldFare).toFixed(2)})`,
    );
  }

  console.log("\n── A. fare-estimate, coordinates only ──");
  const a = await call(BookingController.getFareEstimate, {
    pickup: PICKUP,
    drop: DROP,
    vehicleTypeId,
  });
  console.log(
    `status ${a.status} | distanceKm ${a.body?.data?.distanceKm} | durationMin ${a.body?.data?.durationMin} | finalAmount ₹${a.body?.data?.finalAmount}`,
  );

  console.log(
    "\n── B. same trip, client insists distanceKm=5 (a lie) ──",
  );
  const b = await call(BookingController.getFareEstimate, {
    pickup: PICKUP,
    drop: DROP,
    vehicleTypeId,
    distanceKm: 5,
    durationMin: 10,
  });
  console.log(
    `status ${b.status} | distanceKm ${b.body?.data?.distanceKm} | durationMin ${b.body?.data?.durationMin} | finalAmount ₹${b.body?.data?.finalAmount}`,
  );
  console.log(
    b.body?.data?.distanceKm === a.body?.data?.distanceKm &&
      b.body?.data?.finalAmount === a.body?.data?.finalAmount
      ? "→ client figure IGNORED: identical to A ✅"
      : "→ client figure still influencing the price ❌",
  );

  console.log("\n── C. same trip with a stop, coordinates only ──");
  const c = await call(BookingController.getFareEstimate, {
    pickup: PICKUP,
    drop: DROP,
    stops: [STOP],
    vehicleTypeId,
  });
  console.log(
    `status ${c.status} | distanceKm ${c.body?.data?.distanceKm} | finalAmount ₹${c.body?.data?.finalAmount}`,
  );
  console.log(
    (c.body?.data?.distanceKm ?? 0) >= (a.body?.data?.distanceKm ?? 0)
      ? "→ detour priced in ✅"
      : "→ detour NOT priced in ❌",
  );

  console.log("\n── D. vehicle-options list, coordinates only ──");
  const d = await call(BookingController.getVehicleOptions, {
    pickup: PICKUP,
    drop: DROP,
    vehicleTypeId,
  });
  const options: any[] = Array.isArray(d.body?.data) ? d.body.data : [];
  console.log(`status ${d.status} | ${options.length} vehicles`);
  if (d.status !== 200) console.log(`   error: ${d.body?.message}`);
  for (const o of options.slice(0, 4)) {
    console.log(`   ${o.vehicleType?.name}: ${o.distanceKm} km → ₹${o.fare}`);
  }
  console.log(
    options.length > 0 && options[0].distanceKm === a.body?.data?.distanceKm
      ? "→ list and estimate agree on distance ✅"
      : "→ list and estimate DISAGREE ❌",
  );

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
