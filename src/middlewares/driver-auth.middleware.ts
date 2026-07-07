import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import config from "../config";

export default () => {
  return {
    verifyDriverToken: async (
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      try {
        const token = req.headers.authorization?.replace("Bearer ", "");

        if (!token) {
          return res.status(401).json({
            rCode: 0,
            rMsg: "unauthorized",
            rData: {},
          });
        }

        const decoded: any = jwt.verify(token, config.auth.jwtSecret);

        if (!decoded.driverId) {
          return res.status(401).json({
            rCode: 0,
            rMsg: "invalid_token",
            rData: {},
          });
        }

        // Verify driver exists and is active
        const Driver = (await import("../models/driver.model")).default;
        const driver = await Driver.findById(decoded.driverId).select("status isActive isDeleted");

        if (!driver || driver.isDeleted) {
          return res.status(401).json({
            rCode: 0,
            rMsg: "driver_not_found",
            rData: {},
          });
        }

        if (driver.isActive === false) {
          return res.status(403).json({
            rCode: 0,
            rMsg: "driver_suspended",
            rData: {},
          });
        }

        (req as any).driverId = decoded.driverId;
        (req as any).driver = driver;
        next();
      } catch (error) {
        return res.status(401).json({
          rCode: 0,
          rMsg: "invalid_token",
          rData: {},
        });
      }
    },
  };
};
