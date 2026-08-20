import { Types } from "mongoose";
import crypto from "crypto";
import User from "../models/Users";
import helpers from "../utils/helpers";
import redis from "../utils/redis";
import { IUser } from "../interfaces/users";
import { generateEntityCode } from "./entity-code.service";

/**
 * Generate a unique referral code (8-char uppercase alphanumeric)
 */
const generateUniqueReferralCode = async (): Promise<string> => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code: string;
  let exists = true;

  while (exists) {
    code = "";
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
      code += chars[bytes[i] % chars.length];
    }
    const existing = await User.findOne({ referralCode: code });
    exists = !!existing;
  }

  return code!;
};

/**
 * Create user — auto-generates a unique referral code and the short display
 * ID ("CUS-0042") admins search by. Code-allocation failure doesn't block
 * signup; the boot backfill repairs any account left without one.
 */
export const addUsers = async (data: Partial<IUser>) => {
  const referralCode = await generateUniqueReferralCode();
  let userCode: string | undefined;
  try {
    userCode = await generateEntityCode("user");
  } catch (err) {
    console.error("userCode allocation failed (backfill will repair):", err);
  }
  return await User.create({
    ...data,
    referralCode,
    ...(userCode && { userCode }),
  });
};

/**
 * Fetch user by ID
 */
export const fetch = async (id: string | Types.ObjectId) => {
  return await User.findById(id).select("-password -time -otp");
};

/**
 * Fetch user by query
 */
export const fetchByQuery = async (query: any) => {
  return await User.findOne(query).select("-password");
};

/**
 * Verify password
 */
export const verifyPassword = async (
  id: string | Types.ObjectId,
  password: string
): Promise<boolean> => {
  console.log("UserService => verifyPassword");

  const user: any = await User.findById(id);
  if (!user) return false;

  return await helpers().checkPassword(password, user.password);
};

/**
 * Delete user
 */
export const deleteUser = async (id: string | Types.ObjectId) => {
  return await User.deleteOne({ _id: id });
};

/**
 * Reset password
 */
export const resetPassword = async (
  userId: string | Types.ObjectId,
  password: string
) => {
  const hashedPassword = await helpers().hashPassword(password);
  return await User.findByIdAndUpdate(userId, { password: hashedPassword });
};

/**
 * Update user
 */
export const updateUsers = async (
  userId: string | Types.ObjectId,
  data: Partial<IUser>
) => {
  return await User.findByIdAndUpdate(
    userId,
    { $set: data },
    {
      new: true,
      runValidators: true,
    }
  );
};

/**
 * Get users list
 */
export const getUser = async (query: any, page = 0, limit = 10) => {
  return await User.find(query)
    .select("-password -__v")
    .sort({ _id: -1 })
    // .skip(page * limit)
    .limit(limit);
};

/**
 * Count users
 */
export const countUser = async (query: any) => {
  return await User.countDocuments(query);
};

/**
 * Redis: set user by txnId
 */
export const setUserInRedisByTxnId = (otpData: any) => {
  if (!otpData) return;

  const txnId = otpData.txnId;

  redis()
    .SetRedis(`USER|txnId:${txnId}`, otpData, 60)
    .catch((err: any) => console.error("Redis setUserInRedisByTxnId error:", err.message));
};

/**
 * Redis: set OTP for registration
 */
export const setUserInRedisForReg = async (phoneNo: string, otpData: any) => {
  if (!otpData) return null;

  const redisKey = `USER_Mob_${phoneNo}`;
  return await setOTPInRedis(redisKey, otpData);
};

/**
 * Redis helpers
 */
const setOTPInRedis = async (redisKey: string, otpData: any) => {
  const res = await checkIfOtpExistInRedis(redisKey);
  if (res) return res;

  await redis().SetRedis(redisKey, otpData, 60);
  return null;
};

const checkIfOtpExistInRedis = async (key: string) => {
  return await redis().GetKeyRedis(key);
};
