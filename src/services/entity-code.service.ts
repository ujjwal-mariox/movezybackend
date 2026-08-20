import mongoose from "mongoose";

/**
 * Short human-readable IDs for the entities admins search for and read out
 * loud on support calls — "DRV-0042" instead of "68a3f91c2b7e4d0012ab34cd".
 *
 * Bookings already had this (bookingNumber, "MZ0042"); drivers and customers
 * did not, so admin tables showed raw Mongo ObjectIds and the only way to find
 * a specific driver was by name or phone — neither of which is unique.
 *
 * Same mechanics as booking-number.service.ts: an atomic $inc on a counters
 * document, seeded once from what already exists so numbering never restarts.
 * A counter is not a cache — it lives in Mongo, and findOneAndUpdate with $inc
 * is atomic across processes.
 */

interface CounterDoc {
  _id: string;
  seq: number;
}

interface EntityCodeKind {
  counterId: string;
  prefix: string;
  /** Mongoose model name, resolved lazily to avoid import cycles. */
  modelName: string;
  field: string;
}

const KINDS = {
  driver: {
    counterId: "driverCode",
    prefix: "DRV",
    modelName: "Driver",
    field: "driverCode",
  },
  user: {
    counterId: "userCode",
    prefix: "CUS",
    modelName: "User",
    field: "userCode",
  },
} satisfies Record<string, EntityCodeKind>;

export type EntityKind = keyof typeof KINDS;

const format = (prefix: string, seq: number) =>
  `${prefix}-${seq.toString().padStart(4, "0")}`;

/** Seed the counter (once) from the highest code already issued. */
const ensureSeeded = async (kind: EntityCodeKind): Promise<void> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database not connected");
  const counters = db.collection<CounterDoc>("counters");

  const existing = await counters.findOne({ _id: kind.counterId });
  if (existing) return;

  const Model = mongoose.model(kind.modelName);
  const rows = await Model.find({ [kind.field]: { $exists: true, $ne: null } })
    .select(kind.field)
    .lean();

  let currentMax = 0;
  for (const row of rows as any[]) {
    const match = String(row[kind.field] || "").match(/(\d+)$/);
    if (match) currentMax = Math.max(currentMax, parseInt(match[1], 10));
  }
  // Total count as a floor so a manual code with a low number can't cause
  // the sequence to re-issue values that would collide further on.
  const totalCount = await Model.countDocuments();
  currentMax = Math.max(currentMax, totalCount);

  // $setOnInsert makes concurrent seeding race-safe: one insert wins, the
  // rest leave the stored value untouched.
  await counters.updateOne(
    { _id: kind.counterId },
    { $setOnInsert: { seq: currentMax } },
    { upsert: true },
  );
};

export const generateEntityCode = async (
  kindName: EntityKind,
): Promise<string> => {
  const kind = KINDS[kindName];
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error(`Database not connected; cannot allocate a ${kindName} code`);
  }
  await ensureSeeded(kind);

  const counters = db.collection<CounterDoc>("counters");
  const updated = await counters.findOneAndUpdate(
    { _id: kind.counterId },
    { $inc: { seq: 1 } },
    { returnDocument: "after" },
  );
  const seq = updated?.seq;
  if (typeof seq !== "number") {
    throw new Error(`Failed to allocate a ${kindName} code`);
  }
  return format(kind.prefix, seq);
};

/**
 * Assign codes to every existing document that lacks one, oldest first so the
 * earliest driver gets the lowest number. Idempotent: once everything has a
 * code this finds nothing and does nothing, so it is safe to run on every
 * boot. New signups get their code at creation; this covers the back catalog
 * and anything that slipped through a failed allocation.
 */
export const backfillEntityCodes = async (): Promise<void> => {
  for (const kindName of Object.keys(KINDS) as EntityKind[]) {
    const kind = KINDS[kindName];
    try {
      const Model = mongoose.model(kind.modelName);
      const missing = await Model.find({
        $or: [{ [kind.field]: { $exists: false } }, { [kind.field]: null }],
      })
        .select("_id")
        .sort({ createdAt: 1 })
        .lean();

      if (missing.length === 0) continue;

      let assigned = 0;
      for (const row of missing as any[]) {
        const code = await generateEntityCode(kindName);
        // updateOne, not save(): no validation reruns on legacy documents
        // that might predate newer required fields.
        await Model.updateOne(
          { _id: row._id, [kind.field]: { $in: [null, undefined] } },
          { $set: { [kind.field]: code } },
        );
        assigned++;
      }
      console.log(
        `[entity-codes] backfilled ${assigned} ${kindName} code(s) (${kind.prefix}-…)`,
      );
    } catch (err) {
      // Codes are a convenience layer — a backfill failure must never stop
      // the server from serving bookings.
      console.error(`[entity-codes] backfill failed for ${kindName}:`, err);
    }
  }
};

export default generateEntityCode;
