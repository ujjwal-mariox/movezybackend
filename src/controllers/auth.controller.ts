import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

import * as UserService from "../services/user.service";
import helpers from "../utils/helpers";
import redis from "../utils/redis";
import config from "../config";

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  const { mobileNumber } = req.body;

  const otp = helpers().generateOTP();
  const mobileQuery = { mobileNumber };

  const user = await UserService.fetchByQuery(mobileQuery);

  const redisKey = `USER_Mob_${mobileNumber}`;
  const redisKeys = await redis().GetKeys(redisKey);

  let txnId: string | undefined;

  if (redisKeys.length > 0) {
    const result = await redis().GetRedis<any>(redisKeys[0]);
    if (result?.[0]) {
      txnId = result[0].txnId;
    }
  }

  const newTxnId = uuidv4();

  const otpData = {
    txnId: newTxnId,
    mobileNumber,
    otp,
    reason: "OTP LOGIN LINK APP",
    is_active: 1,
    date_created: new Date(),
    date_modified: new Date(),
  };

  await UserService.setUserInRedisByTxnId(otpData);
  await UserService.setUserInRedisForReg(mobileNumber, otpData);

  req.rData = {
    userRegister: !!user,
    txnId: newTxnId,
  };

  req.msg = "otp_sent";
  next();
};

export const verifyOtp = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { otp, txnId } = req.body;

  // 1️⃣ Fetch OTP data from Redis using txnId
  const redisKey = `USER|txnId:${txnId}`;
  const redisKeys = await redis().GetKeys(redisKey);

  if (!redisKeys.length) {
    req.rCode = 0;
    req.msg = "incorrect_otp";
    return next();
  }

  const result = await redis().GetRedis<any>(redisKeys[0]);

  if (!result?.[0]) {
    req.rCode = 0;
    req.msg = "incorrect_otp";
    return next();
  }

  const otpData = result[0];
  const mobileNumber = otpData.mobileNumber;

  // 2️⃣ MASTER OTP CHECK (development only)
  if (
    config.env === "development" &&
    config.auth.masterOtp &&
    String(otp) === String(config.auth.masterOtp)
  ) {
    let user = await UserService.fetchByQuery({ mobileNumber });
    if (!user) {
      user = await UserService.addUsers({ mobileNumber });
    }

    const token = helpers().createJWT({ userId: user._id });
    await UserService.updateUsers(user._id, { token });

    req.rData = { token, userId: user._id };
    req.msg = "otp_verified";
    return next();
  }

  // 3️⃣ NORMAL OTP VALIDATION
  if (String(otp) !== String(otpData.otp)) {
    req.rCode = 0;
    req.msg = "incorrect_otp";
    return next();
  }

  // 4️⃣ User handling
  let user = await UserService.fetchByQuery({ mobileNumber });

  if (!user) {
    user = await UserService.addUsers({ mobileNumber });
  }

  const token = helpers().createJWT({ userId: user._id });
  await UserService.updateUsers(user._id, { token });

  req.rData = { token, userId: user._id };
  req.msg = "otp_verified";
  next();
};

export const resendOtp = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  const { countryCode, mobileNumber } = req.body;

  const otp = helpers().generateOTP();
  const user = await UserService.fetchByQuery({ countryCode, mobileNumber });

  const newTxnId = uuidv4();

  const otpData = {
    txnId: newTxnId,
    mobileNumber,
    otp,
    reason: "OTP RESEND LINK APP",
    is_active: 1,
    date_created: new Date(),
    date_modified: new Date(),
    countryCode,
  };

  await UserService.setUserInRedisByTxnId(otpData);
  await UserService.setUserInRedisForReg(mobileNumber, otpData);

  req.rData = {
    userRegister: !!user,
    txnId: newTxnId,
  };

  req.msg = "otp_sent";
  next();
};

export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  const { userId } = req.body;

  await UserService.updateUsers(userId, {
    deviceToken: null,
    deviceType: null,
    token: null,
  });

  req.msg = "logout";
  next();
};
