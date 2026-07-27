import RewardTransaction from "../models/reward-transaction.model";
import { addToWallet } from "./wallet.service";
import { Types } from "mongoose";

export const addReferralReward = async (
  userId: Types.ObjectId,
  amount: number,
  referenceUserId: Types.ObjectId
) => {
  const reward = await RewardTransaction.create({
    userId,
    amount,
    type: "REFERRAL",
    referenceUserId,
  });

  // Credit through the shared wallet path so the balance change is explained by a
  // WalletTransaction row. addToWallet performs the single $inc and writes the
  // matching CREDIT row, so the balance still moves exactly once.
  await addToWallet(
    userId,
    amount,
    reward._id.toString(),
    "Referral reward"
  );
};

export const getRewards = async (userId: Types.ObjectId) => {
  const rewards = await RewardTransaction.find({ userId }).sort({
    createdAt: -1,
  });

  const total = rewards.reduce((sum, r) => sum + r.amount, 0);

  return { total, rewards };
};
