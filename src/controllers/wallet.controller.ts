import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import * as WalletService from "../services/wallet.service";
import { createAuditEntry } from "./admin/audit-log.controller";

// Pull the acting admin's identity off the request (set by admin-auth middleware).
const actingAdmin = (req: Request) => {
  const a = (req as any).admin || {};
  return {
    adminId: (req as any).adminId || String(a._id || ""),
    adminName: a.name || a.fullName || "Admin",
    adminEmail: a.email || "",
    adminRole: a.roleName || a.role,
  };
};

/**
 * ADD MONEY TO WALLET
 */
export const addToWallet = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const userId = (req as any).userId;
  const { amount, referenceId } = req.body;

  if (!amount || amount <= 0) {
    req.rCode = 0;
    req.msg = "invalid_amount";
    return next();
  }

  const wallet = await WalletService.addToWallet(userId, amount, referenceId);

  req.rData = {
    balance: wallet.balance,
  };
  req.msg = "success";
  next();
};

/**
 * GET WALLET
 */
export const getWallet = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const userId = (req as any).userId;

  const wallet = await WalletService.getWallet(userId);

  req.rData = wallet;
  req.msg = "success";
  next();
};

/**
 * GET TRANSACTION HISTORY
 */
export const getTransactions = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const userId = (req as any).userId;
  const { page = 1, limit = 20 } = req.query;

  const result = await WalletService.getTransactions(
    userId,
    Number(page),
    Number(limit)
  );

  req.rData = result;
  req.msg = "success";
  next();
};

// ─── ADMIN ENDPOINTS ───

/**
 * GET ALL WALLETS (admin)
 */
export const adminGetAllWallets = async (
  req: Request,
  res: Response,
) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const result = await WalletService.getAllWallets(
      Number(page),
      Number(limit),
      search as string | undefined
    );
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET USER WALLET DETAIL (admin)
 */
export const adminGetUserWallet = async (
  req: Request,
  res: Response,
) => {
  try {
    const { userId } = req.params;
    const result = await WalletService.getUserWalletAdmin(
      new Types.ObjectId(userId)
    );
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * CREDIT USER WALLET (admin)
 */
export const adminCreditWallet = async (
  req: Request,
  res: Response,
) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;
    const adminId = (req as any).adminId || "admin";

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const wallet = await WalletService.adminCreditWallet(
      new Types.ObjectId(userId),
      amount,
      description,
      adminId
    );
    res.json({ success: true, data: { balance: wallet.balance } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DEBIT USER WALLET (admin)
 */
export const adminDebitWallet = async (
  req: Request,
  res: Response,
) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;
    const adminId = (req as any).adminId || "admin";

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const wallet = await WalletService.adminDebitWallet(
      new Types.ObjectId(userId),
      amount,
      description,
      adminId
    );

    // Record the admin debit in the audit log (was untracked).
    await createAuditEntry({
      ...actingAdmin(req),
      action: "UPDATE",
      module: "users",
      targetId: userId,
      targetType: "User",
      description: `Debited ₹${amount} from wallet${description ? ` — ${description}` : ""}`,
      changes: [
        {
          field: "balance",
          oldValue: wallet.balance + amount,
          newValue: wallet.balance,
        },
      ],
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.json({ success: true, data: { balance: wallet.balance } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * GET ALL TRANSACTIONS (admin)
 */
export const adminGetAllTransactions = async (
  req: Request,
  res: Response,
) => {
  try {
    const { page = 1, limit = 20, type, status } = req.query;
    const result = await WalletService.getAllTransactions(
      Number(page),
      Number(limit),
      type as string | undefined,
      status as string | undefined
    );
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
