import Driver from "../models/driver.model";
import { sendToDriver } from "./notification.service";

let reminderInterval: NodeJS.Timeout | null = null;

// Thresholds in milliseconds
const REMINDER_THRESHOLDS = [
  { hours: 4, key: "4h" },
  { hours: 24, key: "24h" },
  { hours: 48, key: "48h" },
];

const REMINDER_MESSAGES: Record<string, { title: string; body: string }> = {
  "4h": {
    title: "Complete Your Onboarding",
    body: "You're almost there! Finish your registration to start earning with Movezy.",
  },
  "24h": {
    title: "Your Onboarding is Pending",
    body: "Complete your profile and vehicle details to get verified and start taking trips.",
  },
  "48h": {
    title: "Don't Miss Out!",
    body: "Your Movezy driver registration is still incomplete. Finish now and start earning!",
  },
};

/**
 * Check for drivers with incomplete onboarding and send reminders
 * at 4h, 24h, and 48h intervals after registration.
 */
export const checkOnboardingReminders = async () => {
  try {
    // Find drivers who haven't completed onboarding (status = draft, documents_uploaded, or vehicle_added)
    const incompleteDrivers = await Driver.find({
      status: { $in: ["draft", "documents_uploaded", "vehicle_added"] },
      isActive: true,
      isDeleted: { $ne: true },
      fcmToken: { $ne: null },
    }).select("_id fcmToken createdAt lastOnboardingReminder");

    const now = Date.now();
    let sentCount = 0;

    for (const driver of incompleteDrivers) {
      if (!driver.createdAt) continue;
      const createdAt = new Date(driver.createdAt).getTime();
      const elapsedMs = now - createdAt;
      const lastReminder = driver.lastOnboardingReminder
        ? new Date(driver.lastOnboardingReminder).getTime()
        : 0;

      // Find the highest threshold the driver has crossed
      let applicableReminder: (typeof REMINDER_THRESHOLDS)[number] | null = null;

      for (const threshold of REMINDER_THRESHOLDS) {
        const thresholdMs = threshold.hours * 60 * 60 * 1000;
        if (elapsedMs >= thresholdMs) {
          applicableReminder = threshold;
        }
      }

      if (!applicableReminder) continue;

      // Only send if we haven't sent a reminder at this threshold level yet
      const thresholdMs = applicableReminder.hours * 60 * 60 * 1000;
      const thresholdTime = createdAt + thresholdMs;

      // Skip if last reminder was sent after this threshold was crossed
      if (lastReminder >= thresholdTime) continue;

      const message = REMINDER_MESSAGES[applicableReminder.key];
      if (!message) continue;

      await sendToDriver(driver._id, "SYSTEM", message.title, message.body, {
        type: "onboarding_reminder",
        reminderLevel: applicableReminder.key,
      });

      await Driver.updateOne(
        { _id: driver._id },
        { lastOnboardingReminder: new Date() },
      );

      sentCount++;
    }

    if (sentCount > 0) {
      console.log(
        `[OnboardingReminder] Sent ${sentCount} reminder(s)`,
      );
    }
  } catch (error) {
    console.error("[OnboardingReminder] Error:", error);
  }
};

/**
 * Start the onboarding reminder checker (runs every 30 minutes)
 */
export const startOnboardingReminders = () => {
  if (reminderInterval) return;

  const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  // First check after 60 seconds (let server warm up)
  setTimeout(() => {
    checkOnboardingReminders();

    reminderInterval = setInterval(checkOnboardingReminders, INTERVAL_MS);
    console.log("[OnboardingReminder] Started — checking every 30 minutes");
  }, 60_000);
};

/**
 * Stop the onboarding reminder checker
 */
export const stopOnboardingReminders = () => {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
    console.log("[OnboardingReminder] Stopped");
  }
};
