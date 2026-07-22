import {
  CoinWallet,
  CoinTransaction,
  ICoinTransaction,
} from "../models/coin.model";
import { AppConfig } from "../models/app-config.model";
import Wallet from "../models/wallet.model";
import WalletTransaction from "../models/wallet-transaction.model";
import { CoinPayout } from "../models/coin-payout.model";
import config from "../config";
import { Types } from "mongoose";

/**
 * Get coin wallet for user
 */
export const getCoinWallet = async (userId: Types.ObjectId) => {
  let wallet = await CoinWallet.findOne({ userId });

  if (!wallet) {
    wallet = await CoinWallet.create({ userId, balance: 0 });
  }

  return wallet;
};

/**
 * Get coin transaction history
 */
export const getCoinTransactions = async (
  userId: Types.ObjectId,
  page = 0,
  limit = 20,
) => {
  return await CoinTransaction.find({ userId, status: "COMPLETED" })
    .sort({ createdAt: -1 })
    .skip(page * limit)
    .limit(limit);
};

/**
 * Calculate coins earned for a booking
 */
export const calculateCoinsEarned = async (
  bookingAmount: number,
  vehicleType: string,
): Promise<number> => {
  // Get coin earning config
  const config = await AppConfig.findOne({ key: "COIN_EARNING_RATE" });
  const earningRate = config?.value || 2; // Default: 2 coins per ₹100 spent

  // Truck and 2-wheeler have different rates as per UI
  let multiplier = 1;
  if (vehicleType === "2W" || vehicleType.toLowerCase().includes("truck")) {
    multiplier = 1; // Same rate for these
  }

  const coinsEarned = Math.floor(
    (bookingAmount / 100) * earningRate * multiplier,
  );
  return coinsEarned;
};

/**
 * Credit coins to user wallet
 */
export const creditCoins = async (
  userId: Types.ObjectId,
  amount: number,
  source: ICoinTransaction["source"],
  referenceId?: Types.ObjectId,
  referenceType?: "Booking" | "User",
  description?: string,
) => {
  if (amount <= 0) return;

  // Get expiry config (default 30 days)
  const expiryConfig = await AppConfig.findOne({ key: "COIN_EXPIRY_DAYS" });
  const expiryDays = expiryConfig?.value || 30;
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + expiryDays);

  // Create transaction
  await CoinTransaction.create({
    userId,
    amount,
    type: "EARNED",
    source,
    referenceId,
    referenceType,
    description: description || `Earned ${amount} coins`,
    expiryDate,
    status: "COMPLETED",
  });

  // Update wallet
  await CoinWallet.findOneAndUpdate(
    { userId },
    {
      $inc: { balance: amount, totalEarned: amount },
    },
    { upsert: true },
  );
};

/**
 * Debit coins from user wallet
 */
export const debitCoins = async (
  userId: Types.ObjectId,
  amount: number,
  source: ICoinTransaction["source"],
  referenceId?: Types.ObjectId,
  referenceType?: "Booking" | "User",
  description?: string,
) => {
  // Atomic debit: only succeeds if balance >= amount
  const updatedWallet = await CoinWallet.findOneAndUpdate(
    { userId, balance: { $gte: amount } },
    {
      $inc: { balance: -amount, totalRedeemed: amount },
    },
    { new: true },
  );

  if (!updatedWallet) {
    throw new Error("Insufficient coin balance");
  }

  // Create transaction
  return await CoinTransaction.create({
    userId,
    amount: -amount,
    type: "REDEEMED",
    source,
    referenceId,
    referenceType,
    description: description || `Redeemed ${amount} coins`,
    status: "COMPLETED",
  });
};

/**
 * Get coin value in rupees
 */
export const getCoinValueInRupees = async (coins: number): Promise<number> => {
  // Get conversion rate config
  const config = await AppConfig.findOne({ key: "COIN_TO_RUPEE_RATE" });
  const rate = config?.value || 1; // Default: 1 coin = ₹1

  return coins * rate;
};

/**
 * The coin economics the customer is shown, read from live config.
 *
 * The app used to hardcode "2 coins per ₹100", "1 Coin = ₹1", "₹0.9" and
 * "30 days" into the How-to-earn-coins sheet. Those happen to match today only
 * because no COIN_* AppConfig rows exist; the moment an admin sets one, the
 * sheet would quietly start lying to customers. Serving them keeps the copy
 * and the actual maths in sync.
 */
export const getCoinConfig = async () => {
  const [earn, rupee, bank, expiry] = await Promise.all([
    AppConfig.findOne({ key: "COIN_EARNING_RATE" }),
    AppConfig.findOne({ key: "COIN_TO_RUPEE_RATE" }),
    AppConfig.findOne({ key: "COIN_TO_BANK_RATE" }),
    AppConfig.findOne({ key: "COIN_EXPIRY_DAYS" }),
  ]);

  // Defaults MUST match the ones used by the earning/redeeming paths above,
  // or the customer would be quoted terms the ledger doesn't honour.
  return {
    earnRatePer100: earn?.value ?? 2,
    rupeeRate: rupee?.value ?? 1,
    bankRate: bank?.value ?? 0.9,
    expiryDays: expiry?.value ?? 30,
    minWalletTransfer: config.coins.minTransferToWallet,
    minBankTransfer: config.coins.minBankTransfer,
  };
};

/**
 * Get the coin→bank conversion rate.
 */
export const getCoinToBankRate = async (): Promise<number> => {
  // As per UI: 1 Coin = ₹0.9 for bank transfer
  const config = await AppConfig.findOne({ key: "COIN_TO_BANK_RATE" });
  return config?.value || 0.9;
};

/**
 * Get coin value for bank transfer (usually less)
 */
export const getCoinValueForBankTransfer = async (
  coins: number,
): Promise<number> => {
  const rate = await getCoinToBankRate();

  return coins * rate;
};

/**
 * Transfer coins to wallet
 */
export const transferCoinsToWallet = async (
  userId: Types.ObjectId,
  coins: number,
) => {
  const wallet = await getCoinWallet(userId);

  if (wallet.balance < coins) {
    throw new Error("Insufficient coin balance");
  }

  const rupeeValue = await getCoinValueInRupees(coins);

  // Debit coins
  await debitCoins(
    userId,
    coins,
    "WALLET_TRANSFER",
    undefined,
    undefined,
    `Transferred ${coins} coins to Movezy Credits (₹${rupeeValue})`,
  );

  // ...and actually credit the money wallet.
  //
  // This step did not exist. The coins were debited, the controller replied
  // "Coins transferred to wallet successfully" with an amountCredited figure,
  // and the customer's wallet balance never moved — their coins simply
  // disappeared. The credit happens after the debit so a failed debit (e.g.
  // insufficient balance, which throws) can never mint money.
  let moneyWallet = await Wallet.findOne({ userId });
  if (!moneyWallet) {
    moneyWallet = new Wallet({ userId, balance: 0 });
  }
  const balanceBefore = moneyWallet.balance;
  moneyWallet.balance += rupeeValue;
  await moneyWallet.save();

  await WalletTransaction.create({
    userId,
    type: "CREDIT",
    amount: rupeeValue,
    balanceBefore,
    balanceAfter: moneyWallet.balance,
    description: `${coins} coins converted to Movezy Credits`,
    status: "COMPLETED",
  });

  return { coins, rupeeValue, walletBalance: moneyWallet.balance };
};

/**
 * Request bank transfer for coins
 */
export const requestBankTransfer = async (
  userId: Types.ObjectId,
  coins: number,
  bankDetails: { accountNumber: string; ifsc: string; accountName: string },
) => {
  const rate = await getCoinToBankRate();
  const rupeeValue = coins * rate;

  // Atomic debit, guarded on balance >= coins.
  //
  // This previously read the balance and then $inc'd it in a separate call,
  // with no guard on the update — two concurrent requests could both pass the
  // check and drive the balance negative (the schema's `min: 0` does not fire,
  // because findOneAndUpdate skips validators by default). debitCoins does the
  // check and the decrement in one guarded update, and throws if short. It also
  // maintains totalRedeemed, which the old $inc did not.
  const debit = await debitCoins(
    userId,
    coins,
    "BANK_TRANSFER",
    undefined,
    undefined,
    `Bank payout requested: ${coins} coins = ₹${rupeeValue}`,
  );

  // Persist the request WITH the bank details.
  //
  // The details used to be accepted as a parameter and dropped on the floor —
  // there was no field for them on CoinTransaction, and no queue to work. An
  // operator had no account number to pay, so the coins simply disappeared.
  const payout = await CoinPayout.create({
    userId,
    coins,
    amount: rupeeValue,
    rateApplied: rate,
    bankSnapshot: {
      accountName: bankDetails.accountName,
      accountNumber: bankDetails.accountNumber,
      ifsc: bankDetails.ifsc,
    },
    debitTransactionId: debit?._id,
    status: "PENDING",
  });

  return { coins, rupeeValue, transactionId: payout._id };
};

/**
 * Return coins locked by a payout request that will not be paid.
 *
 * Reverses the debit rather than minting new coins: totalRedeemed goes back
 * down instead of totalEarned going up, so a rejected request leaves the
 * customer's lifetime stats exactly where they started.
 */
export const refundCoinPayout = async (
  userId: Types.ObjectId,
  coins: number,
  reason: string,
) => {
  await CoinWallet.findOneAndUpdate(
    { userId },
    { $inc: { balance: coins, totalRedeemed: -coins } },
  );

  await CoinTransaction.create({
    userId,
    amount: coins,
    type: "EARNED",
    source: "BANK_TRANSFER",
    description: `Bank payout refunded: ${reason}`,
    status: "COMPLETED",
  });
};

/**
 * Expire old coins (intended to run via cron).
 *
 * NOTE: this is not currently scheduled anywhere. Before it is, be aware it does
 * NOT do per-lot spend accounting — it has no way to know which specific earned
 * coins are still unspent, so it approximates by clawing back at most the user's
 * CURRENT balance per expired lot. That is safe (never negative, never more than
 * they hold) but not exact: a user who spent an old lot and re-earned a new one
 * can have the newer coins clawed instead. Doing this precisely needs FIFO lot
 * tracking that the schema doesn't have yet.
 *
 * What was fixed: the previous version set `status = "COMPLETED"` on rows that
 * were already COMPLETED — marking nothing — so every run re-found the same
 * expired lots, minted duplicate EXPIRED rows, and decremented the wallet again,
 * draining balances without bound. And the decrement had no floor, so balances
 * could go negative. Both are closed below via the `expiredAt` idempotency
 * marker and a balance floor.
 */
export const expireOldCoins = async () => {
  const now = new Date();

  // `expiredAt: null` matches both an explicit null and a missing field, so
  // this only ever picks up lots that have never been processed.
  const expiredLots = await CoinTransaction.find({
    type: "EARNED",
    status: "COMPLETED",
    expiryDate: { $lte: now },
    expiredAt: null,
  });

  let coinsExpired = 0;

  for (const tx of expiredLots) {
    const wallet = await CoinWallet.findOne({ userId: tx.userId });
    const available = wallet?.balance ?? 0;
    // Can't expire coins the user no longer holds; floor at 0.
    const toExpire = Math.min(tx.amount, available);

    // Mark the lot processed FIRST. If the loop dies after this, the lot is
    // simply never expired rather than expired twice — the safe failure.
    tx.expiredAt = now;
    await tx.save();

    if (toExpire > 0 && wallet) {
      wallet.balance = available - toExpire;
      await wallet.save();

      await CoinTransaction.create({
        userId: tx.userId,
        amount: -toExpire,
        type: "EXPIRED",
        source: "BONUS",
        description: `${toExpire} coins expired`,
        status: "COMPLETED",
        expiredAt: now,
      });

      coinsExpired += toExpire;
    }
  }

  return { lotsProcessed: expiredLots.length, coinsExpired };
};
