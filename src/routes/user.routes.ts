import { Router } from "express";

import * as UserController from "../controllers/user.controller";
import * as GSTController from "../controllers/gst.controller";
import * as RewardController from "../controllers/reward.controller";
import * as ReferralController from "../controllers/referral.controller";
import ErrorHandlerMiddleware from "../middlewares/error-handler.middleware";
import ResponseMiddleware from "../middlewares/response.middleware";
import AuthMiddleware from "../middlewares/auth.middleware";
import UsersValidator from "../validators/users.validator";
import upload from "../middlewares/upload.middleware";
import * as AccountDeletionController from "../controllers/account-deletion.controller";

const userRouter = Router();

/**
 * Profile
 */
userRouter.get(
  "/profile",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(UserController.getDetails),
  ResponseMiddleware
);

userRouter.put(
  "/profile",
  AuthMiddleware().verifyUserToken,
  upload.array("profileImage", 1),
  ErrorHandlerMiddleware(UserController.editUser),
  ResponseMiddleware
);

/**
 * Address
 */
userRouter.post(
  "/address",
  AuthMiddleware().verifyUserToken,
  UsersValidator().validateAddress,
  ErrorHandlerMiddleware(UserController.addUserAddress),
  ResponseMiddleware
);

userRouter.get(
  "/address",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(UserController.getUserAddress),
  ResponseMiddleware
);

userRouter.get(
  "/address/:id",
  AuthMiddleware().verifyUserToken,
  UsersValidator().validateAddressId,
  ErrorHandlerMiddleware(UserController.getUserAddressDetail),
  ResponseMiddleware
);

userRouter.delete(
  "/address/:id",
  AuthMiddleware().verifyUserToken,
  UsersValidator().validateAddressId,
  ErrorHandlerMiddleware(UserController.deleteUserAddress),
  ResponseMiddleware
);

userRouter.put(
  "/address/:id",
  AuthMiddleware().verifyUserToken,
  UsersValidator().validateAddressId,
  ErrorHandlerMiddleware(UserController.updateUserAddress),
  ResponseMiddleware
);

/**
 * Notifications
 */
userRouter.get(
  "/notifications/switch",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(UserController.activateDeactivateNotification),
  ResponseMiddleware
);

/**
 * GST
 */
userRouter.post(
  "/gst",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(GSTController.addOrUpdateGST),
  ResponseMiddleware
);

userRouter.get(
  "/gst",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(GSTController.getGST),
  ResponseMiddleware
);

/**
 * Referral Code
 */
userRouter.get(
  "/rewards",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(RewardController.getRewards),
  ResponseMiddleware
);

/**
 * Referral System
 */
userRouter.get(
  "/referral",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(ReferralController.getReferralCode),
  ResponseMiddleware
);

userRouter.post(
  "/referral/apply",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(ReferralController.applyReferralCode),
  ResponseMiddleware
);

userRouter.get(
  "/referral/stats",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(ReferralController.getReferralStats),
  ResponseMiddleware
);

/**
 * Delete my account (both app stores require it): GET = what's in the way and
 * what money would be lost; POST = schedule it (login closes, 30 days to undo
 * by signing in again).
 */
userRouter.get(
  "/account/deletion",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(AccountDeletionController.getDeletionCheck),
  ResponseMiddleware
);
userRouter.post(
  "/account/deletion",
  AuthMiddleware().verifyUserToken,
  ErrorHandlerMiddleware(AccountDeletionController.requestDeletion),
  ResponseMiddleware
);

export default userRouter;
