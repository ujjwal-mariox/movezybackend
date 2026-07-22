/**
 * Upserts the full 18-badge catalog from the My Badge design, and retires the
 * old 7-badge starter set (deactivated, not deleted — drivers' unlockedBadges
 * references stay valid).
 *
 * Every badge's unlockType is evaluated against real driver data in
 * getBadges. "manual" badges (Community Helper) stay locked until an admin
 * awards them — they are never fake-unlocked.
 *
 * Run: npx ts-node src/scripts/seed-badge-catalog.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import Badge from "../models/badge.model";

const CATALOG = [
  // ── Onboarding & Training ──
  { name: "Training Completed", description: "Ready for Orders!", icon: "🎓", category: "onboarding", unlockType: "training_completed", unlockValue: 1, sortOrder: 1 },
  { name: "First Trip Badge", description: "First Order Successfully Delivered!", icon: "🚗", category: "onboarding", unlockType: "trips", unlockValue: 1, sortOrder: 2 },
  { name: "Profile Verified", description: "KYC & Documents Verified", icon: "✅", category: "onboarding", unlockType: "kyc_verified", unlockValue: 1, sortOrder: 3 },

  // ── Trip Milestones ──
  { name: "10 Trips Completed", description: "First Milestone Unlocked!", icon: "🏆", category: "milestones", unlockType: "trips", unlockValue: 10, sortOrder: 4 },
  { name: "50 Trips Completed", description: "Halfway Champion!", icon: "🥈", category: "milestones", unlockType: "trips", unlockValue: 50, sortOrder: 5 },
  { name: "100 Trips Completed", description: "Century Performer!", icon: "💯", category: "milestones", unlockType: "trips", unlockValue: 100, sortOrder: 6 },
  { name: "Consistency Star", description: "Active Every Day – Great Job!", icon: "⭐", category: "milestones", unlockType: "consistency", unlockValue: 7, sortOrder: 7 },
  { name: "Long Haul Hero", description: "Master of Long-Distance Deliveries", icon: "🚚", category: "milestones", unlockType: "long_distance", unlockValue: 10, sortOrder: 8 },

  // ── Performance & Quality ──
  { name: "5-Star Service", description: "Consistently Rated Excellent!", icon: "🌟", category: "performance", unlockType: "rating", unlockValue: 4.8, sortOrder: 9 },
  { name: "Zero Cancellation", description: "Perfect Reliability Record", icon: "🛡️", category: "performance", unlockType: "zero_cancellation", unlockValue: 1, sortOrder: 10 },
  { name: "On-Time Champion", description: "Always Punctual", icon: "⏰", category: "performance", unlockType: "on_time", unlockValue: 10, sortOrder: 11 },
  { name: "Safety First", description: "Maintained a 100% Safety Score", icon: "🦺", category: "performance", unlockType: "safety", unlockValue: 25, sortOrder: 12 },

  // ── Engagement & Community ──
  { name: "Referral Champion", description: "Helped Others Join Movezy", icon: "🤝", category: "engagement", unlockType: "referrals", unlockValue: 1, sortOrder: 13 },
  { name: "Community Helper", description: "Supported Fellow Drivers", icon: "🫂", category: "engagement", unlockType: "manual", unlockValue: 0, sortOrder: 14 },
  { name: "Feedback Contributor", description: "Shared Useful App Insights", icon: "💬", category: "engagement", unlockType: "feedback", unlockValue: 1, sortOrder: 15 },

  // ── Earnings & Growth ──
  { name: "First ₹10,000 Earned", description: "Big Start!", icon: "💰", category: "earnings", unlockType: "earnings", unlockValue: 10000, sortOrder: 16 },
  { name: "Monthly Target Achiever", description: "Consistent Earner", icon: "🎯", category: "earnings", unlockType: "monthly_earnings", unlockValue: 15000, sortOrder: 17 },
  { name: "Peak Performer", description: "Completed Trips During Peak Hours", icon: "⚡", category: "earnings", unlockType: "peak_hours", unlockValue: 20, sortOrder: 18 },
];

// The starter set being replaced. Deactivated so filters and counts reflect
// the new catalog, while historical unlockedBadges ids keep resolving.
const RETIRED = [
  "Newbie",
  "Century",
  "Veteran",
  "Verified Partner",
  "Top Rated",
  "Five Star",
  "Always There",
];

async function main() {
  const url = process.env.DB_URL;
  if (!url) throw new Error("DB_URL missing from .env");
  await mongoose.connect(url);

  for (const b of CATALOG) {
    await Badge.findOneAndUpdate(
      { name: b.name },
      { ...b, isActive: true },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }
  console.log(`Upserted ${CATALOG.length} catalog badges`);

  const retired = await Badge.updateMany(
    { name: { $in: RETIRED } },
    { isActive: false },
  );
  console.log(`Retired ${retired.modifiedCount} legacy badges`);

  const active = await Badge.countDocuments({ isActive: true });
  console.log(`Active badges now: ${active}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
