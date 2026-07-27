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

// Support contact the apps dial. Public: it is a published number, and the
// apps need it before a user is authenticated (e.g. help from the login screen).
router.get("/support-contact", async (_req, res) => {
  try {
    const doc = await AppConfig.findOne({ key: "SUPPORT_PHONE" }).lean();
    res.json({
      success: true,
      data: {
        supportPhone: (doc as any)?.value ? String((doc as any).value) : "",
      },
    });
  } catch {
    // Never fail a screen over a contact number — an empty value simply hides
    // the call buttons.
    res.json({ success: true, data: { supportPhone: "" } });
  }
});

// Public legal/informational content (terms, privacy, about, refund,
// cancellation) — read-only, no auth, edited from the admin CMS.
import { getPublicContent } from "../controllers/admin/content.controller";
import { AppConfig } from "../models/app-config.model";
import ErrorHandlerMiddleware from "../middlewares/error-handler.middleware";
import ResponseMiddleware from "../middlewares/response.middleware";
router.get(
  "/content/:type",
  ErrorHandlerMiddleware(getPublicContent),
  ResponseMiddleware,
);

// Road routing for the maps in both apps. Open (same trust level as the OSM
// tiles the apps already fetch) and cached server-side; returns null-ish 404
// so callers fall back to a straight line rather than breaking the screen.
import { getRoute } from "../services/routing.service";
router.get(
  "/routing/route",
  ErrorHandlerMiddleware(async (req: any, res: any) => {
    const fromLat = Number(req.query.fromLat);
    const fromLng = Number(req.query.fromLng);
    const toLat = Number(req.query.toLat);
    const toLng = Number(req.query.toLng);

    const route = await getRoute(fromLat, fromLng, toLat, toLng);
    if (!route) {
      return res
        .status(404)
        .json({ success: false, message: "Route unavailable" });
    }
    res.locals.data = { route };
  }),
  ResponseMiddleware,
);

// Admin routes
router.use("/admin", adminRoutes);

export default router;
