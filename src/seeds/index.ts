import mongoose from "mongoose";
import config from "../config";

// Import models
import VehicleCategory from "../models/vehicle-category.model";
import VehicleType from "../models/vehicle-type.model";
import ServiceType from "../models/service-type.model";
import AddonService from "../models/addon-service.model";
import GoodsType from "../models/goods-type.model";
import CancellationReason from "../models/cancellation-reason.model";
import { TimeSlot, ScheduleConfig } from "../models/time-slot.model";
import { AppConfig, FareConfig } from "../models/app-config.model";
import { Admin } from "../models/admin.model";
import { FAQ, Content } from "../models/content.model";
import { Role } from "../models/role.model";
import Badge from "../models/badge.model";
import bcrypt from "bcryptjs";

const seedDatabase = async () => {
  try {
    console.log("🌱 Starting database seeding...");
    await mongoose.connect(config.database.url);
    console.log("✅ Connected to MongoDB");

    // Seed Vehicle Categories
    console.log("📦 Seeding Vehicle Categories...");
    const categories = [
      {
        name: "2 Wheeler",
        code: "2W",
        description: "Two wheelers for small packages",
        sortOrder: 1,
      },
      {
        name: "3 Wheeler",
        code: "3W",
        description: "Auto rickshaws and tempos",
        sortOrder: 2,
      },
      {
        name: "4 Wheeler",
        code: "4W",
        description: "Cars, vans, and small trucks",
        sortOrder: 3,
      },
      {
        name: "Heavy Vehicle",
        code: "HV",
        description: "Trucks and large vehicles",
        sortOrder: 4,
      },
    ];

    for (const cat of categories) {
      await VehicleCategory.findOneAndUpdate({ code: cat.code }, cat, {
        upsert: true,
        new: true,
      });
    }

    // Seed Vehicle Types
    console.log("🚗 Seeding Vehicle Types...");
    // These were written against an older VehicleType schema (code/categoryId/
    // capacity/dimensions) that no longer exists. Upserting them threw
    // StrictModeError on `code`, which aborted the whole seed run — so every
    // block below this one (fare config, cancellation reasons, FAQs, content)
    // had never seeded at all. Fields now match the live model.
    const vehicleTypes = [
      {
        name: "2 Wheeler",
        categoryCode: "2W",
        isDefaultForCategory: true,
        maxWeightKg: 10,
        lengthFt: 1.6,
        breadthFt: 1,
        heightFt: 1,
        baseFare: 30,
        perKmRate: 8,
        perMinuteRate: 1,
        description: "For small documents and parcels up to 10kg",
        icon: "🏍️",
        sortOrder: 1,
      },
      {
        name: "3 Wheeler",
        categoryCode: "3W",
        isDefaultForCategory: true,
        maxWeightKg: 50,
        lengthFt: 3.9,
        breadthFt: 2.6,
        heightFt: 2.6,
        baseFare: 50,
        perKmRate: 12,
        perMinuteRate: 1.5,
        description: "For medium packages up to 50kg",
        icon: "🛺",
        sortOrder: 2,
      },
      {
        name: "Mini Truck",
        categoryCode: "4W",
        isDefaultForCategory: true,
        maxWeightKg: 750,
        lengthFt: 6.9,
        breadthFt: 4.9,
        heightFt: 4.9,
        baseFare: 149,
        perKmRate: 18,
        perMinuteRate: 2,
        description: "Mini truck for house shifting and bulk goods",
        icon: "🚚",
        sortOrder: 3,
      },
      {
        name: "Pickup",
        categoryCode: "4W",
        maxWeightKg: 1000,
        lengthFt: 7.9,
        breadthFt: 4.9,
        heightFt: 4.9,
        baseFare: 199,
        perKmRate: 22,
        perMinuteRate: 2.5,
        description: "8ft open pickup for furniture and appliances",
        icon: "🛻",
        sortOrder: 4,
      },
      {
        name: "Cargo Van",
        categoryCode: "4W",
        maxWeightKg: 500,
        lengthFt: 5.9,
        breadthFt: 3.9,
        heightFt: 3.3,
        baseFare: 129,
        perKmRate: 16,
        perMinuteRate: 2,
        description: "Closed van for weather protection",
        icon: "🚐",
        sortOrder: 5,
      },
      {
        name: "Large Truck",
        categoryCode: "HV",
        isDefaultForCategory: true,
        maxWeightKg: 4000,
        lengthFt: 14.1,
        breadthFt: 6.6,
        heightFt: 6.6,
        baseFare: 499,
        perKmRate: 35,
        perMinuteRate: 4,
        description: "For office shifting and large consignments",
        icon: "🚛",
        sortOrder: 6,
      },
    ];

    // Bootstrap only. The catalog is admin-managed once it exists; re-seeding a
    // live catalog would add vehicle types no driver is registered against, and
    // customers would see them as bookable.
    // Types are named by category ("Mini Truck", "Pickup") rather than by brand
    // ("Tata Ace", "Eeco"): a brand name cannot describe the slot it fills, and
    // it collided with the 4-wheeler type added to the live catalog.
    const existingVehicleTypes = await VehicleType.countDocuments();
    if (existingVehicleTypes > 0) {
      console.log(
        `   ↳ ${existingVehicleTypes} vehicle types already configured, skipping`
      );
    } else {
      for (const vt of vehicleTypes) {
        await VehicleType.findOneAndUpdate({ name: vt.name }, vt, {
          upsert: true,
          new: true,
        });
      }
    }

    // Seed Service Types
    console.log("📋 Seeding Service Types...");
    const serviceTypes = [
      {
        name: "Within City",
        code: "WITHIN_CITY",
        description: "Delivery within the same city",
        isActive: true,
        sortOrder: 1,
      },
      {
        name: "Outstation",
        code: "OUTSTATION",
        description: "Inter-city delivery",
        priceMultiplier: 1.5,
        minDistance: 50,
        isActive: true,
        sortOrder: 2,
      },
    ];

    for (const st of serviceTypes) {
      await ServiceType.findOneAndUpdate({ code: st.code }, st, {
        upsert: true,
        new: true,
      });
    }

    // Seed Addon Services
    console.log("➕ Seeding Addon Services...");
    const addons = [
      {
        name: "Loading Help",
        code: "LOADING",
        description: "Our partner will help load your goods",
        priceType: "PER_FLOOR",
        price: 50,
        icon: "📦⬆️",
        category: "LOADING_UNLOADING",
        sortOrder: 1,
      },
      {
        name: "Unloading Help",
        code: "UNLOADING",
        description: "Our partner will help unload your goods",
        priceType: "PER_FLOOR",
        price: 50,
        icon: "📦⬇️",
        category: "LOADING_UNLOADING",
        sortOrder: 2,
      },
      {
        name: "Packing Material",
        code: "PACKING",
        description: "Bubble wrap and packaging material",
        priceType: "FIXED",
        price: 200,
        icon: "📦",
        category: "PACKING",
        sortOrder: 3,
      },
      {
        name: "Insurance",
        code: "INSURANCE",
        description: "Coverage for goods damage",
        priceType: "PERCENTAGE",
        price: 2, // 2% of order value
        icon: "🛡️",
        category: "INSURANCE",
        sortOrder: 4,
      },
    ];

    // Bootstrap only. These are keyed by the seed's own codes (LOADING,
    // UNLOADING...), which don't match the short codes an admin used when
    // creating the live catalog by hand (LDING, UNLD) — so upserting here does
    // not update those rows, it inserts near-duplicates alongside them, and
    // customers get "Loading" and "Loading Help" side by side on the fare.
    const existingAddons = await AddonService.countDocuments();
    if (existingAddons > 0) {
      console.log(`   ↳ ${existingAddons} addon services already configured, skipping`);
    } else {
      for (const addon of addons) {
        await AddonService.findOneAndUpdate({ code: addon.code }, addon, {
          upsert: true,
          new: true,
        });
      }
    }

    // Seed Goods Types
    console.log("📦 Seeding Goods Types...");
    const goodsTypes = [
      {
        name: "Documents",
        code: "DOCUMENTS",
        category: "PERSONAL",
        icon: "📄",
        sortOrder: 1,
      },
      {
        name: "Electronics",
        code: "ELECTRONICS",
        category: "PERSONAL",
        icon: "📱",
        sortOrder: 2,
      },
      {
        name: "Furniture",
        code: "FURNITURE",
        category: "PERSONAL",
        icon: "🪑",
        sortOrder: 3,
      },
      {
        name: "Clothing",
        code: "CLOTHING",
        category: "PERSONAL",
        icon: "👕",
        sortOrder: 4,
      },
      {
        name: "Food Items",
        code: "FOOD",
        category: "BUSINESS",
        icon: "🍔",
        sortOrder: 5,
      },
      {
        name: "Medical Supplies",
        code: "MEDICAL",
        category: "BUSINESS",
        icon: "💊",
        sortOrder: 6,
      },
      {
        name: "Machinery Parts",
        code: "MACHINERY",
        category: "BUSINESS",
        icon: "⚙️",
        sortOrder: 7,
      },
      {
        name: "Fragile Items",
        code: "FRAGILE",
        category: "PERSONAL",
        icon: "🥛",
        sortOrder: 8,
      },
      {
        name: "Others",
        code: "OTHERS",
        category: "PERSONAL",
        icon: "📦",
        sortOrder: 99,
      },
    ];

    // Bootstrap only — same code-mismatch problem as the addons above: the
    // hand-created "Furniture" carries code FRE, so seeding FURNITURE inserts a
    // second Furniture rather than updating the first.
    const existingGoodsTypes = await GoodsType.countDocuments();
    if (existingGoodsTypes > 0) {
      console.log(`   ↳ ${existingGoodsTypes} goods types already configured, skipping`);
    } else {
      for (const gt of goodsTypes) {
        await GoodsType.findOneAndUpdate({ code: gt.code }, gt, {
          upsert: true,
          new: true,
        });
      }
    }

    // Seed Cancellation Reasons
    console.log("❌ Seeding Cancellation Reasons...");
    const cancellationReasons = [
      {
        reason: "Changed my mind",
        code: "CHANGED_MIND",
        applicableTo: "BOTH",
        refundPercentage: 100,
        penaltyAmount: 0,
        sortOrder: 1,
      },
      {
        reason: "Driver taking too long",
        code: "DRIVER_DELAY",
        applicableTo: "USER",
        refundPercentage: 100,
        penaltyAmount: 0,
        sortOrder: 2,
      },
      {
        reason: "Wrong pickup/drop location",
        code: "WRONG_LOCATION",
        applicableTo: "BOTH",
        refundPercentage: 100,
        penaltyAmount: 0,
        sortOrder: 3,
      },
      {
        reason: "Price too high",
        code: "HIGH_PRICE",
        applicableTo: "USER",
        refundPercentage: 100,
        penaltyAmount: 0,
        sortOrder: 4,
      },
      {
        reason: "Customer not responding",
        code: "CUSTOMER_UNRESPONSIVE",
        applicableTo: "DRIVER",
        refundPercentage: 80,
        penaltyAmount: 0,
        sortOrder: 5,
      },
      {
        reason: "Vehicle breakdown",
        code: "VEHICLE_ISSUE",
        applicableTo: "DRIVER",
        refundPercentage: 100,
        penaltyAmount: 0,
        sortOrder: 6,
      },
      {
        reason: "Other reason",
        code: "OTHER",
        applicableTo: "BOTH",
        requiresNote: true,
        refundPercentage: 90,
        penaltyAmount: 0,
        sortOrder: 99,
      },
    ];

    for (const cr of cancellationReasons) {
      await CancellationReason.findOneAndUpdate({ code: cr.code }, cr, {
        upsert: true,
        new: true,
      });
    }

    // Seed Time Slots.
    //
    // Two bugs used to make this a no-op: the rows were written with `name`
    // (the schema field is `label`, and it's REQUIRED, so nothing valid was
    // ever stored) and with `daysAvailable`, which isn't on the schema at all.
    // Result: zero slots existed and /bookings/time-slots always returned [].
    //
    // Half-hourly slots match the design ("2:00 PM", "2:30 PM", "3:00 PM"…),
    // which shows specific pickup times rather than 3-hour windows.
    console.log("⏰ Seeding Time Slots...");
    const pad = (n: number) => String(n).padStart(2, "0");
    const to12h = (h: number, m: number) => {
      const suffix = h < 12 ? "AM" : "PM";
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      return `${hour12}:${pad(m)} ${suffix}`;
    };

    const timeSlots: {
      label: string;
      startTime: string;
      endTime: string;
      sortOrder: number;
    }[] = [];
    let order = 1;
    // 06:00 → 21:00, every 30 minutes.
    for (let mins = 6 * 60; mins < 21 * 60; mins += 30) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const endMins = mins + 30;
      timeSlots.push({
        label: to12h(h, m),
        startTime: `${pad(h)}:${pad(m)}`,
        endTime: `${pad(Math.floor(endMins / 60))}:${pad(endMins % 60)}`,
        sortOrder: order++,
      });
    }

    for (const ts of timeSlots) {
      await TimeSlot.findOneAndUpdate(
        { startTime: ts.startTime },
        { ...ts, isActive: true },
        { upsert: true, new: true },
      );
    }
    console.log(`   seeded ${timeSlots.length} half-hourly slots`);

    // Scheduling rules the time-slot endpoint reads.
    await ScheduleConfig.findOneAndUpdate(
      {},
      {
        advanceBookingDays: 7,
        minAdvanceHours: 1,
        maxScheduledPerDay: 100,
        isSchedulingEnabled: true,
      },
      { upsert: true, new: true },
    );

    // Seed App Config
    console.log("⚙️ Seeding App Config...");
    await AppConfig.findOneAndUpdate(
      { key: "general" },
      {
        key: "general",
        value: {
          appName: "Movezy",
          supportEmail: "support@movezy.in",
          supportPhone: "+91-9876543210",
          currency: "INR",
          currencySymbol: "₹",
          minAppVersion: "1.0.0",
          maintenanceMode: false,
        },
        description: "General app configuration",
      },
      { upsert: true },
    );

    // Seed Fare Config
    console.log("💰 Seeding Fare Config...");
    await FareConfig.findOneAndUpdate(
      { name: "Default" },
      {
        name: "Default",
        isDefault: true,
        baseFare: 50,
        perKmRate: 15,
        perMinuteRate: 2,
        minimumFare: 50,
        gstPercentage: 18,
        // Share of the pre-GST subtotal Movezy keeps from the driver's
        // settlement. Payouts used to hand drivers the whole gross fare —
        // GST included — and retain nothing.
        driverCommissionPercent: 20,
        surgeConfig: {
          enabled: true,
          thresholds: [
            { utilization: 0.7, multiplier: 1.2 },
            { utilization: 0.8, multiplier: 1.5 },
            { utilization: 0.9, multiplier: 2.0 },
          ],
          maxMultiplier: 2.5,
        },
        waitingCharges: {
          freeMinutes: 5,
          chargePerMinute: 3,
        },
        nightCharges: {
          enabled: true,
          startTime: "22:00",
          endTime: "06:00",
          multiplier: 1.25,
        },
        peakHoursConfig: {
          enabled: true,
          slots: [
            { startTime: "08:00", endTime: "10:00", multiplier: 1.2 },
            { startTime: "17:00", endTime: "20:00", multiplier: 1.2 },
          ],
        },
      },
      { upsert: true },
    );

    // Seed Admin User
    console.log("👤 Seeding Admin User...");
    const hashedPassword = await bcrypt.hash("Admin@123", 10);
    // Link the account to the seeded Super Admin role so the document
    // validates (roleId is required by the schema) and the role system agrees.
    const superAdminRole = await Role.findOne({ name: "Super Admin" }).lean();
    await Admin.findOneAndUpdate(
      { email: "admin@movezy.in" },
      {
        email: "admin@movezy.in",
        password: hashedPassword,
        name: "Super Admin",
        ...(superAdminRole ? { roleId: superAdminRole._id } : {}),
        // roleName, not `role`: the Admin schema has no `role` path, so the
        // old value was silently dropped and the super-admin bypass never
        // matched — locking the seeded account out with 403s.
        roleName: "Super Admin",
        permissions: ["all"],
        isActive: true,
      },
      { upsert: true },
    );

    // Seed FAQs
    console.log("❓ Seeding FAQs...");
    // Categories match the issue categories the Help & Support screen offers
    // (driver_late, payment, account, cancellation, damaged, other) so the
    // screen can fetch the FAQs for whichever category the customer picks.
    // This content used to be hardcoded in the app, which meant support answers
    // could only be corrected by shipping a new release.
    const faqs = [
      {
        question: "My driver hasn't arrived yet",
        answer:
          "If the driver is delayed beyond the estimated time, you can track their live location. If the delay exceeds 10 minutes, you may cancel without charge. We sincerely apologize for the inconvenience.",
        category: "driver_late",
        sortOrder: 1,
      },
      {
        question: "Driver is not moving",
        answer:
          "The driver may be stuck in traffic. Please wait 5 minutes. If there's no movement, contact the driver directly through the app or raise a ticket for reassignment.",
        category: "driver_late",
        sortOrder: 2,
      },
      {
        question: "Will I be charged extra for delays?",
        answer:
          "No, you will not be charged extra due to driver delays. The fare is based on the original estimate at the time of booking.",
        category: "driver_late",
        sortOrder: 3,
      },
      {
        question: "I was charged incorrectly",
        answer:
          "If you see an incorrect charge, please check the fare breakdown in your trip details. If there's still a discrepancy, raise a ticket and we'll investigate and refund within 3-5 business days.",
        category: "payment",
        sortOrder: 1,
      },
      {
        question: "My refund hasn't been processed",
        answer:
          "Refunds typically take 5-7 business days. If it's been longer, please check with your bank. You can also track refund status in the Wallet section.",
        category: "payment",
        sortOrder: 2,
      },
      {
        question: "Payment failed but amount deducted",
        answer:
          "If your payment failed but the amount was deducted, it will be auto-refunded within 24-48 hours. If not, please share the transaction ID via a support ticket.",
        category: "payment",
        sortOrder: 3,
      },
      {
        question: "I can't log into my account",
        answer:
          "Try logging in with your registered phone number and verify the OTP. If you're still having trouble, try clearing the app cache or reinstalling the app.",
        category: "account",
        sortOrder: 1,
      },
      {
        question: "How to update my phone number?",
        answer:
          "Go to Profile → Edit Profile to update your phone number. You'll need to verify the new number with an OTP.",
        category: "account",
        sortOrder: 2,
      },
      {
        question: "How to delete my account?",
        answer:
          'To delete your account, go to Profile → Help & Support and raise a ticket with subject "Account Deletion". We\'ll process it within 48 hours.',
        category: "account",
        sortOrder: 3,
      },
      {
        question: "Why was I charged a cancellation fee?",
        answer:
          "A cancellation fee applies when a driver has already been assigned and is en route. This compensates the driver for their time and fuel.",
        category: "cancellation",
        sortOrder: 1,
      },
      {
        question: "How to cancel my booking?",
        answer:
          'Go to your active booking → Tap "Cancel". If a driver hasn\'t been assigned yet, cancellation is free. After assignment, a small fee may apply.',
        category: "cancellation",
        sortOrder: 2,
      },
      {
        question: "Can I get a refund after cancellation?",
        answer:
          "If you paid in advance, the refund (minus any cancellation fee) will be credited to your wallet or original payment method within 3-5 business days.",
        category: "cancellation",
        sortOrder: 3,
      },
      {
        question: "My goods were damaged during delivery",
        answer:
          "We're sorry to hear that. Please raise a ticket with photos of the damaged goods and your order ID. Our team will investigate and process compensation within 5-7 business days.",
        category: "damaged",
        sortOrder: 1,
      },
      {
        question: "How is compensation calculated?",
        answer:
          "Compensation is based on the declared value of goods at the time of booking and the extent of damage. Insured deliveries receive full declared value coverage.",
        category: "damaged",
        sortOrder: 2,
      },
      {
        question: "How to contact the driver?",
        answer:
          "You can call or message the driver directly from the active booking screen. Tap the phone icon next to the driver's name.",
        category: "other",
        sortOrder: 1,
      },
      {
        question: "How to share my ride details?",
        answer:
          'On the tracking screen, tap the "Share" button to send live tracking details to anyone via WhatsApp, SMS, or other apps.',
        category: "other",
        sortOrder: 2,
      },
      {
        question: "App is crashing or not working",
        answer:
          "Try clearing the app cache, updating to the latest version, or reinstalling. If the issue persists, please raise a support ticket with your device details.",
        category: "other",
        sortOrder: 3,
      },
    ];

    for (const faq of faqs) {
      await FAQ.findOneAndUpdate({ question: faq.question }, faq, {
        upsert: true,
      });
    }

    // Seed Badges
    // The driver Badges screen and its unlock logic are fully built (trips /
    // rating / zero_cancellation / kyc_verified are all evaluated in
    // driver.controller), but no catalog was ever seeded — so a working backend
    // rendered "no badges" and every driver's Awards screen looked broken.
    console.log("🏅 Seeding Badges...");
    // The 18-badge catalog from the My Badge design. Kept in lock-step with
    // src/scripts/seed-badge-catalog.ts, which is the one-off migration for
    // live environments (it also retires the old 7-badge starter set).
    const badges = [
      { name: "Training Completed", description: "Ready for Orders!", icon: "🎓", category: "onboarding", unlockType: "training_completed", unlockValue: 1, sortOrder: 1 },
      { name: "First Trip Badge", description: "First Order Successfully Delivered!", icon: "🚗", category: "onboarding", unlockType: "trips", unlockValue: 1, sortOrder: 2 },
      { name: "Profile Verified", description: "KYC & Documents Verified", icon: "✅", category: "onboarding", unlockType: "kyc_verified", unlockValue: 1, sortOrder: 3 },
      { name: "10 Trips Completed", description: "First Milestone Unlocked!", icon: "🏆", category: "milestones", unlockType: "trips", unlockValue: 10, sortOrder: 4 },
      { name: "50 Trips Completed", description: "Halfway Champion!", icon: "🥈", category: "milestones", unlockType: "trips", unlockValue: 50, sortOrder: 5 },
      { name: "100 Trips Completed", description: "Century Performer!", icon: "💯", category: "milestones", unlockType: "trips", unlockValue: 100, sortOrder: 6 },
      { name: "Consistency Star", description: "Active Every Day – Great Job!", icon: "⭐", category: "milestones", unlockType: "consistency", unlockValue: 7, sortOrder: 7 },
      { name: "Long Haul Hero", description: "Master of Long-Distance Deliveries", icon: "🚚", category: "milestones", unlockType: "long_distance", unlockValue: 10, sortOrder: 8 },
      { name: "5-Star Service", description: "Consistently Rated Excellent!", icon: "🌟", category: "performance", unlockType: "rating", unlockValue: 4.8, sortOrder: 9 },
      { name: "Zero Cancellation", description: "Perfect Reliability Record", icon: "🛡️", category: "performance", unlockType: "zero_cancellation", unlockValue: 1, sortOrder: 10 },
      { name: "On-Time Champion", description: "Always Punctual", icon: "⏰", category: "performance", unlockType: "on_time", unlockValue: 10, sortOrder: 11 },
      { name: "Safety First", description: "Maintained a 100% Safety Score", icon: "🦺", category: "performance", unlockType: "safety", unlockValue: 25, sortOrder: 12 },
      { name: "Referral Champion", description: "Helped Others Join Movezy", icon: "🤝", category: "engagement", unlockType: "referrals", unlockValue: 1, sortOrder: 13 },
      { name: "Community Helper", description: "Supported Fellow Drivers", icon: "🫂", category: "engagement", unlockType: "manual", unlockValue: 0, sortOrder: 14 },
      { name: "Feedback Contributor", description: "Shared Useful App Insights", icon: "💬", category: "engagement", unlockType: "feedback", unlockValue: 1, sortOrder: 15 },
      { name: "First ₹10,000 Earned", description: "Big Start!", icon: "💰", category: "earnings", unlockType: "earnings", unlockValue: 10000, sortOrder: 16 },
      { name: "Monthly Target Achiever", description: "Consistent Earner", icon: "🎯", category: "earnings", unlockType: "monthly_earnings", unlockValue: 15000, sortOrder: 17 },
      { name: "Peak Performer", description: "Completed Trips During Peak Hours", icon: "⚡", category: "earnings", unlockType: "peak_hours", unlockValue: 20, sortOrder: 18 },
    ];

    for (const b of badges) {
      // runValidators, because Mongoose skips validation on updates by default.
      // Without it this upsert wrote "trust"/"service" — values the category
      // enum forbids — straight past the schema and into the live collection,
      // where nothing surfaced them until a read tried to filter by category.
      await Badge.findOneAndUpdate({ name: b.name }, b, {
        upsert: true,
        runValidators: true,
      });
    }

    // Seed Content
    // Keyed by `type` (an enum), not `key`/`contentType` — those paths aren't in
    // the schema and threw StrictModeError, aborting the seed before Roles.
    // $setOnInsert, because these are bootstrap placeholders: a re-seed must
    // never overwrite real legal text an admin has since published.
    console.log("📝 Seeding Content...");
    const legalPlaceholders = [
      {
        type: "TERMS",
        title: "Terms and Conditions",
        content:
          "<h1>Terms and Conditions</h1><p>Please read these terms carefully...</p>",
      },
      {
        type: "PRIVACY",
        title: "Privacy Policy",
        content:
          "<h1>Privacy Policy</h1><p>Your privacy is important to us...</p>",
      },
    ];

    for (const doc of legalPlaceholders) {
      await Content.findOneAndUpdate(
        { type: doc.type },
        { $setOnInsert: doc },
        { upsert: true },
      );
    }

    // Seed Roles
    // Role is imported at the top now: mongoose.model("Role") only resolves a
    // model that has already been registered by an import somewhere, and
    // nothing in this script had imported it — so this threw MissingSchemaError
    // and took the rest of the seed with it.
    console.log("🔐 Seeding Default Roles...");

    const defaultRoles = [
      {
        name: "Super Admin",
        code: "SUPER_ADMIN",
        description: "Full system access with all permissions",
        permissions: ["*"], // All permissions
        isSystem: true,
        isActive: true,
      },
      {
        name: "Operations Manager",
        code: "OPERATIONS_MANAGER",
        description: "Manages day-to-day operations, bookings, drivers",
        permissions: [
          "dashboard:view",
          "bookings:view", "bookings:update", "bookings:assign", "bookings:cancel",
          "drivers:view", "drivers:update", "drivers:approve", "drivers:suspend",
          "users:view", "users:update",
          "tracking:view",
          "support:view", "support:respond", "support:assign",
          "sos:view", "sos:respond",
          "cod:view",
          "reports:view",
        ],
        isSystem: true,
        isActive: true,
      },
      {
        name: "Finance Manager",
        code: "FINANCE_MANAGER",
        description: "Manages financial operations, approves refunds L1",
        permissions: [
          "dashboard:view",
          "finance:view", "finance:export",
          "bookings:view",
          "refunds:view", "refunds:request", "refunds:approve_l1",
          "expenses:view", "expenses:create", "expenses:approve",
          "enterprises:view",
          "enterprise_credit:view",
          "cod:view", "cod:settle",
          "reports:view",
        ],
        isSystem: true,
        isActive: true,
      },
      {
        name: "Finance Director",
        code: "FINANCE_DIRECTOR",
        description: "Senior finance role with L2 refund approval authority",
        permissions: [
          "dashboard:view",
          "finance:view", "finance:export",
          "bookings:view",
          "refunds:view", "refunds:request", "refunds:approve_l1", "refunds:approve_l2", "refunds:reject", "refunds:process",
          "expenses:view", "expenses:create", "expenses:approve", "expenses:delete",
          "enterprises:view", "enterprises:update",
          "enterprise_credit:view", "enterprise_credit:adjust", "enterprise_credit:limit",
          "cod:view", "cod:settle",
          "reports:view",
          "audit:view",
        ],
        isSystem: true,
        isActive: true,
      },
      {
        name: "Support Agent",
        code: "SUPPORT_AGENT",
        description: "Customer support representative",
        permissions: [
          "dashboard:view",
          "bookings:view",
          "users:view",
          "drivers:view",
          "support:view", "support:respond",
          "sos:view",
          "refunds:view", "refunds:request",
        ],
        isSystem: true,
        isActive: true,
      },
      {
        name: "Fleet Manager",
        code: "FLEET_MANAGER",
        description: "Manages driver fleet and vehicles",
        permissions: [
          "dashboard:view",
          "drivers:view", "drivers:create", "drivers:update", "drivers:approve", "drivers:suspend",
          "drivers:verify_documents",
          "tracking:view",
          "bookings:view", "bookings:assign",
          "cod:view",
        ],
        isSystem: true,
        isActive: true,
      },
      {
        name: "Enterprise Account Manager",
        code: "ENTERPRISE_MANAGER",
        description: "Manages enterprise client relationships",
        permissions: [
          "dashboard:view",
          "enterprises:view", "enterprises:create", "enterprises:update", "enterprises:approve",
          "enterprise_credit:view", "enterprise_credit:adjust",
          "bookings:view",
          "users:view",
          "reports:view",
        ],
        isSystem: true,
        isActive: true,
      },
      {
        name: "System Administrator",
        code: "SYSTEM_ADMIN",
        description: "System configuration and staff management",
        permissions: [
          "dashboard:view",
          "settings:view", "settings:update",
          "staff:view", "staff:create", "staff:update", "staff:delete",
          "roles:view", "roles:create", "roles:update", "roles:delete",
          "sessions:view", "sessions:terminate", "sessions:config",
          "audit:view",
          "automation:view", "automation:manage",
        ],
        isSystem: true,
        isActive: true,
      },
      {
        name: "Read Only",
        code: "READ_ONLY",
        description: "View-only access for auditors and observers",
        permissions: [
          "dashboard:view",
          "bookings:view",
          "users:view",
          "drivers:view",
          "enterprises:view",
          "finance:view",
          "reports:view",
          "audit:view",
        ],
        isSystem: true,
        isActive: true,
      },
    ];

    // Keyed by `name` (the unique path); `code` isn't in the schema and threw.
    // Bootstrap only: these duplicate scripts/seed-roles.ts, and re-upserting
    // would rewrite the permission sets of live admin roles.
    const existingRoles = await Role.countDocuments();
    if (existingRoles > 0) {
      console.log(`   ↳ ${existingRoles} roles already configured, skipping`);
    } else {
      for (const role of defaultRoles) {
        await Role.findOneAndUpdate({ name: role.name }, role, {
          upsert: true,
          new: true,
        });
      }
    }

    // Seed App Config — Joining Fee
    console.log("⚙️  Seeding App Config...");
    await AppConfig.findOneAndUpdate(
      { key: "joining_fee" },
      {
        key: "joining_fee",
        value: 999,
        type: "NUMBER",
        category: "onboarding",
        description: "One-time joining fee per vehicle (in INR). Configurable from Admin Panel.",
        isEditable: true,
      },
      { upsert: true, new: true },
    );
    console.log("✅ App Config seeded");

    console.log("✅ Database seeding completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding database:", error);
    process.exit(1);
  }
};

seedDatabase();
