import { Request, Response, NextFunction } from "express";
// Node's built-in RFC 4122 v4 generator, not the `uuid` package. uuid v13 is
// ESM-only, so the CommonJS output this project compiles to could not require()
// it on any Node older than 20.19 — it booted locally on 22.x and crashed on a
// 20.18 host. crypto.randomUUID has been available since Node 14.17 and needs
// no dependency at all.
import { randomUUID } from "crypto";

import * as UserService from "../services/user.service";
import * as SmsService from "../services/sms.service";
import helpers from "../utils/helpers";
import redis from "../utils/redis";
import config from "../config";

/**
 * Deliver a login OTP by SMS. Fire-and-forget: never block or fail the login
 * response on an SMS provider hiccup — the OTP is already stored in Redis.
 * When Twilio is unconfigured this is a logged no-op (dev uses the master OTP).
 */
const sendOtpSms = (mobileNumber: string, otp: string): void => {
  SmsService.sendSms(
    mobileNumber,
    `${otp} is your Movezy verification code. It is valid for a few minutes. Do not share it with anyone.`,
  ).catch(() => null);
};

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  // The WhatsApp-updates checkbox lives on the login screen, but the account is
  // only created once the OTP is verified — so the consent travels with the OTP
  // transaction. It used to live in widget state and was simply discarded.
  const { mobileNumber, whatsappOptIn } = req.body;

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

  const newTxnId = randomUUID();

  const otpData = {
    txnId: newTxnId,
    mobileNumber,
    otp,
    whatsappOptIn: Boolean(whatsappOptIn),
    reason: "OTP LOGIN LINK APP",
    is_active: 1,
    date_created: new Date(),
    date_modified: new Date(),
  };

  await UserService.setUserInRedisByTxnId(otpData);
  await UserService.setUserInRedisForReg(mobileNumber, otpData);

  sendOtpSms(mobileNumber, otp);

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

  // Record the WhatsApp consent captured on the login screen. Both the opt-in
  // and the opt-out matter, so this is written on every sign-in rather than
  // only when it is true.
  const whatsappOptIn = Boolean(otpData.whatsappOptIn);

  if (!user) {
    user = await UserService.addUsers({ mobileNumber, whatsappOptIn });
  }

  const token = helpers().createJWT({ userId: user._id });
  await UserService.updateUsers(user._id, { token, whatsappOptIn });

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

  const newTxnId = randomUUID();

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

  sendOtpSms(mobileNumber, otp);

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

  // The caller is whoever the token says they are. This read `req.body.userId`,
  // but /logout is a GET — there is no body, so userId was always undefined and
  // the update below never named a user. verifyUserToken puts the authenticated
  // id on the request itself.
  const userId = (req as any).userId;

  // Clear the push token so a logged-out device stops receiving notifications.
  // This used to write deviceToken/deviceType/token — none of which are declared
  // on the User schema — so strict mode dropped the whole update and logout did
  // nothing at all. `fcmToken` is the field push actually reads.
  if (userId) {
    await UserService.updateUsers(userId, {
      fcmToken: null,
    });
  }

  req.msg = "logout";
  next();
};
