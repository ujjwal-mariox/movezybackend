import { Router } from "express";
import * as AdminAuthController from "../controllers/admin/admin-auth.controller";
import * as BookingController from "../controllers/admin/booking.controller";
import * as UserController from "../controllers/admin/user.controller";
import * as DriverController from "../controllers/admin/driver.controller";
import * as PromoController from "../controllers/admin/promo.controller";
import * as UserDiscountController from "../controllers/admin/user-discount.controller";
import * as OnboardingCouponController from "../controllers/admin/onboarding-coupon.controller";
import * as ConfigController from "../controllers/admin/config.controller";
import * as ContentController from "../controllers/admin/content.controller";
import * as FaqController from "../controllers/admin/faq.controller";
import * as SupportController from "../controllers/admin/support.controller";
import * as ReportsController from "../controllers/admin/reports.controller";
import * as ScheduledReportController from "../controllers/admin/scheduled-report.controller";
import * as PayoutController from "../controllers/admin/payout.controller";
import * as CoinPayoutController from "../controllers/admin/coin-payout.controller";
import * as TrainingProgramController from "../controllers/admin/training-program.controller";
import * as EnterpriseController from "../controllers/admin/enterprise.controller";
import * as SOSController from "../controllers/admin/sos.controller";
import * as TrackingController from "../controllers/admin/tracking.controller";
import * as NotificationController from "../controllers/admin/notification.controller";
import * as StaffController from "../controllers/admin/staff.controller";
import * as AuditLogController from "../controllers/admin/audit-log.controller";
import * as AutomationController from "../controllers/admin/automation.controller";
import * as FinanceController from "../controllers/admin/finance.controller";
import * as DriverInstructionController from "../controllers/admin/driver-instruction.controller";
import * as BadgeController from "../controllers/admin/badge.controller";
import * as TrainingController from "../controllers/admin/training.controller";
import * as RefundController from "../controllers/admin/refund.controller";
import * as EnhancedFinanceController from "../controllers/admin/enhanced-finance.controller";
import * as EnhancedDriverController from "../controllers/admin/enhanced-driver.controller";
import * as EnterpriseCreditController from "../controllers/admin/enterprise-credit.controller";
import * as SessionController from "../controllers/admin/session.controller";
import AdminAuthMiddleware from "../middlewares/admin-auth.middleware";
import ErrorHandlerMiddleware from "../middlewares/error-handler.middleware";
import ResponseMiddleware from "../middlewares/response.middleware";
import {
  requireComment,
  requireCommentAndAudit,
} from "../middlewares/mandatory-comment.middleware";
import upload from "../middlewares/upload.middleware";
import { PERMISSIONS } from "../models/role.model";

const adminRouter = Router();
const { verifyAdminToken, requirePermission } = AdminAuthMiddleware();

// ============ AUTH ============
adminRouter.post(
  "/auth/login",
  ErrorHandlerMiddleware(AdminAuthController.login),
  ResponseMiddleware,
);

adminRouter.post(
  "/auth/forgot-password",
  ErrorHandlerMiddleware(AdminAuthController.forgotPassword),
  ResponseMiddleware,
);

adminRouter.post(
  "/auth/reset-password",
  ErrorHandlerMiddleware(AdminAuthController.resetPassword),
  ResponseMiddleware,
);

adminRouter.get(
  "/auth/me",
  verifyAdminToken,
  ErrorHandlerMiddleware(AdminAuthController.getProfile),
  ResponseMiddleware,
);

adminRouter.post(
  "/auth/logout",
  verifyAdminToken,
  ErrorHandlerMiddleware(AdminAuthController.logout),
  ResponseMiddleware,
);

// ============ DASHBOARD ============
adminRouter.get(
  "/dashboard/stats",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  ErrorHandlerMiddleware(ReportsController.getDashboardStats),
  ResponseMiddleware,
);

// ============ USERS ============
adminRouter.get(
  "/users",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_VIEW),
  ErrorHandlerMiddleware(UserController.getAllUsers),
  ResponseMiddleware,
);

adminRouter.get(
  "/users/stats",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_VIEW),
  ErrorHandlerMiddleware(UserController.getUserStats),
  ResponseMiddleware,
);

adminRouter.get(
  "/users/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_VIEW),
  ErrorHandlerMiddleware(UserController.getUserById),
  ResponseMiddleware,
);

adminRouter.put(
  "/users/:id/status",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.updateUserStatus),
  ResponseMiddleware,
);

adminRouter.put(
  "/users/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.updateUser),
  ResponseMiddleware,
);

adminRouter.put(
  "/users/:id/block",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.blockUser),
  ResponseMiddleware,
);

adminRouter.put(
  "/users/:id/unblock",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.unblockUser),
  ResponseMiddleware,
);

adminRouter.delete(
  "/users/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_DELETE),
  ErrorHandlerMiddleware(UserController.deleteUser),
  ResponseMiddleware,
);

adminRouter.get(
  "/users/:id/bookings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_VIEW),
  ErrorHandlerMiddleware(UserController.getUserBookings),
  ResponseMiddleware,
);

adminRouter.get(
  "/users/:id/wallet",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_VIEW),
  ErrorHandlerMiddleware(UserController.getUserWallet),
  ResponseMiddleware,
);

adminRouter.get(
  "/users/:id/transactions",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_VIEW),
  ErrorHandlerMiddleware(UserController.getUserTransactions),
  ResponseMiddleware,
);

adminRouter.post(
  "/users/:id/coins/adjust",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.adjustUserCoins),
  ResponseMiddleware,
);

// Add balance to a user's wallet (records a WalletTransaction + audit log)
adminRouter.post(
  "/users/:id/wallet/add",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.addWalletBalance),
  ResponseMiddleware,
);

adminRouter.put(
  "/users/:id/restore",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.restoreUser),
  ResponseMiddleware,
);

// ============ USER ADDRESSES ============
adminRouter.get(
  "/users/:id/addresses",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_VIEW),
  ErrorHandlerMiddleware(UserController.getUserAddresses),
  ResponseMiddleware,
);

adminRouter.post(
  "/users/:id/addresses",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.addUserAddress),
  ResponseMiddleware,
);

adminRouter.put(
  "/users/:id/addresses/:addressId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.updateUserAddress),
  ResponseMiddleware,
);

adminRouter.delete(
  "/users/:id/addresses/:addressId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.deleteUserAddress),
  ResponseMiddleware,
);

adminRouter.put(
  "/users/:id/addresses/:addressId/primary",
  verifyAdminToken,
  requirePermission(PERMISSIONS.USERS_UPDATE),
  ErrorHandlerMiddleware(UserController.setAddressPrimary),
  ResponseMiddleware,
);

// ============ DRIVERS ============
adminRouter.get(
  "/drivers",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(DriverController.getAllDrivers),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/pending-verification",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(DriverController.getPendingVerifications),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/stats",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(DriverController.getDriverStats),
  ResponseMiddleware,
);

// Static /drivers/* paths MUST be registered before /drivers/:id — Express
// matches in order, so anything after would be captured as :id ("cod-summary"
// etc. → ObjectId cast error). These four were previously registered ~1700
// lines below and were therefore unreachable.
adminRouter.get(
  "/drivers/cod-summary",
  verifyAdminToken,
  requirePermission(PERMISSIONS.COD_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getAllDriversCODSummary),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/expiring-documents",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getExpiringDocuments),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/late-delivery-metrics",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getLateDeliveryMetrics),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/device-info",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getDeviceInfoSummary),
  ResponseMiddleware,
);

// Queue of vehicles awaiting approval (approved drivers' added vehicles
// included — the driver-level pending count misses those entirely).
//
// MUST stay above "/drivers/:id": Express matches in registration order, so
// while this sat further down, GET /drivers/pending-vehicles was captured by
// :id, and the handler rejected "pending-vehicles" as an invalid ObjectId —
// the queue answered 400 on every dashboard load.
adminRouter.get(
  "/drivers/pending-vehicles",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(DriverController.listPendingVehicles),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(DriverController.getDriverById),
  ResponseMiddleware,
);

adminRouter.put(
  "/drivers/:id/block",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_BLOCK),
  ErrorHandlerMiddleware(DriverController.blockDriver),
  ResponseMiddleware,
);

adminRouter.post(
  "/drivers/:id/notify",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_UPDATE),
  ErrorHandlerMiddleware(DriverController.notifyDriver),
  ResponseMiddleware,
);

adminRouter.put(
  "/drivers/:id/verify",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VERIFY),
  ErrorHandlerMiddleware(DriverController.verifyDriver),
  ResponseMiddleware,
);

adminRouter.put(
  "/drivers/:id/status",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_UPDATE),
  ErrorHandlerMiddleware(DriverController.updateDriverStatus),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/:id/documents",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(DriverController.getDriverDocuments),
  ResponseMiddleware,
);

// Approve/reject a SINGLE document. Needs the same permission as approving a
// driver, since it is part of the same review decision.
adminRouter.put(
  "/drivers/:id/documents/:docType/verify",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VERIFY),
  ErrorHandlerMiddleware(DriverController.verifyDriverDocument),
  ResponseMiddleware,
);

adminRouter.put(
  "/drivers/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_UPDATE),
  ErrorHandlerMiddleware(DriverController.updateDriver),
  ResponseMiddleware,
);

adminRouter.put(
  "/drivers/:id/bank-details",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_UPDATE),
  ErrorHandlerMiddleware(DriverController.updateBankDetails),
  ResponseMiddleware,
);

adminRouter.put(
  "/drivers/:id/bank-details/verify",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VERIFY),
  ErrorHandlerMiddleware(DriverController.verifyBankDetails),
  ResponseMiddleware,
);

// Approve/reject a driver's pending bank-details CHANGE request (drivers can
// no longer overwrite an account already on file — see the driver-side PUT).
adminRouter.put(
  "/drivers/:id/bank-request",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_UPDATE),
  ErrorHandlerMiddleware(DriverController.decideBankUpdateRequest),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/:id/vehicles",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(DriverController.getDriverVehicles),
  ResponseMiddleware,
);

// Per-vehicle approval. Driver-level verify blanket-updates all vehicles and
// is unreachable once the driver is approved, so an added 2nd vehicle had no
// approval path at all.
adminRouter.put(
  "/drivers/:id/vehicles/:vehicleId/verify",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VERIFY),
  ErrorHandlerMiddleware(DriverController.verifyDriverVehicle),
  ResponseMiddleware,
);

adminRouter.delete(
  "/drivers/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_DELETE),
  ErrorHandlerMiddleware(DriverController.deleteDriver),
  ResponseMiddleware,
);

adminRouter.put(
  "/drivers/:id/restore",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_UPDATE),
  ErrorHandlerMiddleware(DriverController.restoreDriver),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/:id/bookings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(DriverController.getDriverBookings),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/:id/earnings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(DriverController.getDriverEarnings),
  ResponseMiddleware,
);

// ============ BOOKINGS ============
adminRouter.get(
  "/bookings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BOOKINGS_VIEW),
  ErrorHandlerMiddleware(BookingController.getAllBookings),
  ResponseMiddleware,
);

// Auto-assign — static path MUST precede /bookings/:id (else "auto-assign" is
// captured as an id and cast to ObjectId → 500).
adminRouter.post(
  "/bookings/auto-assign",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BOOKINGS_UPDATE),
  ErrorHandlerMiddleware(BookingController.autoAssignBookings),
  ResponseMiddleware,
);

adminRouter.get(
  "/bookings/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BOOKINGS_VIEW),
  ErrorHandlerMiddleware(BookingController.getBookingById),
  ResponseMiddleware,
);

adminRouter.put(
  "/bookings/:id/cancel",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BOOKINGS_UPDATE),
  // Cancelling someone's trip — often with a refund attached — was the one
  // destructive booking action with no mandatory reason and no audit row.
  // "booking:cancel" is already in MANDATORY_COMMENT_ACTIONS.
  ...requireCommentAndAudit("booking:cancel", "Booking"),
  ErrorHandlerMiddleware(BookingController.cancelBooking),
  ResponseMiddleware,
);

adminRouter.put(
  "/bookings/:id/refund",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BOOKINGS_REFUND),
  ErrorHandlerMiddleware(BookingController.processRefund),
  ResponseMiddleware,
);

adminRouter.put(
  "/bookings/:id/assign-driver",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BOOKINGS_UPDATE),
  ErrorHandlerMiddleware(BookingController.assignDriver),
  ResponseMiddleware,
);

// ============ DRIVER ONBOARDING COUPONS ============
adminRouter.get(
  "/onboarding-coupons",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_VIEW),
  ErrorHandlerMiddleware(OnboardingCouponController.listCoupons),
  ResponseMiddleware,
);

adminRouter.post(
  "/onboarding-coupons",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_CREATE),
  ErrorHandlerMiddleware(OnboardingCouponController.createCoupon),
  ResponseMiddleware,
);

adminRouter.put(
  "/onboarding-coupons/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_UPDATE),
  ErrorHandlerMiddleware(OnboardingCouponController.updateCoupon),
  ResponseMiddleware,
);

adminRouter.delete(
  "/onboarding-coupons/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_DELETE),
  ErrorHandlerMiddleware(OnboardingCouponController.deleteCoupon),
  ResponseMiddleware,
);

// ============ CUSTOMER DISCOUNTS (strikethrough pricing) ============
// Grouped with promos and gated by the same permissions: both are money-off
// configuration owned by the same admin role.
adminRouter.get(
  "/user-discounts",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_VIEW),
  ErrorHandlerMiddleware(UserDiscountController.listUserDiscounts),
  ResponseMiddleware,
);

adminRouter.post(
  "/user-discounts",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_CREATE),
  ErrorHandlerMiddleware(UserDiscountController.createUserDiscount),
  ResponseMiddleware,
);

adminRouter.put(
  "/user-discounts/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_UPDATE),
  ErrorHandlerMiddleware(UserDiscountController.updateUserDiscount),
  ResponseMiddleware,
);

adminRouter.delete(
  "/user-discounts/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_DELETE),
  ErrorHandlerMiddleware(UserDiscountController.deleteUserDiscount),
  ResponseMiddleware,
);

// ============ PROMO CODES ============

adminRouter.get(
  "/promos",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_VIEW),
  ErrorHandlerMiddleware(PromoController.getAllPromos),
  ResponseMiddleware,
);

adminRouter.post(
  "/promos",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_CREATE),
  ErrorHandlerMiddleware(PromoController.createPromo),
  ResponseMiddleware,
);

adminRouter.get(
  "/promos/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_VIEW),
  ErrorHandlerMiddleware(PromoController.getPromoById),
  ResponseMiddleware,
);

adminRouter.put(
  "/promos/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_UPDATE),
  ErrorHandlerMiddleware(PromoController.updatePromo),
  ResponseMiddleware,
);

adminRouter.delete(
  "/promos/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_DELETE),
  ErrorHandlerMiddleware(PromoController.deletePromo),
  ResponseMiddleware,
);

adminRouter.put(
  "/promos/:id/toggle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_UPDATE),
  ErrorHandlerMiddleware(PromoController.togglePromo),
  ResponseMiddleware,
);

adminRouter.get(
  "/promos/:id/stats",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PROMOS_VIEW),
  ErrorHandlerMiddleware(PromoController.getPromoStats),
  ResponseMiddleware,
);

// ============ FAQs (Help & Support content) ============
// Same gate as the other CMS content: FAQs are support copy, and the apps
// read them cached — the controller invalidates on every write.
adminRouter.get(
  "/faqs",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(FaqController.listFaqs),
  ResponseMiddleware,
);

adminRouter.post(
  "/faqs",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(FaqController.createFaq),
  ResponseMiddleware,
);

adminRouter.put(
  "/faqs/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(FaqController.updateFaq),
  ResponseMiddleware,
);

adminRouter.delete(
  "/faqs/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(FaqController.deleteFaq),
  ResponseMiddleware,
);

// ============ CONTENT (Terms / Privacy / About / Refund / Cancellation) ============
adminRouter.get(
  "/content",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ContentController.listContent),
  ResponseMiddleware,
);

adminRouter.get(
  "/content/:type",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ContentController.getContentByType),
  ResponseMiddleware,
);

adminRouter.put(
  "/content/:type",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ContentController.updateContent),
  ResponseMiddleware,
);

// ============ CONFIG ============
// Support number both apps dial. Blank = call buttons hidden.
adminRouter.get(
  "/config/support-contact",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getSupportContact),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/support-contact",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateSupportContact),
  ResponseMiddleware,
);

adminRouter.get(
  "/config/fare",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getFareConfig),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/fare",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateFareConfig),
  ResponseMiddleware,
);

adminRouter.get(
  "/config/vehicle-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.VEHICLES_VIEW),
  ErrorHandlerMiddleware(ConfigController.getVehicleTypes),
  ResponseMiddleware,
);

adminRouter.post(
  "/config/vehicle-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.VEHICLES_CREATE),
  upload.single("image"),
  ErrorHandlerMiddleware(ConfigController.createVehicleType),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/vehicle-types/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.VEHICLES_UPDATE),
  upload.single("image"),
  ErrorHandlerMiddleware(ConfigController.updateVehicleType),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/vehicle-types/:id/toggle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.VEHICLES_UPDATE),
  ErrorHandlerMiddleware(ConfigController.toggleVehicleType),
  ResponseMiddleware,
);

adminRouter.delete(
  "/config/vehicle-types/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.VEHICLES_DELETE),
  ErrorHandlerMiddleware(ConfigController.deleteVehicleType),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/vehicle-types/:id/restore",
  verifyAdminToken,
  requirePermission(PERMISSIONS.VEHICLES_UPDATE),
  ErrorHandlerMiddleware(ConfigController.restoreVehicleType),
  ResponseMiddleware,
);

adminRouter.get(
  "/config/service-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getServiceTypes),
  ResponseMiddleware,
);

adminRouter.get(
  "/config/addon-services",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getAddonServices),
  ResponseMiddleware,
);

adminRouter.post(
  "/config/addon-services",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.createAddonService),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/addon-services/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateAddonService),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/addon-services/:id/toggle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.toggleAddonService),
  ResponseMiddleware,
);

adminRouter.delete(
  "/config/addon-services/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.deleteAddonService),
  ResponseMiddleware,
);

// ============ GOODS TYPES / DELIVERY CATEGORIES ============

adminRouter.get(
  "/config/goods-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getGoodsTypes),
  ResponseMiddleware,
);

adminRouter.post(
  "/config/goods-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.createGoodsType),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/goods-types/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateGoodsType),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/goods-types/:id/toggle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.toggleGoodsType),
  ResponseMiddleware,
);

adminRouter.delete(
  "/config/goods-types/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.deleteGoodsType),
  ResponseMiddleware,
);

adminRouter.get(
  "/config/cancellation-reasons",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getCancellationReasons),
  ResponseMiddleware,
);

adminRouter.post(
  "/config/cancellation-reasons",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.createCancellationReason),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/cancellation-reasons/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateCancellationReason),
  ResponseMiddleware,
);

adminRouter.delete(
  "/config/cancellation-reasons/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.deleteCancellationReason),
  ResponseMiddleware,
);

// ============ PROHIBITED ITEMS ============
adminRouter.get(
  "/config/prohibited-items",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getProhibitedItems),
  ResponseMiddleware,
);

adminRouter.post(
  "/config/prohibited-items",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.createProhibitedItem),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/prohibited-items/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateProhibitedItem),
  ResponseMiddleware,
);

adminRouter.delete(
  "/config/prohibited-items/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.deleteProhibitedItem),
  ResponseMiddleware,
);

adminRouter.get(
  "/config/time-slots",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getTimeSlots),
  ResponseMiddleware,
);

adminRouter.get(
  "/config/app-settings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getAppSettings),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/app-settings/:key",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateAppSetting),
  ResponseMiddleware,
);

adminRouter.post(
  "/config/app-settings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.createAppSetting),
  ResponseMiddleware,
);

// ============ SUPPORT ============
adminRouter.get(
  "/support/tickets",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_VIEW),
  ErrorHandlerMiddleware(SupportController.getAllTickets),
  ResponseMiddleware,
);

adminRouter.get(
  "/support/tickets/:ticketId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_VIEW),
  ErrorHandlerMiddleware(SupportController.getTicket),
  ResponseMiddleware,
);

adminRouter.put(
  "/support/tickets/:ticketId/assign",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_ASSIGN),
  ErrorHandlerMiddleware(SupportController.assignTicket),
  ResponseMiddleware,
);

adminRouter.put(
  "/support/tickets/:ticketId/status",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_RESOLVE),
  ErrorHandlerMiddleware(SupportController.updateTicketStatus),
  ResponseMiddleware,
);

adminRouter.post(
  "/support/tickets/:ticketId/reply",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_RESPOND),
  ErrorHandlerMiddleware(SupportController.replyToTicket),
  ResponseMiddleware,
);

adminRouter.get(
  "/support/stats",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_VIEW),
  ErrorHandlerMiddleware(SupportController.getStats),
  ResponseMiddleware,
);

adminRouter.post(
  "/support/tickets/:ticketId/escalate",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_RESOLVE),
  ErrorHandlerMiddleware(SupportController.escalateTicket),
  ResponseMiddleware,
);

// Quick reply templates
adminRouter.get(
  "/support/quick-replies",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_VIEW),
  ErrorHandlerMiddleware(SupportController.listQuickReplies),
  ResponseMiddleware,
);

adminRouter.post(
  "/support/quick-replies",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_RESPOND),
  ErrorHandlerMiddleware(SupportController.createQuickReply),
  ResponseMiddleware,
);

adminRouter.put(
  "/support/quick-replies/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_RESPOND),
  ErrorHandlerMiddleware(SupportController.updateQuickReply),
  ResponseMiddleware,
);

adminRouter.delete(
  "/support/quick-replies/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_RESPOND),
  ErrorHandlerMiddleware(SupportController.deleteQuickReply),
  ResponseMiddleware,
);

adminRouter.post(
  "/support/quick-replies/:id/use",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SUPPORT_RESPOND),
  ErrorHandlerMiddleware(SupportController.useQuickReply),
  ResponseMiddleware,
);

// ============ REPORTS ============
adminRouter.get(
  "/reports/bookings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ReportsController.getBookingReports),
  ResponseMiddleware,
);

adminRouter.get(
  "/reports/revenue",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ReportsController.getRevenueReports),
  ResponseMiddleware,
);

adminRouter.get(
  "/reports/users",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ReportsController.getUserReports),
  ResponseMiddleware,
);

adminRouter.get(
  "/reports/drivers",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ReportsController.getDriverReports),
  ResponseMiddleware,
);

adminRouter.get(
  "/reports/cities",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ReportsController.getCitiesReport),
  ResponseMiddleware,
);

adminRouter.get(
  "/reports/categories",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ReportsController.getCategoriesReport),
  ResponseMiddleware,
);

adminRouter.get(
  "/reports/enterprises",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ReportsController.getEnterprisesReport),
  ResponseMiddleware,
);

adminRouter.get(
  "/reports/ops-metrics",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ReportsController.getOpsMetrics),
  ResponseMiddleware,
);

adminRouter.get(
  "/reports/snapshot",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ReportsController.getSnapshot),
  ResponseMiddleware,
);

// ── Scheduled reports (recurring generation + email) ──
adminRouter.get(
  "/reports/schedules",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ScheduledReportController.listSchedules),
  ResponseMiddleware,
);
adminRouter.post(
  "/reports/schedules",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ScheduledReportController.createSchedule),
  ResponseMiddleware,
);
adminRouter.put(
  "/reports/schedules/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ScheduledReportController.updateSchedule),
  ResponseMiddleware,
);
adminRouter.delete(
  "/reports/schedules/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ScheduledReportController.deleteSchedule),
  ResponseMiddleware,
);
adminRouter.post(
  "/reports/schedules/:id/run",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  ErrorHandlerMiddleware(ScheduledReportController.runScheduleNow),
  ResponseMiddleware,
);

// ============ ENTERPRISE ============
adminRouter.get(
  "/enterprises",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_VIEW),
  ErrorHandlerMiddleware(EnterpriseController.getAllEnterprises),
  ResponseMiddleware,
);

adminRouter.post(
  "/enterprises",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_UPDATE),
  ErrorHandlerMiddleware(EnterpriseController.createEnterprise),
  ResponseMiddleware,
);

// ── Enterprise Inquiries (static paths BEFORE :enterpriseId) ──
adminRouter.get(
  "/enterprises/inquiries",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_VIEW),
  ErrorHandlerMiddleware(EnterpriseController.getAllInquiries),
  ResponseMiddleware,
);

adminRouter.put(
  "/enterprises/inquiries/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_UPDATE),
  ErrorHandlerMiddleware(EnterpriseController.updateInquiryStatus),
  ResponseMiddleware,
);

adminRouter.delete(
  "/enterprises/inquiries/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_UPDATE),
  ErrorHandlerMiddleware(EnterpriseController.deleteInquiry),
  ResponseMiddleware,
);

// ── Enterprise Page Content (static paths BEFORE :enterpriseId) ──
adminRouter.get(
  "/enterprises/content",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_VIEW),
  ErrorHandlerMiddleware(EnterpriseController.getEnterprisePageContent),
  ResponseMiddleware,
);

adminRouter.put(
  "/enterprises/content",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_UPDATE),
  ErrorHandlerMiddleware(EnterpriseController.updateEnterprisePageContent),
  ResponseMiddleware,
);

// Credit summary (static path — MUST be before /enterprises/:enterpriseId,
// otherwise "credit-summary" is captured as an enterpriseId and cast to ObjectId → 500).
adminRouter.get(
  "/enterprises/credit-summary",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISE_CREDIT_VIEW),
  ErrorHandlerMiddleware(EnterpriseCreditController.getCreditSummary),
  ResponseMiddleware,
);

// Overdue enterprises (static path — same shadowing rule as credit-summary;
// was previously registered ~1000 lines below and unreachable).
adminRouter.get(
  "/enterprises/overdue",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISE_CREDIT_VIEW),
  ErrorHandlerMiddleware(EnterpriseCreditController.getOverdueEnterprises),
  ResponseMiddleware,
);

// ── Enterprise by ID (parameterized) ──
adminRouter.get(
  "/enterprises/:enterpriseId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_VIEW),
  ErrorHandlerMiddleware(EnterpriseController.getEnterpriseById),
  ResponseMiddleware,
);

adminRouter.put(
  "/enterprises/:enterpriseId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_UPDATE),
  ErrorHandlerMiddleware(EnterpriseController.updateEnterpriseAdmin),
  ResponseMiddleware,
);

adminRouter.delete(
  "/enterprises/:enterpriseId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_UPDATE),
  ErrorHandlerMiddleware(EnterpriseController.deleteEnterprise),
  ResponseMiddleware,
);

adminRouter.post(
  "/enterprises/:enterpriseId/approve",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_APPROVE),
  ErrorHandlerMiddleware(EnterpriseController.approveEnterprise),
  ResponseMiddleware,
);

adminRouter.post(
  "/enterprises/:enterpriseId/reject",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_APPROVE),
  ErrorHandlerMiddleware(EnterpriseController.rejectEnterprise),
  ResponseMiddleware,
);

adminRouter.post(
  "/enterprises/:enterpriseId/suspend",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_SUSPEND),
  ErrorHandlerMiddleware(EnterpriseController.suspendEnterprise),
  ResponseMiddleware,
);

adminRouter.put(
  "/enterprises/:enterpriseId/credit-limit",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_UPDATE),
  ErrorHandlerMiddleware(EnterpriseController.updateCreditLimit),
  ResponseMiddleware,
);

adminRouter.get(
  "/enterprises/:enterpriseId/users",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_VIEW),
  ErrorHandlerMiddleware(EnterpriseController.getEnterpriseUsers),
  ResponseMiddleware,
);

adminRouter.get(
  "/enterprises/:enterpriseId/bookings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISES_VIEW),
  ErrorHandlerMiddleware(EnterpriseController.getEnterpriseBookings),
  ResponseMiddleware,
);

// ============ SOS/EMERGENCY ============
adminRouter.get(
  "/sos",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SOS_VIEW),
  ErrorHandlerMiddleware(SOSController.getAllSOSAlerts),
  ResponseMiddleware,
);

adminRouter.get(
  "/sos/active",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SOS_VIEW),
  ErrorHandlerMiddleware(SOSController.getActiveSOSAlerts),
  ResponseMiddleware,
);

adminRouter.get(
  "/sos/stats",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SOS_VIEW),
  ErrorHandlerMiddleware(SOSController.getSOSStats),
  ResponseMiddleware,
);

adminRouter.get(
  "/sos/:sosId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SOS_VIEW),
  ErrorHandlerMiddleware(SOSController.getSOSDetails),
  ResponseMiddleware,
);

adminRouter.post(
  "/sos/:sosId/respond",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SOS_RESPOND),
  ErrorHandlerMiddleware(SOSController.respondToSOS),
  ResponseMiddleware,
);

adminRouter.post(
  "/sos/:sosId/resolve",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SOS_RESOLVE),
  ErrorHandlerMiddleware(SOSController.resolveSOS),
  ResponseMiddleware,
);

adminRouter.post(
  "/sos/:sosId/notify-police",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SOS_RESPOND),
  ErrorHandlerMiddleware(SOSController.notifyPolice),
  ResponseMiddleware,
);

// ============ TRACKING ============
adminRouter.get(
  "/tracking/drivers",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRACKING_VIEW),
  ErrorHandlerMiddleware(TrackingController.getDriversOnMap),
  ResponseMiddleware,
);

adminRouter.get(
  "/tracking/drivers/:driverId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRACKING_VIEW),
  ErrorHandlerMiddleware(TrackingController.getDriverLocation),
  ResponseMiddleware,
);

adminRouter.get(
  "/tracking/drivers/:driverId/history",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRACKING_VIEW),
  ErrorHandlerMiddleware(TrackingController.getDriverLocationHistory),
  ResponseMiddleware,
);

adminRouter.get(
  "/tracking/nearby",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRACKING_VIEW),
  ErrorHandlerMiddleware(TrackingController.findNearbyDrivers),
  ResponseMiddleware,
);

// ============ NOTIFICATIONS ============
adminRouter.post(
  "/notifications/send",
  verifyAdminToken,
  requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
  ErrorHandlerMiddleware(NotificationController.sendPromoNotification),
);

adminRouter.post(
  "/notifications/broadcast",
  verifyAdminToken,
  requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
  ErrorHandlerMiddleware(NotificationController.sendBroadcast),
);

adminRouter.post(
  "/notifications/cleanup",
  verifyAdminToken,
  requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
  ErrorHandlerMiddleware(NotificationController.cleanupNotifications),
);

adminRouter.get(
  "/notifications/history",
  verifyAdminToken,
  requirePermission(PERMISSIONS.NOTIFICATIONS_VIEW),
  ErrorHandlerMiddleware(NotificationController.listHistory),
);

adminRouter.get(
  "/notifications/analytics",
  verifyAdminToken,
  requirePermission(PERMISSIONS.NOTIFICATIONS_VIEW),
  ErrorHandlerMiddleware(NotificationController.getAnalytics),
);

// Templates
adminRouter.get(
  "/notifications/templates",
  verifyAdminToken,
  requirePermission(PERMISSIONS.NOTIFICATIONS_VIEW),
  ErrorHandlerMiddleware(NotificationController.listTemplates),
);

adminRouter.post(
  "/notifications/templates",
  verifyAdminToken,
  requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
  ErrorHandlerMiddleware(NotificationController.createTemplate),
);

adminRouter.put(
  "/notifications/templates/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
  ErrorHandlerMiddleware(NotificationController.updateTemplate),
);

adminRouter.delete(
  "/notifications/templates/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
  ErrorHandlerMiddleware(NotificationController.deleteTemplate),
);

// ============ STAFF MANAGEMENT ============
adminRouter.get(
  "/staff",
  verifyAdminToken,
  requirePermission(PERMISSIONS.STAFF_VIEW),
  ErrorHandlerMiddleware(StaffController.getAllStaff),
  ResponseMiddleware,
);

adminRouter.get(
  "/staff/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.STAFF_VIEW),
  ErrorHandlerMiddleware(StaffController.getStaffById),
  ResponseMiddleware,
);

adminRouter.post(
  "/staff",
  verifyAdminToken,
  requirePermission(PERMISSIONS.STAFF_CREATE),
  ErrorHandlerMiddleware(StaffController.createStaff),
  ResponseMiddleware,
);

adminRouter.put(
  "/staff/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.STAFF_UPDATE),
  ErrorHandlerMiddleware(StaffController.updateStaff),
  ResponseMiddleware,
);

adminRouter.delete(
  "/staff/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.STAFF_DELETE),
  ErrorHandlerMiddleware(StaffController.deleteStaff),
  ResponseMiddleware,
);

adminRouter.put(
  "/staff/:id/toggle-status",
  verifyAdminToken,
  requirePermission(PERMISSIONS.STAFF_UPDATE),
  ErrorHandlerMiddleware(StaffController.toggleStaffStatus),
  ResponseMiddleware,
);

adminRouter.put(
  "/staff/:id/reset-password",
  verifyAdminToken,
  requirePermission(PERMISSIONS.STAFF_UPDATE),
  ErrorHandlerMiddleware(StaffController.resetStaffPassword),
  ResponseMiddleware,
);

// ============ ROLE MANAGEMENT ============
adminRouter.get(
  "/roles",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ROLES_VIEW),
  ErrorHandlerMiddleware(StaffController.getAllRoles),
  ResponseMiddleware,
);

adminRouter.get(
  "/roles/permissions",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ROLES_VIEW),
  ErrorHandlerMiddleware(StaffController.getAllPermissions),
  ResponseMiddleware,
);

adminRouter.get(
  "/roles/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ROLES_VIEW),
  ErrorHandlerMiddleware(StaffController.getRoleById),
  ResponseMiddleware,
);

adminRouter.post(
  "/roles",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ROLES_CREATE),
  ErrorHandlerMiddleware(StaffController.createRole),
  ResponseMiddleware,
);

adminRouter.put(
  "/roles/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ROLES_UPDATE),
  ErrorHandlerMiddleware(StaffController.updateRole),
  ResponseMiddleware,
);

adminRouter.delete(
  "/roles/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ROLES_DELETE),
  ErrorHandlerMiddleware(StaffController.deleteRole),
  ResponseMiddleware,
);

adminRouter.post(
  "/roles/initialize",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ROLES_CREATE),
  ErrorHandlerMiddleware(StaffController.initializeDefaultRoles),
  ResponseMiddleware,
);

// ============ SIDEBAR MODULES ============
adminRouter.get(
  "/sidebar-modules",
  verifyAdminToken,
  ErrorHandlerMiddleware(StaffController.getSidebarModules),
  ResponseMiddleware,
);

// ============ AUDIT LOGS ============
adminRouter.get(
  "/audit-logs",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUDIT_VIEW),
  ErrorHandlerMiddleware(AuditLogController.getAuditLogs),
  ResponseMiddleware,
);

adminRouter.get(
  "/audit-logs/stats",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUDIT_VIEW),
  ErrorHandlerMiddleware(AuditLogController.getAuditStats),
  ResponseMiddleware,
);

adminRouter.post(
  "/audit-logs/:id/revert",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUDIT_VIEW),
  ErrorHandlerMiddleware(AuditLogController.revertAuditLog),
  ResponseMiddleware,
);

// ============ AUTOMATION RULES ============
adminRouter.get(
  "/automation/rules",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUTOMATION_VIEW),
  ErrorHandlerMiddleware(AutomationController.getAllRules),
  ResponseMiddleware,
);

// Manually evaluate all active rules now
adminRouter.post(
  "/automation/run",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUTOMATION_MANAGE),
  ErrorHandlerMiddleware(AutomationController.runRulesNow),
  ResponseMiddleware,
);

adminRouter.get(
  "/automation/trigger-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUTOMATION_VIEW),
  ErrorHandlerMiddleware(AutomationController.getTriggerTypes),
  ResponseMiddleware,
);

adminRouter.get(
  "/automation/action-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUTOMATION_VIEW),
  ErrorHandlerMiddleware(AutomationController.getActionTypes),
  ResponseMiddleware,
);

adminRouter.get(
  "/automation/rules/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUTOMATION_VIEW),
  ErrorHandlerMiddleware(AutomationController.getRuleById),
  ResponseMiddleware,
);

adminRouter.post(
  "/automation/rules",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUTOMATION_MANAGE),
  ErrorHandlerMiddleware(AutomationController.createRule),
  ResponseMiddleware,
);

adminRouter.put(
  "/automation/rules/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUTOMATION_MANAGE),
  ErrorHandlerMiddleware(AutomationController.updateRule),
  ResponseMiddleware,
);

adminRouter.put(
  "/automation/rules/:id/toggle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUTOMATION_MANAGE),
  ErrorHandlerMiddleware(AutomationController.toggleRule),
  ResponseMiddleware,
);

adminRouter.delete(
  "/automation/rules/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUTOMATION_MANAGE),
  ErrorHandlerMiddleware(AutomationController.deleteRule),
  ResponseMiddleware,
);

// ============ FINANCE MODULE ============
adminRouter.get(
  "/finance/overview",
  verifyAdminToken,
  requirePermission(PERMISSIONS.FINANCE_VIEW),
  ErrorHandlerMiddleware(FinanceController.getFinanceOverview),
  ResponseMiddleware,
);

// Manual driver payouts — list + full approval lifecycle (create → approve → pay / reject).
adminRouter.get(
  "/finance/payouts",
  verifyAdminToken,
  requirePermission(PERMISSIONS.FINANCE_VIEW),
  ErrorHandlerMiddleware(PayoutController.listPayouts),
  ResponseMiddleware,
);
adminRouter.post(
  "/finance/payouts",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYOUTS_CREATE),
  ErrorHandlerMiddleware(PayoutController.createPayout),
  ResponseMiddleware,
);
adminRouter.put(
  "/finance/payouts/:id/approve",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYOUTS_APPROVE),
  ErrorHandlerMiddleware(PayoutController.approvePayout),
  ResponseMiddleware,
);
adminRouter.put(
  "/finance/payouts/:id/pay",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYOUTS_PAY),
  ErrorHandlerMiddleware(PayoutController.markPayoutPaid),
  ResponseMiddleware,
);
adminRouter.put(
  "/finance/payouts/:id/reject",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYOUTS_APPROVE),
  // "payout:reject" is already listed in MANDATORY_COMMENT_ACTIONS but the route
  // never enforced it, so every rejection fell back to "Rejected by admin" and
  // the driver was told nothing. Comment only — rejectPayout writes its own
  // audit row, so auditAction here would duplicate it.
  requireComment({ action: "payout:reject" }),
  ErrorHandlerMiddleware(PayoutController.rejectPayout),
  ResponseMiddleware,
);

// Customer coin→bank payouts — same manual lifecycle as driver payouts
// (approve → pay with UTR / reject with a coin refund). Requests are created by
// customers from the app, so there is no admin "create" here.
adminRouter.get(
  "/finance/coin-payouts",
  verifyAdminToken,
  requirePermission(PERMISSIONS.FINANCE_VIEW),
  ErrorHandlerMiddleware(CoinPayoutController.listCoinPayouts),
  ResponseMiddleware,
);
adminRouter.put(
  "/finance/coin-payouts/:id/approve",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYOUTS_APPROVE),
  ErrorHandlerMiddleware(CoinPayoutController.approveCoinPayout),
  ResponseMiddleware,
);
adminRouter.put(
  "/finance/coin-payouts/:id/pay",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYOUTS_PAY),
  ErrorHandlerMiddleware(CoinPayoutController.markCoinPayoutPaid),
  ResponseMiddleware,
);
adminRouter.put(
  "/finance/coin-payouts/:id/reject",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYOUTS_APPROVE),
  // Rejecting refunds the customer's coins — same mandatory comment + audit row
  // as a driver payout rejection.
  ...requireCommentAndAudit("payout:reject", "CoinPayout"),
  ErrorHandlerMiddleware(CoinPayoutController.rejectCoinPayout),
  ResponseMiddleware,
);

adminRouter.get(
  "/finance/driver-earnings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.FINANCE_VIEW),
  ErrorHandlerMiddleware(FinanceController.getDriverEarnings),
  ResponseMiddleware,
);

adminRouter.get(
  "/finance/cod-summary",
  verifyAdminToken,
  requirePermission(PERMISSIONS.FINANCE_VIEW),
  ErrorHandlerMiddleware(FinanceController.getCODSummary),
  ResponseMiddleware,
);

adminRouter.get(
  "/finance/export",
  verifyAdminToken,
  requirePermission(PERMISSIONS.FINANCE_EXPORT),
  ErrorHandlerMiddleware(FinanceController.exportFinanceData),
  ResponseMiddleware,
);

// ============ DASHBOARD LIVE ============
adminRouter.get(
  "/dashboard/alerts",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  ErrorHandlerMiddleware(FinanceController.getDashboardAlerts),
  ResponseMiddleware,
);

adminRouter.get(
  "/dashboard/live-stats",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  ErrorHandlerMiddleware(FinanceController.getLiveStats),
  ResponseMiddleware,
);

adminRouter.get(
  "/dashboard/event-timeline",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  ErrorHandlerMiddleware(FinanceController.getEventTimeline),
  ResponseMiddleware,
);

adminRouter.get(
  "/dashboard/action-center",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  ErrorHandlerMiddleware(BookingController.getActionCenter),
  ResponseMiddleware,
);

// ============ MASTER DATA – CITIES ============
adminRouter.get(
  "/config/cities",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getCities),
  ResponseMiddleware,
);
adminRouter.post(
  "/config/cities",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.createCity),
  ResponseMiddleware,
);
adminRouter.put(
  "/config/cities/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateCity),
  ResponseMiddleware,
);
adminRouter.delete(
  "/config/cities/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.deleteCity),
  ResponseMiddleware,
);

// ============ MASTER DATA – BODY TYPES ============
adminRouter.get(
  "/config/body-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getBodyTypes),
  ResponseMiddleware,
);
adminRouter.post(
  "/config/body-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.createBodyType),
  ResponseMiddleware,
);
adminRouter.put(
  "/config/body-types/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateBodyType),
  ResponseMiddleware,
);
adminRouter.delete(
  "/config/body-types/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.deleteBodyType),
  ResponseMiddleware,
);

// ============ MASTER DATA – FUEL TYPES ============
adminRouter.get(
  "/config/fuel-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_VIEW),
  ErrorHandlerMiddleware(ConfigController.getFuelTypes),
  ResponseMiddleware,
);
adminRouter.post(
  "/config/fuel-types",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.createFuelType),
  ResponseMiddleware,
);
adminRouter.put(
  "/config/fuel-types/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.updateFuelType),
  ResponseMiddleware,
);
adminRouter.delete(
  "/config/fuel-types/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(ConfigController.deleteFuelType),
  ResponseMiddleware,
);

// ============ DRIVER INSTRUCTIONS ============
adminRouter.get(
  "/driver-instructions",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVER_INSTRUCTIONS_VIEW),
  ErrorHandlerMiddleware(DriverInstructionController.getDriverInstructions),
  ResponseMiddleware,
);
adminRouter.post(
  "/driver-instructions",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVER_INSTRUCTIONS_CREATE),
  ErrorHandlerMiddleware(DriverInstructionController.createDriverInstruction),
  ResponseMiddleware,
);
adminRouter.put(
  "/driver-instructions/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVER_INSTRUCTIONS_UPDATE),
  ErrorHandlerMiddleware(DriverInstructionController.updateDriverInstruction),
  ResponseMiddleware,
);
adminRouter.put(
  "/driver-instructions/:id/toggle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVER_INSTRUCTIONS_UPDATE),
  ErrorHandlerMiddleware(DriverInstructionController.toggleDriverInstruction),
  ResponseMiddleware,
);
adminRouter.delete(
  "/driver-instructions/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVER_INSTRUCTIONS_DELETE),
  ErrorHandlerMiddleware(DriverInstructionController.deleteDriverInstruction),
  ResponseMiddleware,
);

// ============ BADGES ============
adminRouter.get(
  "/badges",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BADGES_VIEW),
  ErrorHandlerMiddleware(BadgeController.getBadges),
  ResponseMiddleware,
);
adminRouter.post(
  "/badges",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BADGES_CREATE),
  ErrorHandlerMiddleware(BadgeController.createBadge),
  ResponseMiddleware,
);
adminRouter.put(
  "/badges/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BADGES_UPDATE),
  ErrorHandlerMiddleware(BadgeController.updateBadge),
  ResponseMiddleware,
);
adminRouter.put(
  "/badges/:id/toggle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BADGES_UPDATE),
  ErrorHandlerMiddleware(BadgeController.toggleBadge),
  ResponseMiddleware,
);
adminRouter.delete(
  "/badges/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.BADGES_DELETE),
  ErrorHandlerMiddleware(BadgeController.deleteBadge),
  ResponseMiddleware,
);

// ============ TRAINING MATERIALS ============
adminRouter.get(
  "/training",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_VIEW),
  ErrorHandlerMiddleware(TrainingController.getTrainingMaterials),
  ResponseMiddleware,
);

// ── Training PROGRAMS (static paths MUST precede /training/:id) ──
adminRouter.get(
  "/training/programs",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_VIEW),
  ErrorHandlerMiddleware(TrainingProgramController.listPrograms),
  ResponseMiddleware,
);
adminRouter.post(
  "/training/programs",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_CREATE),
  ErrorHandlerMiddleware(TrainingProgramController.createProgram),
  ResponseMiddleware,
);
adminRouter.put(
  "/training/programs/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_UPDATE),
  ErrorHandlerMiddleware(TrainingProgramController.updateProgram),
  ResponseMiddleware,
);
adminRouter.put(
  "/training/programs/:id/toggle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_UPDATE),
  ErrorHandlerMiddleware(TrainingProgramController.toggleProgram),
  ResponseMiddleware,
);
adminRouter.delete(
  "/training/programs/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_DELETE),
  ErrorHandlerMiddleware(TrainingProgramController.deleteProgram),
  ResponseMiddleware,
);
adminRouter.get(
  "/training/programs/:id/enrollments",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_VIEW),
  ErrorHandlerMiddleware(TrainingProgramController.getProgramEnrollments),
  ResponseMiddleware,
);

adminRouter.post(
  "/training",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_CREATE),
  upload.single("file"),
  ErrorHandlerMiddleware(TrainingController.createTrainingMaterial),
  ResponseMiddleware,
);
adminRouter.put(
  "/training/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_UPDATE),
  upload.single("file"),
  ErrorHandlerMiddleware(TrainingController.updateTrainingMaterial),
  ResponseMiddleware,
);
adminRouter.put(
  "/training/:id/toggle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_UPDATE),
  ErrorHandlerMiddleware(TrainingController.toggleTrainingMaterial),
  ResponseMiddleware,
);
adminRouter.delete(
  "/training/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRAINING_DELETE),
  ErrorHandlerMiddleware(TrainingController.deleteTrainingMaterial),
  ResponseMiddleware,
);

// ============ REFUND (DUAL APPROVAL) ============
adminRouter.get(
  "/refunds/config",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REFUNDS_VIEW),
  ErrorHandlerMiddleware(RefundController.getRefundConfig),
  ResponseMiddleware,
);

adminRouter.put(
  "/refunds/config",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  ErrorHandlerMiddleware(RefundController.updateRefundConfig),
  ResponseMiddleware,
);

adminRouter.get(
  "/refunds",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REFUNDS_VIEW),
  ErrorHandlerMiddleware(RefundController.getAllRefundRequests),
  ResponseMiddleware,
);

adminRouter.get(
  "/refunds/stats",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REFUNDS_VIEW),
  ErrorHandlerMiddleware(RefundController.getRefundStats),
  ResponseMiddleware,
);

adminRouter.get(
  "/refunds/:id",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REFUNDS_VIEW),
  ErrorHandlerMiddleware(RefundController.getRefundRequestById),
  ResponseMiddleware,
);

adminRouter.post(
  "/refunds/request",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REFUNDS_REQUEST),
  ...requireCommentAndAudit("refund:request", "RefundRequest", { minLength: 15 }),
  ErrorHandlerMiddleware(RefundController.requestRefund),
  ResponseMiddleware,
);

adminRouter.put(
  "/refunds/:id/approve-l1",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REFUNDS_APPROVE_L1),
  ...requireCommentAndAudit("refund:approve_l1", "RefundRequest"),
  ErrorHandlerMiddleware(RefundController.approveRefundL1),
  ResponseMiddleware,
);

adminRouter.put(
  "/refunds/:id/approve-l2",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REFUNDS_APPROVE_L2),
  ...requireCommentAndAudit("refund:approve_l2", "RefundRequest"),
  ErrorHandlerMiddleware(RefundController.approveRefundL2),
  ResponseMiddleware,
);

adminRouter.put(
  "/refunds/:id/reject",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REFUNDS_REJECT),
  ...requireCommentAndAudit("refund:reject", "RefundRequest", { minLength: 15 }),
  ErrorHandlerMiddleware(RefundController.rejectRefund),
  ResponseMiddleware,
);

adminRouter.put(
  "/refunds/:id/process",
  verifyAdminToken,
  requirePermission(PERMISSIONS.REFUNDS_PROCESS),
  ErrorHandlerMiddleware(RefundController.processRefund),
  ResponseMiddleware,
);

// ============ ENHANCED FINANCE ============
adminRouter.get(
  "/finance/enhanced-overview",
  verifyAdminToken,
  requirePermission(PERMISSIONS.FINANCE_VIEW),
  ErrorHandlerMiddleware(EnhancedFinanceController.getEnhancedOverview),
  ResponseMiddleware,
);

adminRouter.get(
  "/finance/expenses",
  verifyAdminToken,
  requirePermission(PERMISSIONS.EXPENSES_VIEW),
  ErrorHandlerMiddleware(EnhancedFinanceController.getExpenses),
  ResponseMiddleware,
);

adminRouter.post(
  "/finance/expenses",
  verifyAdminToken,
  requirePermission(PERMISSIONS.EXPENSES_CREATE),
  ErrorHandlerMiddleware(EnhancedFinanceController.createExpense),
  ResponseMiddleware,
);

adminRouter.put(
  "/finance/expenses/:id/approve",
  verifyAdminToken,
  requirePermission(PERMISSIONS.EXPENSES_APPROVE),
  ErrorHandlerMiddleware(EnhancedFinanceController.approveExpense),
  ResponseMiddleware,
);

adminRouter.put(
  "/finance/expenses/:id/pay",
  verifyAdminToken,
  requirePermission(PERMISSIONS.EXPENSES_APPROVE),
  ErrorHandlerMiddleware(EnhancedFinanceController.markExpensePaid),
  ResponseMiddleware,
);

adminRouter.get(
  "/finance/dso",
  verifyAdminToken,
  requirePermission(PERMISSIONS.FINANCE_VIEW),
  ErrorHandlerMiddleware(EnhancedFinanceController.getDSOMetrics),
  ResponseMiddleware,
);

adminRouter.get(
  "/finance/export-enhanced",
  verifyAdminToken,
  requirePermission(PERMISSIONS.FINANCE_EXPORT),
  ErrorHandlerMiddleware(EnhancedFinanceController.exportFinanceData),
  ResponseMiddleware,
);

// ============ ENHANCED DRIVER ============
adminRouter.get(
  "/drivers/:id/enhanced",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getEnhancedDriverDetails),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/:id/cod-balance",
  verifyAdminToken,
  requirePermission(PERMISSIONS.COD_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getDriverCODBalance),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/:id/weekly-earnings",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getDriverWeeklyEarnings),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/:id/documents/status",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getDriverDocumentStatus),
  ResponseMiddleware,
);

adminRouter.get(
  "/drivers/:id/reassignments",
  verifyAdminToken,
  requirePermission(PERMISSIONS.DRIVERS_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getDriverReassignments),
  ResponseMiddleware,
);

// (GET /drivers/cod-summary, /drivers/expiring-documents,
// /drivers/late-delivery-metrics, /drivers/device-info moved up near the other
// /drivers routes — they must precede GET /drivers/:id or they get shadowed.)

adminRouter.put(
  "/drivers/:id/cod/settle",
  verifyAdminToken,
  requirePermission(PERMISSIONS.COD_SETTLE),
  ...requireCommentAndAudit("cod:settle", "Driver"),
  ErrorHandlerMiddleware(EnhancedDriverController.settleCOD),
  ResponseMiddleware,
);

adminRouter.get(
  "/tracking/demand-zones",
  verifyAdminToken,
  requirePermission(PERMISSIONS.TRACKING_VIEW),
  ErrorHandlerMiddleware(EnhancedDriverController.getDemandZones),
  ResponseMiddleware,
);

// ============ ENTERPRISE CREDIT ============
adminRouter.get(
  "/enterprises/:id/credit-history",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISE_CREDIT_VIEW),
  ErrorHandlerMiddleware(EnterpriseCreditController.getCreditHistory),
  ResponseMiddleware,
);

adminRouter.post(
  "/enterprises/:id/credit/adjust",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISE_CREDIT_ADJUST),
  ...requireCommentAndAudit("credit:adjust", "Enterprise", { minLength: 15 }),
  ErrorHandlerMiddleware(EnterpriseCreditController.adjustCredit),
  ResponseMiddleware,
);

adminRouter.put(
  "/enterprises/:id/credit-limit-enhanced",
  verifyAdminToken,
  requirePermission(PERMISSIONS.ENTERPRISE_CREDIT_LIMIT),
  ...requireCommentAndAudit("credit:update_limit", "Enterprise"),
  ErrorHandlerMiddleware(EnterpriseCreditController.updateCreditLimit),
  ResponseMiddleware,
);

// (GET /enterprises/overdue moved up before GET /enterprises/:enterpriseId —
// static paths must precede the param route or Express treats "overdue" as an
// enterprise id and the endpoint 404s.)

// ============ SESSION MANAGEMENT ============
adminRouter.get(
  "/config/session",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SESSIONS_CONFIG),
  ErrorHandlerMiddleware(SessionController.getSessionConfig),
  ResponseMiddleware,
);

adminRouter.put(
  "/config/session",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SESSIONS_CONFIG),
  ErrorHandlerMiddleware(SessionController.updateSessionConfig),
  ResponseMiddleware,
);

adminRouter.get(
  "/sessions/active",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SESSIONS_VIEW),
  ErrorHandlerMiddleware(SessionController.getActiveSessions),
  ResponseMiddleware,
);

adminRouter.delete(
  "/sessions/:sessionId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SESSIONS_TERMINATE),
  ErrorHandlerMiddleware(SessionController.terminateSession),
  ResponseMiddleware,
);

adminRouter.delete(
  "/sessions/admin/:adminId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.SESSIONS_TERMINATE),
  ErrorHandlerMiddleware(SessionController.terminateAllAdminSessions),
  ResponseMiddleware,
);

adminRouter.put(
  "/staff/:id/session-restrictions",
  verifyAdminToken,
  requirePermission(PERMISSIONS.STAFF_UPDATE),
  ErrorHandlerMiddleware(SessionController.updateSessionRestrictions),
  ResponseMiddleware,
);

adminRouter.get(
  "/security/login-attempts",
  verifyAdminToken,
  requirePermission(PERMISSIONS.AUDIT_VIEW),
  ErrorHandlerMiddleware(SessionController.getLoginAttempts),
  ResponseMiddleware,
);

export default adminRouter;
