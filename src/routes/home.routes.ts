import { Router } from "express";
import * as HomeController from "../controllers/home.controller";
import ErrorHandlerMiddleware from "../middlewares/error-handler.middleware";
import ResponseMiddleware from "../middlewares/response.middleware";

const homeRouter = Router();

/**
 * GET /home
 * Public endpoint — returns everything the user app home screen needs.
 * No authentication required so the home screen loads immediately.
 */
homeRouter.get(
  "/",
  ErrorHandlerMiddleware(HomeController.getHomePage),
  ResponseMiddleware
);

/**
 * GET /home/image-proxy?url=<encoded_url>
 * Proxies external image URLs through the backend so Android emulators
 * (which often fail DNS lookups) can load images.
 */
homeRouter.get("/image-proxy", HomeController.imageProxy);

export default homeRouter;
