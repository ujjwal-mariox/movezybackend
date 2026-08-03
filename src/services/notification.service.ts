import { Types } from "mongoose";
import {
  Notification,
  PushTemplate,
  NotificationCampaign,
  NotificationAudience,
} from "../models/notification.model";
import User from "../models/Users";
import Driver from "../models/driver.model";
import Booking from "../models/booking.model";
import * as SmsService from "./sms.service";
import { cache } from "../utils/redis.util";
import config from "../config";
import {
  initializeApp,
  cert,
  type App,
  type Credential,
} from "firebase-admin/app";
import {
  getMessaging,
  type Message,
  type MulticastMessage,
} from "firebase-admin/messaging";
import * as fs from "fs";

// Real Firebase Admin app, set only when valid credentials are configured.
// Stays null otherwise → push calls degrade to a no-op (logged) instead of
// throwing, so the app runs fine without FCM configured.
let firebaseApp: App | null = null;

/**
 * Build a service-account credential from config, supporting either a JSON
 * file path (FIREBASE_CREDENTIALS_PATH) or individual env fields. Returns null
 * when nothing usable is configured.
 */
const resolveFirebaseCredential = (): Credential | null => {
  const n = config.notifications;

  // Option A: service-account JSON file
  if (n.firebaseCredentials && fs.existsSync(n.firebaseCredentials)) {
    const serviceAccount = JSON.parse(
      fs.readFileSync(n.firebaseCredentials, "utf8"),
    );
    return cert(serviceAccount);
  }

  // Option B: individual fields. PRIVATE_KEY is commonly stored with literal
  // "\n" sequences (e.g. in a single-line env var) — normalise to real newlines.
  if (n.firebaseProjectId && n.firebaseClientEmail && n.firebasePrivateKey) {
    return cert({
      projectId: n.firebaseProjectId,
      clientEmail: n.firebaseClientEmail,
      privateKey: n.firebasePrivateKey.replace(/\\n/g, "\n"),
    });
  }

  return null;
};

/** True when real FCM is configured and ready to send. */
export const isPushConfigured = (): boolean => firebaseApp !== null;

/**
 * Initialize Firebase Admin SDK. Safe to call once at startup; no-ops cleanly
 * (and logs a warning) when credentials are absent.
 */
export const initializeFirebase = async () => {
  try {
    if (firebaseApp) return true;

    const credential = resolveFirebaseCredential();
    if (!credential) {
      console.warn(
        "⚠️  Firebase FCM not configured (no service account). Push notifications will be skipped.",
      );
      return true;
    }

    firebaseApp = initializeApp({ credential });
    console.log("✅ Firebase Admin SDK initialized (push notifications enabled)");
    return true;
  } catch (error) {
    console.error("Failed to initialize Firebase:", error);
    firebaseApp = null;
    return false;
  }
};

/**
 * Send push notification to a single device
 */
export const sendPushNotification = async (
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<boolean> => {
  try {
    if (!firebaseApp) {
      // FCM not configured → skip silently (logged), don't fail the caller.
      console.log("Push skipped (FCM not configured):", { title, body });
      return false;
    }

    const message: Message = {
      token: fcmToken,
      notification: { title, body },
      data: data || {},
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "movezy_channel",
          icon: "ic_notification",
          color: "#4CAF50",
        },
      },
      apns: {
        payload: {
          aps: { sound: "default" },
        },
      },
    };

    await getMessaging(firebaseApp).send(message);
    return true;
  } catch (error: any) {
    console.error("Failed to send push notification:", error);
    // Handle invalid tokens
    if (
      error.code === "messaging/invalid-registration-token" ||
      error.code === "messaging/registration-token-not-registered"
    ) {
      await removeInvalidToken(fcmToken);
    }
    return false;
  }
};

/**
 * Send push notification to multiple devices
 */
export const sendMulticastNotification = async (
  fcmTokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<{ successCount: number; failureCount: number }> => {
  try {
    if (fcmTokens.length === 0) {
      return { successCount: 0, failureCount: 0 };
    }

    if (!firebaseApp) {
      // FCM not configured → report 0 sent (do NOT fake success, which is why
      // the admin broadcast previously claimed delivery that never happened).
      console.log("Multicast skipped (FCM not configured):", {
        tokens: fcmTokens.length,
        title,
      });
      return { successCount: 0, failureCount: fcmTokens.length };
    }

    const message: MulticastMessage = {
      tokens: fcmTokens,
      notification: { title, body },
      data: data || {},
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "movezy_channel",
        },
      },
      apns: {
        payload: {
          aps: { sound: "default" },
        },
      },
    };

    const response = await getMessaging(firebaseApp).sendEachForMulticast(
      message,
    );

    // Handle failed tokens
    if (response.failureCount > 0) {
      const failedTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(fcmTokens[idx]);
        }
      });
      await Promise.all(
        failedTokens.map((token) => removeInvalidToken(token)),
      );
    }

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (error) {
    console.error("Failed to send multicast notification:", error);
    return { successCount: 0, failureCount: fcmTokens.length };
  }
};

/**
 * Remove invalid FCM token from database
 */
const removeInvalidToken = async (fcmToken: string) => {
  try {
    await User.updateMany({ fcmToken }, { $unset: { fcmToken: 1 } });
    await Driver.updateMany({ fcmToken }, { $unset: { fcmToken: 1 } });
  } catch (error) {
    console.error("Failed to remove invalid token:", error);
  }
};

/**
 * Send notification to user
 */
export const sendToUser = async (
  userId: Types.ObjectId,
  type: "BOOKING" | "PAYMENT" | "PROMO" | "SYSTEM" | "CHAT" | "REWARD",
  title: string,
  body: string,
  data?: Record<string, string>,
  referenceId?: Types.ObjectId,
  referenceType?: string,
): Promise<boolean> => {
  try {
    // Save notification to database
    const notification = new Notification({
      userId,
      type,
      title,
      body,
      data,
      referenceId,
      referenceType,
      isRead: false,
    });
    await notification.save();

    // Get user's FCM token.
    //
    // The opt-in flag on the User schema is `notificationAllowed`. This selected
    // and tested `isNotificationEnabled`, which is a Driver field and not a User
    // path at all, so it always read undefined and the customer's opt-out was
    // never consulted. Per-category preferences are checked too, now that
    // `notificationSettings` is a declared path and actually persists.
    const user = await User.findById(userId).select(
      "fcmToken notificationAllowed notificationSettings",
    );

    // Category keys are the lowercased notification type. REWARD has no toggle
    // of its own, so it is always allowed.
    const categoryAllowed =
      (user?.notificationSettings as any)?.[type.toLowerCase()] !== false;

    if (
      user?.fcmToken &&
      user.notificationAllowed !== false &&
      categoryAllowed
    ) {
      await sendPushNotification(user.fcmToken, title, body, {
        ...data,
        notificationId: notification._id.toString(),
        type,
      });
    }

    return true;
  } catch (error) {
    console.error("Failed to send notification to user:", error);
    return false;
  }
};

/**
 * Send notification to driver
 */
export const sendToDriver = async (
  driverId: Types.ObjectId,
  type: "BOOKING" | "PAYMENT" | "PROMO" | "SYSTEM" | "CHAT" | "REWARD",
  title: string,
  body: string,
  data?: Record<string, string>,
  referenceId?: Types.ObjectId,
  referenceType?: string,
): Promise<boolean> => {
  try {
    // Save notification to database
    const notification = new Notification({
      driverId,
      type,
      title,
      body,
      data,
      referenceId,
      referenceType,
      isRead: false,
    });
    await notification.save();

    // Get driver's FCM token
    const driver = await Driver.findById(driverId).select(
      "fcmToken isNotificationEnabled",
    );

    if (driver?.fcmToken && driver.isNotificationEnabled !== false) {
      await sendPushNotification(driver.fcmToken, title, body, {
        ...data,
        notificationId: notification._id.toString(),
        type,
      });
    }

    return true;
  } catch (error) {
    console.error("Failed to send notification to driver:", error);
    return false;
  }
};

/**
 * Send notification using template
 */
export const sendUsingTemplate = async (
  templateKey: string,
  recipientId: Types.ObjectId,
  recipientType: "USER" | "DRIVER",
  variables: Record<string, string>,
  referenceId?: Types.ObjectId,
  referenceType?: string,
): Promise<boolean> => {
  try {
    // Get template from cache or database
    let template = await cache.get<any>(`push_template:${templateKey}`);

    if (!template) {
      template = await PushTemplate.findOne({
        key: templateKey,
        isActive: true,
      });
      if (template) {
        await cache.set(`push_template:${templateKey}`, template, 3600);
      }
    }

    if (!template) {
      console.error(`Push template not found: ${templateKey}`);
      return false;
    }

    // Replace variables in template
    let title = template.title;
    let body = template.body;

    Object.entries(variables).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, "g");
      title = title.replace(regex, value);
      body = body.replace(regex, value);
    });

    // Send notification
    if (recipientType === "USER") {
      return await sendToUser(
        recipientId,
        template.type,
        title,
        body,
        variables,
        referenceId,
        referenceType,
      );
    } else {
      return await sendToDriver(
        recipientId,
        template.type,
        title,
        body,
        variables,
        referenceId,
        referenceType,
      );
    }
  } catch (error) {
    console.error("Failed to send notification using template:", error);
    return false;
  }
};

/**
 * Get user notifications
 */
export const getUserNotifications = async (
  userId: Types.ObjectId,
  page: number = 1,
  limit: number = 20,
) => {
  const skip = (page - 1) * limit;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Notification.countDocuments({ userId }),
    Notification.countDocuments({ userId, isRead: false }),
  ]);

  return {
    notifications,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
    unreadCount,
  };
};

/**
 * Get driver notifications
 */
export const getDriverNotifications = async (
  driverId: Types.ObjectId,
  page: number = 1,
  limit: number = 20,
) => {
  const skip = (page - 1) * limit;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find({ driverId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Notification.countDocuments({ driverId }),
    Notification.countDocuments({ driverId, isRead: false }),
  ]);

  return {
    notifications,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
    unreadCount,
  };
};

/**
 * Mark notification as read
 */
export const markAsRead = async (
  notificationId: Types.ObjectId,
  userId?: Types.ObjectId,
  driverId?: Types.ObjectId,
) => {
  const query: any = { _id: notificationId };
  if (userId) query.userId = userId;
  if (driverId) query.driverId = driverId;

  await Notification.updateOne(query, { isRead: true });
};

/**
 * Mark all notifications as read
 */
export const markAllAsRead = async (
  userId?: Types.ObjectId,
  driverId?: Types.ObjectId,
) => {
  const query: any = { isRead: false };
  if (userId) query.userId = userId;
  if (driverId) query.driverId = driverId;

  await Notification.updateMany(query, { isRead: true });
};

/**
 * Delete old notifications (cleanup job)
 */
export const deleteOldNotifications = async (daysOld: number = 30) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  const result = await Notification.deleteMany({
    createdAt: { $lt: cutoffDate },
    isRead: true,
  });

  return result.deletedCount;
};

/**
 * Send booking status notification
 */
export const sendBookingStatusNotification = async (
  userId: Types.ObjectId,
  bookingId: Types.ObjectId,
  status: string,
  driverName?: string,
) => {
  const statusMessages: Record<string, { title: string; body: string }> = {
    ASSIGNED: {
      title: "Driver Assigned",
      body: `${driverName || "A driver"} has been assigned to your booking.`,
    },
    DRIVER_ARRIVED: {
      title: "Driver Arrived",
      body: "Your driver has arrived at the pickup location.",
    },
    // Key must match the Booking status enum ("PICKED"); the old "PICKED_UP"
    // matched nothing and made this a silent no-op.
    PICKED: {
      title: "Goods Picked Up",
      body: "Your goods have been picked up and are on the way.",
    },
    IN_PROGRESS: {
      title: "On the Way",
      body: "Your delivery is on the way to the drop location.",
    },
    COMPLETED: {
      title: "Delivery Completed",
      body: "Your delivery has been completed successfully!",
    },
    CANCELLED: {
      title: "Booking Cancelled",
      body: "Your booking has been cancelled.",
    },
  };

  const message = statusMessages[status];
  if (!message) return false;

  return await sendToUser(
    userId,
    "BOOKING",
    message.title,
    message.body,
    { bookingId: bookingId.toString(), status },
    bookingId,
    "Booking",
  );
};

/**
 * Send promotional notification to all users
 */
export const sendPromoNotification = async (
  title: string,
  body: string,
  promoCode?: string,
  targetAudience?: "ALL" | "ACTIVE" | "INACTIVE",
) => {
  // `notificationAllowed` is the real User path — filtering on
  // `isNotificationEnabled: true` matched no customer at all, so this promo
  // broadcast always resolved to an empty audience.
  const query: any = { isActive: true, notificationAllowed: { $ne: false } };

  if (targetAudience === "ACTIVE") {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    query.lastActiveAt = { $gte: thirtyDaysAgo };
  } else if (targetAudience === "INACTIVE") {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    query.lastActiveAt = { $lt: thirtyDaysAgo };
  }

  const users = await User.find(query).select("_id fcmToken");

  const fcmTokens = users
    .filter((u) => u.fcmToken)
    .map((u) => u.fcmToken as string);

  // Save notifications for all users
  const notifications = users.map((user) => ({
    userId: user._id,
    type: "PROMO",
    title,
    body,
    data: promoCode ? { promoCode } : undefined,
    isRead: false,
  }));

  await Notification.insertMany(notifications);

  // Send push notifications in batches of 500
  const batchSize = 500;
  let totalSuccess = 0;
  let totalFailure = 0;

  for (let i = 0; i < fcmTokens.length; i += batchSize) {
    const batch = fcmTokens.slice(i, i + batchSize);
    const result = await sendMulticastNotification(batch, title, body, {
      promoCode: promoCode || "",
    });
    totalSuccess += result.successCount;
    totalFailure += result.failureCount;
  }

  return {
    totalUsers: users.length,
    successCount: totalSuccess,
    failureCount: totalFailure,
  };
};

/* ============================================================
   Admin Notification Center — Templates, Campaigns, Analytics
   ============================================================ */

export const listTemplates = async (filters: {
  type?: string;
  audience?: NotificationAudience;
  isActive?: boolean;
  search?: string;
}) => {
  const query: any = {};
  if (filters.type) query.type = filters.type;
  if (filters.audience) query.audience = filters.audience;
  if (typeof filters.isActive === "boolean") query.isActive = filters.isActive;
  if (filters.search) {
    const rx = new RegExp(filters.search.trim(), "i");
    query.$or = [{ name: rx }, { code: rx }, { title: rx }, { body: rx }, { tags: rx }];
  }
  return await PushTemplate.find(query).sort({ useCount: -1, createdAt: -1 });
};

export const createTemplate = async (data: {
  name: string;
  code: string;
  title: string;
  body: string;
  type: string;
  audience?: NotificationAudience;
  variables?: string[];
  priority?: string;
  tags?: string[];
  isActive?: boolean;
}) => {
  return await PushTemplate.create({
    ...data,
    audience: data.audience || "ALL",
    variables: data.variables || [],
    tags: data.tags || [],
  });
};

export const updateTemplate = async (id: string, data: Record<string, any>) => {
  const updated = await PushTemplate.findByIdAndUpdate(id, data, { new: true });
  if (updated) {
    await cache.del(`push_template:${updated.code}`);
  }
  return updated;
};

export const deleteTemplate = async (id: string) => {
  const t = await PushTemplate.findByIdAndDelete(id);
  if (t) await cache.del(`push_template:${t.code}`);
  return t;
};

export const getTemplate = async (id: string) =>
  await PushTemplate.findById(id);

/* Campaigns / History */

export const listCampaigns = async (filters: {
  audience?: NotificationAudience;
  type?: string;
  status?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  limit?: number;
}) => {
  const query: any = {};
  if (filters.audience) query.audience = filters.audience;
  if (filters.type) query.type = filters.type;
  if (filters.status) query.status = filters.status;
  if (filters.search) {
    const rx = new RegExp(filters.search.trim(), "i");
    query.$or = [{ title: rx }, { body: rx }];
  }
  if (filters.dateFrom || filters.dateTo) {
    query.createdAt = {};
    if (filters.dateFrom) query.createdAt.$gte = filters.dateFrom;
    if (filters.dateTo) query.createdAt.$lte = filters.dateTo;
  }
  const page = filters.page ?? 0;
  const limit = filters.limit ?? 20;
  const [campaigns, total] = await Promise.all([
    NotificationCampaign.find(query)
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit),
    NotificationCampaign.countDocuments(query),
  ]);
  return { campaigns, total, page, limit };
};

export const sendBroadcast = async (params: {
  title: string;
  body: string;
  type: "BOOKING" | "PAYMENT" | "PROMO" | "SYSTEM" | "CHAT" | "REWARD";
  audience: NotificationAudience;
  templateId?: Types.ObjectId;
  data?: Record<string, any>;
  createdBy?: Types.ObjectId;
  /** When set, restrict the DRIVERS audience to exactly these drivers.
   *  The compliance page's "notify selected" always passed ids in `data`,
   *  and this function ignored them — spamming the whole fleet while the UI
   *  claimed a targeted send. */
  driverIds?: string[];
  /** Same, for the USERS audience. */
  userIds?: string[];
}) => {
  const campaign = await NotificationCampaign.create({
    title: params.title,
    body: params.body,
    type: params.type,
    audience: params.audience,
    templateId: params.templateId,
    data: params.data,
    createdBy: params.createdBy,
    status: "SENDING",
  });

  // Determine recipients
  const tokens: string[] = [];
  let targeted = 0;

  if (params.audience === "USERS" || params.audience === "ALL") {
    const userFilter: Record<string, any> = { isActive: true };
    if (params.userIds?.length) {
      userFilter._id = { $in: params.userIds };
    }
    // `notificationAllowed` is the User schema's opt-in flag;
    // `isNotificationEnabled` is a Driver field and was always undefined here,
    // so a customer's opt-out was never honoured on broadcasts either.
    const users = await User.find(userFilter).select(
      "_id fcmToken notificationAllowed",
    );
    const list = users.filter((u: any) => u.notificationAllowed !== false);
    targeted += list.length;
    list.forEach((u: any) => {
      if (u.fcmToken) tokens.push(u.fcmToken);
    });
    // Persist user inbox
    if (list.length) {
      await Notification.insertMany(
        list.map((u: any) => ({
          userId: u._id,
          type: params.type,
          title: params.title,
          body: params.body,
          data: params.data,
          isRead: false,
          isSent: true,
          sentAt: new Date(),
        })),
      );
    }
  }

  if (params.audience === "DRIVERS" || params.audience === "ALL") {
    const driverFilter: Record<string, any> = { isActive: true };
    if (params.driverIds?.length) {
      driverFilter._id = { $in: params.driverIds };
    }
    const drivers = await Driver.find(driverFilter).select(
      "_id fcmToken isNotificationEnabled",
    );
    const list = drivers.filter((d: any) => d.isNotificationEnabled !== false);
    targeted += list.length;
    list.forEach((d: any) => {
      if (d.fcmToken) tokens.push(d.fcmToken);
    });
    if (list.length) {
      await Notification.insertMany(
        list.map((d: any) => ({
          driverId: d._id,
          type: params.type,
          title: params.title,
          body: params.body,
          data: params.data,
          isRead: false,
          isSent: true,
          sentAt: new Date(),
        })),
      );
    }
  }

  // Push in batches of 500
  const batchSize = 500;
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    const result = await sendMulticastNotification(
      batch,
      params.title,
      params.body,
      params.data as Record<string, string> | undefined,
    );
    sent += result.successCount;
    failed += result.failureCount;
  }

  if (params.templateId) {
    await PushTemplate.findByIdAndUpdate(params.templateId, {
      $inc: { useCount: 1 },
    });
  }

  const finalCampaign = await NotificationCampaign.findByIdAndUpdate(
    campaign._id,
    {
      targetedCount: targeted,
      // How many of those recipients could receive a push at all. Recorded so a
      // "targeted 5,000 / sent 0" row is explicable instead of reading as a
      // successful broadcast that reached nobody: the in-app inbox rows above
      // were written for all `targeted`, the push only for these.
      pushTargetedCount: tokens.length,
      sentCount: sent,
      failedCount: failed,
      status: failed > 0 && sent === 0 ? "FAILED" : "SENT",
      sentAt: new Date(),
    },
    { new: true },
  );

  return finalCampaign;
};

export const getNotificationAnalytics = async () => {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [sent24h, sent7d, totalSent, totalRead, byType, recentCampaigns] =
    await Promise.all([
      Notification.countDocuments({ sentAt: { $gte: last24h } }),
      Notification.countDocuments({ sentAt: { $gte: last7d } }),
      Notification.countDocuments({ isSent: true }),
      Notification.countDocuments({ isRead: true }),
      Notification.aggregate([
        { $match: { sentAt: { $gte: last7d } } },
        { $group: { _id: "$type", count: { $sum: 1 } } },
      ]),
      NotificationCampaign.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("createdBy", "fullName"),
    ]);

  const readRate = totalSent > 0 ? (totalRead / totalSent) * 100 : 0;

  return {
    sent24h,
    sent7d,
    totalSent,
    totalRead,
    readRate: Math.round(readRate * 10) / 10,
    byType,
    recentCampaigns,
  };
};

/**
 * Tell the consignee (the person receiving the parcel) that it is on its way.
 *
 * The consignee is NOT an app user — they have no account and no FCM token — so
 * SMS is the only channel that can reach them. Sent once, on pickup.
 *
 * Returns true only if the SMS was actually delivered. Never throws: this is a
 * side-channel to the driver completing pickup and must not fail that.
 */
export const notifyConsigneePickup = async (booking: any): Promise<boolean> => {
  const phone = booking?.receiverPhone;
  if (!phone) return false;

  // Guard against a retried pickup re-sending the same SMS.
  if (booking.consigneeNotifiedAt) return false;

  const name = booking.receiverName ? `Hi ${booking.receiverName}, ` : "";
  const ref = booking.bookingNumber ? ` (${booking.bookingNumber})` : "";
  const dropTo = booking.drop?.address ? ` to ${booking.drop.address}` : "";
  const message =
    `${name}your parcel${ref} has been picked up and is on its way${dropTo}. ` +
    `Track it in the Movezy app. - Movezy`;

  const sent = await SmsService.sendSms(phone, message).catch(() => false);

  if (sent) {
    // Stamp only on real delivery, so a failed send retries on a later event
    // rather than being silently marked done.
    await Booking.findByIdAndUpdate(booking._id, {
      consigneeNotifiedAt: new Date(),
    }).catch(() => null);
  }
  return sent;
};
