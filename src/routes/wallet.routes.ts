import { Router } from "express";
import AuthMiddleware from "../middlewares/auth.middleware";
import AdminAuthMiddleware from "../middlewares/admin-auth.middleware";
import ErrorHandlerMiddleware from "../middlewares/error-handler.middleware";
import ResponseMiddleware from "../middlewares/response.middleware";
import * as WalletController from "../controllers/wallet.controller";

const router = Router();
const { verifyAdminToken } = AdminAuthMiddleware();

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
  WalletController.adminGetAllWallets
);

router.get(
  "/admin/user/:userId",
  verifyAdminToken,
  WalletController.adminGetUserWallet
);

router.post(
  "/admin/user/:userId/credit",
  verifyAdminToken,
  WalletController.adminCreditWallet
);

router.post(
  "/admin/user/:userId/debit",
  verifyAdminToken,
  WalletController.adminDebitWallet
);

router.get(
  "/admin/transactions",
  verifyAdminToken,
  WalletController.adminGetAllTransactions
);

export default router;
