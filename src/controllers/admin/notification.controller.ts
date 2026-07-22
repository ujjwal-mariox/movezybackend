import { Request, Response } from "express";
import { Types } from "mongoose";
import * as NotificationService from "../../services/notification.service";

/**
 * Send broadcast notification (audience: ALL / USERS / DRIVERS / ENTERPRISES)
 */
export const sendBroadcast = async (req: Request, res: Response) => {
  try {
    const { title, body, type, audience, templateId, data } = req.body;
    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: "Title and body are required",
      });
    }

    // No enterprise delivery channel exists. The old code created a campaign,
    // reached nobody, and still marked it SENT — the UI reported success for
    // a message no one received.
    if (audience === "ENTERPRISES") {
      return res.status(400).json({
        success: false,
        message:
          "Enterprise broadcast is not supported yet — no enterprise inbox or push channel exists.",
      });
    }

    // Targeted sends: accept ids in the body, or in the legacy data.driverIds /
    // data.userIds slots (string, comma-separated string, or array).
    const parseIds = (v: any): string[] | undefined => {
      if (!v) return undefined;
      const arr = Array.isArray(v) ? v : String(v).split(",");
      const clean = arr
        .map((x: any) => String(x).trim())
        .filter((x: string) => Types.ObjectId.isValid(x));
      return clean.length ? clean : undefined;
    };
    const driverIds = parseIds(req.body.driverIds) ?? parseIds(data?.driverIds);
    const userIds = parseIds(req.body.userIds) ?? parseIds(data?.userIds);

    const campaign = await NotificationService.sendBroadcast({
      title,
      body,
      type: type || "SYSTEM",
      audience: audience || "ALL",
      templateId: templateId ? new Types.ObjectId(templateId) : undefined,
      data,
      createdBy: req.adminId ? new Types.ObjectId(req.adminId) : undefined,
      driverIds,
      userIds,
    });
    res.json({
      success: true,
      message: "Broadcast dispatched",
      data: campaign,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to send notification",
    });
  }
};

/**
 * Legacy: promotional notification to users
 */
export const sendPromoNotification = async (req: Request, res: Response) => {
  try {
    const { title, body, promoCode, targetAudience } = req.body;
    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: "Title and body are required",
      });
    }
    const result = await NotificationService.sendPromoNotification(
      title,
      body,
      promoCode,
      targetAudience || "ALL",
    );
    res.json({ success: true, message: "Notification sent", data: result });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to send notification",
    });
  }
};

export const cleanupNotifications = async (req: Request, res: Response) => {
  try {
    const { daysOld = 30 } = req.body;
    const deletedCount = await NotificationService.deleteOldNotifications(Number(daysOld));
    res.json({
      success: true,
      message: `Deleted ${deletedCount} old notifications`,
      data: { deletedCount },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to cleanup notifications",
    });
  }
};

/* ===== Templates ===== */

export const listTemplates = async (req: Request, res: Response) => {
  try {
    const { type, audience, isActive, search } = req.query;
    const templates = await NotificationService.listTemplates({
      type: type as string,
      audience: audience as any,
      isActive: typeof isActive === "string" ? isActive === "true" : undefined,
      search: search as string,
    });
    res.json({ success: true, data: { templates } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const createTemplate = async (req: Request, res: Response) => {
  try {
    const template = await NotificationService.createTemplate(req.body);
    res.json({ success: true, data: { template } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateTemplate = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const template = await NotificationService.updateTemplate(id, req.body);
    if (!template) {
      return res.status(404).json({ success: false, message: "Template not found" });
    }
    res.json({ success: true, data: { template } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteTemplate = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await NotificationService.deleteTemplate(id);
    res.json({ success: true, message: "Template deleted" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ===== History / Analytics ===== */

export const listHistory = async (req: Request, res: Response) => {
  try {
    const { audience, type, status, search, dateFrom, dateTo, page = 0, limit = 20 } = req.query;
    const result = await NotificationService.listCampaigns({
      audience: audience as any,
      type: type as string,
      status: status as string,
      search: search as string,
      dateFrom: dateFrom ? new Date(dateFrom as string) : undefined,
      dateTo: dateTo ? new Date(dateTo as string) : undefined,
      page: Number(page),
      limit: Number(limit),
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getAnalytics = async (req: Request, res: Response) => {
  try {
    const analytics = await NotificationService.getNotificationAnalytics();
    res.json({ success: true, data: analytics });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
