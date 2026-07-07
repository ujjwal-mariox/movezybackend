import { Router } from "express";
import * as ChatController from "../controllers/chat.controller";
import AuthMiddleware from "../middlewares/auth.middleware";
import ErrorHandlerMiddleware from "../middlewares/error-handler.middleware";
import ResponseMiddleware from "../middlewares/response.middleware";
import upload from "../middlewares/upload.middleware";

// User-facing chat REST routes (history + image upload). Real-time send/receive
// happens over Socket.io (chat:message). The controllers are token-agnostic —
// they operate on the bookingId only — so they're reused for both apps.
const router = Router();
const { verifyUserToken } = AuthMiddleware();

router.get(
  "/:bookingId/history",
  verifyUserToken,
  ErrorHandlerMiddleware(ChatController.getChatHistory),
  ResponseMiddleware,
);

router.post(
  "/:bookingId/upload-image",
  verifyUserToken,
  upload.any(),
  ErrorHandlerMiddleware(ChatController.uploadChatImage),
  ResponseMiddleware,
);

export default router;
