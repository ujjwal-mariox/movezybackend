import { Router } from "express";
import AuthMiddleware from "../middlewares/auth.middleware";
import AdminAuthMiddleware from "../middlewares/admin-auth.middleware";
import ErrorHandlerMiddleware from "../middlewares/error-handler.middleware";
import ResponseMiddleware from "../middlewares/response.middleware";
import * as WalletController from "../controllers/wallet.controller";
import { PERMISSIONS } from "../models/role.model";

const router = Router();
const { verifyAdminToken, requirePermission } = AdminAuthMiddleware();

// ─── USER ROUTES ───

router.post(
  "/add",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(WalletController.addToWallet),
  ResponseMiddleware
);

router.get(
  "/",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(WalletController.getWallet),
  ResponseMiddleware
);

router.get(
  "/transactions",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(WalletController.getTransactions),
  ResponseMiddleware
);

// ─── ADMIN ROUTES ───

router.get(
  "/admin/all",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYMENTS_VIEW),
  WalletController.adminGetAllWallets
);

router.get(
  "/admin/user/:userId",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYMENTS_VIEW),
  WalletController.adminGetUserWallet
);

router.post(
  "/admin/user/:userId/credit",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYMENTS_PROCESS),
  WalletController.adminCreditWallet
);

router.post(
  "/admin/user/:userId/debit",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYMENTS_PROCESS),
  WalletController.adminDebitWallet
);

router.get(
  "/admin/transactions",
  verifyAdminToken,
  requirePermission(PERMISSIONS.PAYMENTS_VIEW),
  WalletController.adminGetAllTransactions
);

export default router;
