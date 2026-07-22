import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import config from "../config";
import { Admin, AdminSession } from "../models/admin.model";
import { Role } from "../models/role.model";

interface AdminTokenPayload {
  adminId: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: any;
      adminId?: string;
    }
  }
}

const AdminAuthMiddleware = () => {
  const verifyAdminToken = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          message: "Authorization token required",
        });
      }

      const token = authHeader.split(" ")[1];

      // Verify token
      const decoded = jwt.verify(
        token,
        config.auth.jwtSecret,
      ) as AdminTokenPayload;

      // Check if session is valid
      const session = await AdminSession.findOne({
        adminId: decoded.adminId,
        token,
        isActive: true,
        expiresAt: { $gt: new Date() },
      });

      if (!session) {
        return res.status(401).json({
          success: false,
          message: "Session expired or invalid",
        });
      }

      // Get admin details with role populated
      const admin = await Admin.findOne({
        _id: decoded.adminId,
        isActive: true,
        isDeleted: false,
      }).populate("roleId");

      if (!admin) {
        return res.status(401).json({
          success: false,
          message: "Admin not found or inactive",
        });
      }

      // IP Whitelist check
      const clientIp =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        "";
      if (
        admin.ipWhitelist &&
        admin.ipWhitelist.length > 0 &&
        !admin.ipWhitelist.includes(clientIp)
      ) {
        return res.status(403).json({
          success: false,
          message: "Access denied: IP address not whitelisted",
        });
      }

      // Time-restricted access check
      if (admin.accessTimeRestriction?.enabled) {
        const tz = admin.accessTimeRestriction.timezone || "Asia/Kolkata";
        const nowInTz = new Date(
          new Date().toLocaleString("en-US", { timeZone: tz }),
        );
        const currentHour = nowInTz.getHours();
        const { startHour, endHour } = admin.accessTimeRestriction;
        const inWindow =
          startHour <= endHour
            ? currentHour >= startHour && currentHour < endHour
            : currentHour >= startHour || currentHour < endHour;
        if (!inWindow) {
          return res.status(403).json({
            success: false,
            message: `Access restricted to ${startHour}:00 – ${endHour}:00 (${tz})`,
          });
        }
      }

      // Compute permissions from role + custom permissions
      const roleDoc = admin.roleId as any;
      const rolePermissions = roleDoc?.permissions || [];
      const customPermissions = admin.customPermissions || [];
      // Stored permissions too: the seeded super admin carries
      // permissions:["all"] directly on the Admin doc with no roleId, and
      // ignoring it locked the only existing account out of every
      // requirePermission route with a 403.
      const storedPermissions = admin.permissions || [];
      const allPermissions = [
        ...new Set([
          ...rolePermissions,
          ...customPermissions,
          ...storedPermissions,
        ]),
      ];

      // Attach admin with computed permissions to request
      req.admin = {
        ...admin.toObject(),
        roleName: roleDoc?.name || admin.roleName,
        permissions: allPermissions,
      };
      req.adminId = admin._id.toString();

      next();
    } catch (error: any) {
      if (error.name === "JsonWebTokenError") {
        return res.status(401).json({
          success: false,
          message: "Invalid token",
        });
      }
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          message: "Token expired",
        });
      }
      return res.status(500).json({
        success: false,
        message: "Authentication error",
      });
    }
  };

  const requireRole = (...roles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      if (!roles.includes(req.admin.roleName)) {
        return res.status(403).json({
          success: false,
          message: "Insufficient permissions",
        });
      }

      next();
    };
  };

  const requirePermission = (...permissions: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      // Super admin has all permissions. "all" is how the seed grants
      // full access (the Admin schema has no `role` path — the seed's
      // role:"SUPER_ADMIN" was silently dropped by strict mode).
      if (
        req.admin.roleName === "Super Admin" ||
        req.admin.role === "SUPER_ADMIN" ||
        (req.admin.permissions || []).includes("all")
      ) {
        return next();
      }

      // Check admin's permissions array
      const adminPermissions = req.admin.permissions || [];
      const hasPermission = permissions.some((p) =>
        adminPermissions.includes(p),
      );

      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          message: "Insufficient permissions",
        });
      }

      next();
    };
  };

  return { verifyAdminToken, requireRole, requirePermission };
};

export default AdminAuthMiddleware;
