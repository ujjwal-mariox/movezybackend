/**
 * Create (or reset) a Super Admin login on the database in DB_URL. Use this
 * on production instead of the seed, which sets a well-known password.
 *
 *   ADMIN_EMAIL="owner@movezy.co" ADMIN_NAME="Owner Name" \
 *     npx ts-node src/scripts/create-admin.ts
 *
 * The password is asked for on the terminal (not taken from the command line,
 * so it never lands in shell history). Requires the "Super Admin" role, which
 * copy-config-to-production.ts brings across.
 */
import readline from "readline";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import connectDB from "../models";
import { Admin } from "../models/admin.model";
import Role from "../models/role.model";

const ask = (q: string) =>
  new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(a);
    });
  });

(async () => {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const fullName = String(process.env.ADMIN_NAME || "").trim() || "Super Admin";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("set ADMIN_EMAIL");

  const password = await ask("Password (12+ characters): ");
  if (password.length < 12) throw new Error("use at least 12 characters");

  await connectDB();
  const role: any = await Role.findOne({ name: "Super Admin" }).lean();
  if (!role) throw new Error('no "Super Admin" role: run copy-config-to-production.ts first');

  await Admin.findOneAndUpdate(
    { email },
    {
      email,
      password: await bcrypt.hash(password, 10),
      fullName,
      roleId: role._id,
      roleName: "Super Admin",
      permissions: ["all"],
      isActive: true,
    },
    { upsert: true },
  );
  console.log(`Super Admin ready: ${email}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  await mongoose.disconnect().catch(() => null);
  process.exit(1);
});
