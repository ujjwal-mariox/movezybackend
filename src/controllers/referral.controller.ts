import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import crypto from "crypto";

import User from "../models/Users";
import * as RewardService from "../services/reward.service";
import RewardTransaction from "../models/reward-transaction.model";

// ─── CONSTANTS ───
const REFERRAL_CODE_LENGTH = 8;
const REFERRER_REWARD_AMOUNT = 100; // ₹100 for the person who referred
const REFEREE_REWARD_AMOUNT = 50; // ₹50 for the new user who was referred

/**
 * Generate a unique referral code: uppercase alphanumeric, 8 chars
 */
const generateUniqueReferralCode = async (): Promise<string> => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code: string;
  let exists = true;

  while (exists) {
    code = "";
    const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
    for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
      code += chars[bytes[i] % chars.length];
    }
    const existing = await User.findOne({ referralCode: code });
    exists = !!existing;
  }

  return code!;
};

/**
 * GET /user/referral
 * Get the current user's referral code. Generate one if it doesn't exist.
 */
export const getReferralCode = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).userId;

    let user = await User.findById(userId).select("referralCode fullName");

    if (!user) {
      req.rCode = 0;
      req.msg = "user_not_found";
      return next();
    }

    // Generate referral code if it doesn't exist yet
    if (!user.referralCode) {
      const code = await generateUniqueReferralCode();
      user = await User.findByIdAndUpdate(
        userId,
        { referralCode: code },
        { new: true }
      ).select("referralCode fullName");
    }

    req.rData = {
      referralCode: user!.referralCode,
    };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * POST /user/referral/apply
 * Apply a referral code to the current user.
 * Body: { referralCode: string }
 */
export const applyReferralCode = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).userId;
    const { referralCode } = req.body;

    if (!referralCode || typeof referralCode !== "string") {
      req.rCode = 0;
      req.msg = "referral_code_required";
      return next();
    }

    const currentUser = await User.findById(userId);

    if (!currentUser) {
      req.rCode = 0;
      req.msg = "user_not_found";
      return next();
    }

    // Already applied a referral code
    if (currentUser.referralApplied) {
      req.rCode = 0;
      req.msg = "referral_already_applied";
      return next();
    }

    // Can't use own referral code
    if (
      currentUser.referralCode &&
      currentUser.referralCode.toUpperCase() === referralCode.toUpperCase()
    ) {
      req.rCode = 0;
      req.msg = "cannot_use_own_referral";
      return next();
    }

    // Find the referrer by code
    const referrer = await User.findOne({
      referralCode: referralCode.toUpperCase(),
      isDeleted: false,
    });

    if (!referrer) {
      req.rCode = 0;
      req.msg = "invalid_referral_code";
      return next();
    }

    // Mark referral as applied
    await User.findByIdAndUpdate(userId, {
      referredBy: referrer._id,
      referralApplied: true,
    });

    // Give the new user (referee) their instant reward
    await RewardService.addReferralReward(
      new Types.ObjectId(userId),
      REFEREE_REWARD_AMOUNT,
      referrer._id
    );

    req.rData = {
      referrerName: referrer.fullName || "A Movezy user",
      rewardAmount: REFEREE_REWARD_AMOUNT,
    };
    req.msg = "referral_applied";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * GET /user/referral/stats
 * Get the current user's referral statistics.
 */
export const getReferralStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).userId;

    // Ensure referral code exists
    let user = await User.findById(userId).select("referralCode");

    if (!user) {
      req.rCode = 0;
      req.msg = "user_not_found";
      return next();
    }

    if (!user.referralCode) {
      const code = await generateUniqueReferralCode();
      user = await User.findByIdAndUpdate(
        userId,
        { referralCode: code },
        { new: true }
      ).select("referralCode");
    }

    // Count how many users this person has referred
    const referralCount = await User.countDocuments({
      referredBy: new Types.ObjectId(userId),
      isDeleted: false,
    });

    // Total earnings from referral rewards
    const earningsAgg = await RewardTransaction.aggregate([
      {
        $match: {
          userId: new Types.ObjectId(userId),
          type: "REFERRAL",
          status: { $in: ["PENDING", "CREDITED"] },
        },
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: "$amount" },
        },
      },
    ]);

    const totalEarnings =
      earningsAgg.length > 0 ? earningsAgg[0].totalEarnings : 0;

    // Recent referrals list
    const recentReferrals = await User.find({
      referredBy: new Types.ObjectId(userId),
      isDeleted: false,
    })
      .select("fullName mobileNumber createdAt")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    req.rData = {
      referralCode: user!.referralCode,
      referralCount,
      totalEarnings,
      referrerRewardAmount: REFERRER_REWARD_AMOUNT,
      refereeRewardAmount: REFEREE_REWARD_AMOUNT,
      recentReferrals: recentReferrals.map((r: any) => ({
        name: r.fullName || "New User",
        mobile: r.mobileNumber
          ? `${r.mobileNumber.slice(0, 2)}****${r.mobileNumber.slice(-2)}`
          : "",
        joinedAt: r.createdAt,
      })),
    };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};
