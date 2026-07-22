import { Request, Response } from "express";
import * as CoinService from "../services/coin.service";
import { CoinTransaction } from "../models/coin.model";
import config from "../config";

/**
 * "Insufficient coin balance" is the customer being short, not the server
 * failing — the atomic debit throws it, and a blanket 500 catch reported it as
 * a server error. Anything else is still a genuine 500.
 */
const coinErrorStatus = (error: any) =>
  /insufficient coin balance/i.test(error?.message || "") ? 400 : 500;

/**
 * Get coin wallet balance
 */
export const getCoinBalance = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    const wallet = await CoinService.getCoinWallet(userId);

    res.json({
      success: true,
      data: {
        balance: wallet?.balance || 0,
        totalEarned: wallet?.totalEarned || 0,
        totalRedeemed: wallet?.totalRedeemed || 0,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch coin balance",
    });
  }
};

/**
 * Get coin transaction history
 */
export const getCoinTransactions = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { type, page = 1, limit = 20 } = req.query;

    const query: any = { userId };
    if (type) {
      query.type = type;
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [transactions, total] = await Promise.all([
      CoinTransaction.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("bookingId", "bookingNumber"),
      CoinTransaction.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch transactions",
    });
  }
};

/**
 * Transfer coins to wallet
 */
export const transferToWallet = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { coins } = req.body;

    const minCoins = config.coins.minTransferToWallet;
    if (!coins || coins < minCoins) {
      return res.status(400).json({
        success: false,
        message: `Minimum ${minCoins} coins required for transfer`,
      });
    }

    const wallet = await CoinService.getCoinWallet(userId);
    if (!wallet || wallet.balance < coins) {
      return res.status(400).json({
        success: false,
        message: "Insufficient coin balance",
      });
    }

    const result = await CoinService.transferCoinsToWallet(userId, coins);

    res.json({
      success: true,
      message: "Coins transferred to wallet successfully",
      data: {
        coinsTransferred: result.coins,
        amountCredited: result.rupeeValue,
      },
    });
  } catch (error: any) {
    res.status(coinErrorStatus(error)).json({
      success: false,
      message: error.message || "Failed to transfer coins",
    });
  }
};

/**
 * Coin economics for the "How to earn coins" sheet — earn rate, conversion
 * rates, expiry and minimums, all from live config so the copy can't drift
 * from what the ledger actually does.
 */
export const getCoinConfig = async (req: Request, res: Response) => {
  try {
    const data = await CoinService.getCoinConfig();
    res.json({ success: true, message: "Coin config fetched", data });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch coin config",
    });
  }
};

/**
 * Request bank transfer
 */
export const requestBankTransfer = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { coins, bankDetails } = req.body;

    const minCoins = config.coins.minBankTransfer;
    if (!coins || coins < minCoins) {
      return res.status(400).json({
        success: false,
        message: `Minimum ${minCoins} coins required for bank transfer`,
      });
    }

    // The app sends `ifsc`; `ifscCode` is accepted too because this endpoint
    // demanded that name while every caller sent the other — so bank transfer
    // 400'd for every customer who ever tried it.
    const ifsc = bankDetails?.ifsc || bankDetails?.ifscCode;
    if (
      !bankDetails ||
      !bankDetails.accountNumber ||
      !ifsc ||
      !bankDetails.accountName
    ) {
      return res.status(400).json({
        success: false,
        message: "Account name, account number and IFSC are required",
      });
    }

    // No balance pre-check here: requestBankTransfer debits atomically and
    // throws "Insufficient coin balance" if short. Checking first would just be
    // a racy duplicate of the guard that actually enforces it.
    const result = await CoinService.requestBankTransfer(userId, coins, {
      accountName: String(bankDetails.accountName).trim(),
      accountNumber: String(bankDetails.accountNumber).trim(),
      ifsc: String(ifsc).trim().toUpperCase(),
    });

    res.json({
      success: true,
      message: "Bank transfer request submitted successfully",
      data: {
        requestId: result.transactionId,
        coinsRequested: result.coins,
        estimatedAmount: result.rupeeValue,
        status: "PENDING",
        estimatedProcessingDays: 5,
      },
    });
  } catch (error: any) {
    res.status(coinErrorStatus(error)).json({
      success: false,
      message: error.message || "Failed to request bank transfer",
    });
  }
};

/**
 * Get rewards history (earned coins)
 */
export const getRewardsHistory = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { page = 1, limit = 20 } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const [transactions, total] = await Promise.all([
      CoinTransaction.find({
        userId,
        type: "EARNED",
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("bookingId", "bookingNumber"),
      CoinTransaction.countDocuments({ userId, type: "EARNED" }),
    ]);

    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch rewards history",
    });
  }
};

/**
 * Get redemption history (used coins)
 */
export const getRedemptionHistory = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { page = 1, limit = 20 } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const [transactions, total] = await Promise.all([
      CoinTransaction.find({
        userId,
        type: { $in: ["REDEEMED", "TRANSFERRED", "BANK_TRANSFER"] },
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("bookingId", "bookingNumber"),
      CoinTransaction.countDocuments({
        userId,
        type: { $in: ["REDEEMED", "TRANSFERRED", "BANK_TRANSFER"] },
      }),
    ]);

    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch redemption history",
    });
  }
};
