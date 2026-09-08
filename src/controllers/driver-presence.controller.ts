import { Request, Response, NextFunction } from "express";
import { recordHeartbeat } from "../services/presence.service";

/**
 * POST /driver/app/heartbeat
 *
 * Sent by the driver app's foreground service every minute (screen locked or
 * not) and by the app on resume. Keeps the driver online through the
 * presence sweep and refreshes their dispatch position when coordinates are
 * included. Cheap by design: one throttled Mongo write, one Redis GEOADD.
 */
export const heartbeat = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const driverId = (req as any).driverId;
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    await recordHeartbeat(driverId, {
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
      source: String(req.body?.source || "app"),
    });
    req.rData = { receivedAt: new Date().toISOString() };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};
