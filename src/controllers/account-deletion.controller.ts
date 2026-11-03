import { Request, Response, NextFunction } from "express";
import * as AccountDeletion from "../services/account-deletion.service";

/**
 * "Delete my account" for both apps. GET tells the confirm screen what's in
 * the way (live trip, unpaid earnings) and what money would be lost; POST
 * schedules the deletion and closes the login.
 */

const ownerOf = (req: Request): { kind: "user" | "driver"; id: string } => {
  const driverId = (req as any).driverId;
  if (driverId) return { kind: "driver", id: String(driverId) };
  return { kind: "user", id: String((req as any).user._id) };
};

export const getDeletionCheck = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const { kind, id } = ownerOf(req);
  req.rData = await AccountDeletion.checkDeletion(kind, id);
  next();
};

export const requestDeletion = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const { kind, id } = ownerOf(req);
  const result = await AccountDeletion.requestDeletion(kind, id);
  if (result.blockers.length) {
    req.rCode = 0;
    req.msg = result.blockers[0];
    req.rData = { blockers: result.blockers };
    return next();
  }
  req.msg = `Your account will be deleted on ${result.scheduledFor!.toLocaleDateString(
    "en-IN",
    { day: "numeric", month: "long", year: "numeric" },
  )}. Sign in again before then to keep it.`;
  req.rData = { scheduledFor: result.scheduledFor };
  next();
};
