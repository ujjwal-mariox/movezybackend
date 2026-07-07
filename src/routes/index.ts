import { Router } from "express";

import authRoutes from "./auth.routes";
import userRoutes from "./user.routes";
import walletRoutes from "./wallet.routes";
import homeRoutes from "./home.routes";
import driverAuthRoutes from "./driver-auth.routes";
import driverRoutes from "./driver.routes";
import adminRoutes from "./admin.routes";
import bookingRoutes from "./booking.routes";
import supportRoutes from "./support.routes";
import coinRoutes from "./coin.routes";
import promoRoutes from "./promo.routes";
import notificationRoutes from "./notification.routes";
import paymentRoutes from "./payment.routes";
import enterpriseRoutes from "./enterprise.routes";
import sosRoutes from "./sos.routes";
import trackingRoutes from "./tracking.routes";
import chatRoutes from "./chat.routes";

const router = Router();

// Home page route (public)
router.use("/home", homeRoutes);

// Auth routes (public)
router.use("/auth", authRoutes);

// User routes
router.use("/user", userRoutes);

// Wallet routes
router.use("/wallet", walletRoutes);

// Booking routes
router.use("/bookings", bookingRoutes);

// Support routes
router.use("/support", supportRoutes);

// Coin/Rewards routes
router.use("/coins", coinRoutes);

// Promo code routes
router.use("/promos", promoRoutes);

// Notification routes
router.use("/notifications", notificationRoutes);

// Payment routes
router.use("/payments", paymentRoutes);

// Enterprise routes
router.use("/enterprise", enterpriseRoutes);

// SOS/Emergency routes
router.use("/sos", sosRoutes);

// Tracking routes
router.use("/tracking", trackingRoutes);

// Chat routes (user-facing REST: history + image upload; real-time via Socket.io)
router.use("/chat", chatRoutes);

// Driver Auth routes (login, KYC, onboarding)
router.use("/driver", driverAuthRoutes);

// Driver App routes (authenticated driver features)
router.use("/driver/app", driverRoutes);

// Admin routes
router.use("/admin", adminRoutes);

export default router;
