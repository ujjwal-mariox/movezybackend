import "dotenv/config";
import mongoose from "mongoose";
import DriverInstruction from "../models/driver-instruction.model";

/**
 * Seed the driver instructions shown on the app's "Driver Instructions" screen.
 *
 * The collection held a single junk row (text "test", icon "🚕", sortOrder -14),
 * so the screen rendered one meaningless line. These five are the instructions
 * from the approved design, in its order.
 *
 * `icon` carries a SEMANTIC KEY rather than an emoji. The app maps the key to the
 * design's line glyph (clock / car / parcel / card / phone) and falls back to
 * rendering the value as text, so an emoji typed by an admin still works.
 *
 * Idempotent: matched on `text`, so re-running updates rather than duplicating.
 * Run with:  npx ts-node src/scripts/seed-driver-instructions.ts
 */
const INSTRUCTIONS: { text: string; icon: string; sortOrder: number }[] = [
  { text: "Be on time for every pickup", icon: "clock", sortOrder: 1 },
  { text: "Keep your vehicle clean and ready", icon: "vehicle", sortOrder: 2 },
  { text: "Handle parcels carefully", icon: "parcel", sortOrder: 3 },
  { text: "Encourage cashless payments", icon: "payment", sortOrder: 4 },
  { text: "Call customer only when necessary", icon: "call", sortOrder: 5 },
];

const run = async () => {
  const url = process.env.DB_URL;
  if (!url) throw new Error("DB_URL is not set");
  await mongoose.connect(url);
  const dbName = mongoose.connection.db?.databaseName;
  console.log(`Connected to ${dbName}\n`);

  for (const item of INSTRUCTIONS) {
    const res = await DriverInstruction.updateOne(
      { text: item.text },
      { $set: { ...item, isActive: true } },
      { upsert: true },
    );
    const what = res.upsertedCount > 0 ? "created" : "updated";
    console.log(`  ${what}: [${item.icon}] ${item.text}`);
  }

  // Retire anything that is not part of the approved set. Deactivated rather
  // than deleted — the admin panel can still see and restore it, and nothing
  // real is destroyed.
  const keep = INSTRUCTIONS.map((i) => i.text);
  const retired = await DriverInstruction.updateMany(
    { text: { $nin: keep }, isActive: true },
    { $set: { isActive: false } },
  );
  if (retired.modifiedCount > 0) {
    console.log(`\n  deactivated ${retired.modifiedCount} instruction(s) not in the approved set`);
  }

  const active = await DriverInstruction.find({ isActive: true })
    .sort({ sortOrder: 1 })
    .lean();
  console.log(`\nActive instructions now (${active.length}):`);
  for (const a of active as any[]) {
    console.log(`  ${a.sortOrder}. [${a.icon}] ${a.text}`);
  }

  await mongoose.disconnect();
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
