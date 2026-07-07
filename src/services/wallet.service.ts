import Wallet from "../models/wallet.model";
import WalletTransaction from "../models/wallet-transaction.model";
import { Types } from "mongoose";

export const addToWallet = async (
  userId: Types.ObjectId,
  amount: number,
  referenceId?: string,
  description?: string
) => {
  // get current balance first
  const existing = await Wallet.findOne({ userId });
  const balanceBefore = existing?.balance || 0;

  // upsert wallet
  const wallet = await Wallet.findOneAndUpdate(
    { userId },
    { $inc: { balance: amount } },
    { new: true, upsert: true }
  );

  // store transaction with balance tracking
  await WalletTransaction.create({
    userId,
    amount,
    type: "CREDIT",
    referenceId,
    description: description || "Wallet Recharge",
    balanceBefore,
    balanceAfter: wallet.balance,
    status: "COMPLETED",
  });

  return wallet;
};

export const debitFromWallet = async (
  userId: Types.ObjectId,
  amount: number,
  referenceId?: string,
  description?: string
) => {
  // Atomic debit: only succeeds if balance >= amount
  const wallet = await Wallet.findOneAndUpdate(
    { userId, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
    { new: true }
  );

  if (!wallet) {
    throw new Error("Insufficient wallet balance");
  }

  const balanceBefore = wallet.balance + amount;

  await WalletTransaction.create({
    userId,
    amount,
    type: "DEBIT",
    referenceId,
    description: description || "Wallet Debit",
    balanceBefore,
    balanceAfter: wallet.balance,
    status: "COMPLETED",
  });

  return wallet;
};

export const getWallet = async (userId: Types.ObjectId) => {
  const wallet = await Wallet.findOne({ userId });

  const transactions = await WalletTransaction.find({ userId })
    .sort({ createdAt: -1 })
    .limit(20);

  return {
    balance: wallet?.balance || 0,
    transactions,
  };
};

export const getTransactions = async (
  userId: Types.ObjectId,
  page: number = 1,
  limit: number = 20
) => {
  const skip = (page - 1) * limit;
  const [transactions, total] = await Promise.all([
    WalletTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    WalletTransaction.countDocuments({ userId }),
  ]);

  return {
    transactions,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};

// ─── ADMIN FUNCTIONS ───

export const getAllWallets = async (
  page: number = 1,
  limit: number = 20,
  search?: string
) => {
  const skip = (page - 1) * limit;

  // Get all wallets with user info
  const pipeline: any[] = [
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
  ];

  if (search) {
    pipeline.push({
      $match: {
        $or: [
          { "user.fullName": { $regex: search, $options: "i" } },
          { "user.mobileNumber": { $regex: search, $options: "i" } },
          { "user.email": { $regex: search, $options: "i" } },
        ],
      },
    });
  }

  const countPipeline = [...pipeline, { $count: "total" }];
  pipeline.push(
    { $sort: { balance: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        _id: 1,
        userId: 1,
        balance: 1,
        lockedBalance: 1,
        createdAt: 1,
        updatedAt: 1,
        "user.fullName": 1,
        "user.mobileNumber": 1,
        "user.email": 1,
        "user.profileImage": 1,
      },
    }
  );

  const [wallets, countResult] = await Promise.all([
    Wallet.aggregate(pipeline),
    Wallet.aggregate(countPipeline),
  ]);

  const total = countResult[0]?.total || 0;

  return {
    wallets,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};

export const getUserWalletAdmin = async (userId: Types.ObjectId) => {
  const wallet = await Wallet.findOne({ userId });
  const transactions = await WalletTransaction.find({ userId })
    .sort({ createdAt: -1 })
    .limit(50);

  return {
    balance: wallet?.balance || 0,
    lockedBalance: wallet?.lockedBalance || 0,
    transactions,
  };
};

export const adminCreditWallet = async (
  userId: Types.ObjectId,
  amount: number,
  description: string,
  adminId: string
) => {
  return addToWallet(
    userId,
    amount,
    `admin_credit_${adminId}_${Date.now()}`,
    description || "Admin Credit"
  );
};

export const adminDebitWallet = async (
  userId: Types.ObjectId,
  amount: number,
  description: string,
  adminId: string
) => {
  return debitFromWallet(
    userId,
    amount,
    `admin_debit_${adminId}_${Date.now()}`,
    description || "Admin Debit"
  );
};

export const getAllTransactions = async (
  page: number = 1,
  limit: number = 20,
  type?: string,
  status?: string
) => {
  const skip = (page - 1) * limit;
  const filter: any = {};
  if (type) filter.type = type;
  if (status) filter.status = status;

  const pipeline: any[] = [
    { $match: filter },
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
  ];

  const countPipeline = [...pipeline, { $count: "total" }];
  pipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        _id: 1,
        userId: 1,
        amount: 1,
        type: 1,
        referenceId: 1,
        description: 1,
        balanceBefore: 1,
        balanceAfter: 1,
        status: 1,
        createdAt: 1,
        "user.fullName": 1,
        "user.mobileNumber": 1,
      },
    }
  );

  const [transactions, countResult] = await Promise.all([
    WalletTransaction.aggregate(pipeline),
    WalletTransaction.aggregate(countPipeline),
  ]);

  const total = countResult[0]?.total || 0;
  return {
    transactions,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};
