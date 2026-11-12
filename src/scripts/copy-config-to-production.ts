/**
 * Copy the admin-managed settings from one database to another — the test
 * database the client has been tuning to the production one at go-live —
 * without any test bookings, users, drivers, wallets or payouts.
 *
 * Documents keep their _id, so references between settings (goods types →
 * vehicle types, rate cards, roles) stay intact. A collection that already
 * has documents in the target is skipped, so nothing in production is ever
 * overwritten.
 *
 * Preview (reads only):
 *   SOURCE_DB_URL="mongodb+srv://…test…" TARGET_DB_URL="mongodb+srv://…prod…" \
 *     npx ts-node src/scripts/copy-config-to-production.ts
 * Copy:
 *   … npx ts-node src/scripts/copy-config-to-production.ts --apply
 */
import { MongoClient } from "mongodb";

const APPLY = process.argv.includes("--apply");

// Settings only. Test activity (bookings, users, drivers, vehicles, wallets,
// payouts, invoices, tickets, notifications, coupons, counters) stays behind.
const SETTINGS = [
  "addonservices",
  "appconfigs",
  "automationrules",
  "badges",
  "banners",
  "bodytypes",
  "cancellationreasons",
  "chatquickreplies",
  "cities",
  "contents",
  "deliverysettings",
  "driverinstructions",
  "enterprisecontents",
  "faqs",
  "fareconfigs",
  "fueltypes",
  "goodstypes",
  "prohibiteditems",
  "roles",
  "scheduleconfigs",
  "servicetypes",
  "settings",
  "supportquickreplies",
  "taxjurisdictions",
  "timeslots",
  "trainingmaterials",
  "trainingprograms",
  "vehiclecategories",
  "vehicletypes",
];

const hostOf = (url: string) => url.replace(/^mongodb(\+srv)?:\/\/[^@]+@/, "").split("/")[0];

(async () => {
  const source = process.env.SOURCE_DB_URL;
  const target = process.env.TARGET_DB_URL;
  if (!source || !target) throw new Error("set SOURCE_DB_URL and TARGET_DB_URL");
  if (source === target) throw new Error("source and target are the same database");

  const from = await new MongoClient(source).connect();
  const to = await new MongoClient(target).connect();
  const src = from.db();
  const dst = to.db();
  console.log(`${APPLY ? "COPYING" : "PREVIEW (nothing written)"}: ${hostOf(source)}/${src.databaseName} → ${hostOf(target)}/${dst.databaseName}`);

  let copied = 0;
  for (const name of SETTINGS) {
    const docs = await src.collection(name).find({}).toArray();
    const existing = await dst.collection(name).countDocuments();
    if (!docs.length) {
      console.log(`  ${name.padEnd(22)} nothing to copy`);
      continue;
    }
    if (existing > 0) {
      console.log(`  ${name.padEnd(22)} SKIPPED: target already has ${existing}`);
      continue;
    }
    if (APPLY) await dst.collection(name).insertMany(docs, { ordered: true });
    copied += docs.length;
    console.log(`  ${name.padEnd(22)} ${docs.length} ${APPLY ? "copied" : "to copy"}`);
  }
  console.log(`${APPLY ? "Copied" : "Would copy"} ${copied} settings documents. Next: create the first admin (create-admin.ts).`);
  await from.close();
  await to.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
