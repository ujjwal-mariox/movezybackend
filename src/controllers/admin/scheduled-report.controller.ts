import { Request, Response } from "express";
import ScheduledReport from "../../models/scheduled-report.model";
import {
  computeNextRun,
  runSchedule,
} from "../../services/scheduled-report.service";

// GET /admin/reports/schedules
export const listSchedules = async (_req: Request, res: Response) => {
  const schedules = await ScheduledReport.find()
    .sort({ createdAt: -1 })
    .lean();
  res.locals.data = { schedules };
};

// POST /admin/reports/schedules
export const createSchedule = async (req: Request, res: Response) => {
  const {
    name,
    template,
    frequency,
    dayOfWeek,
    dayOfMonth,
    hour,
    recipients,
    isActive,
  } = req.body;

  if (!name || !template || !frequency) {
    return res.status(400).json({
      success: false,
      message: "name, template and frequency are required",
    });
  }
  const list = Array.isArray(recipients)
    ? recipients
    : String(recipients || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  if (list.length === 0) {
    return res
      .status(400)
      .json({ success: false, message: "At least one recipient email is required" });
  }

  const h = Number(hour) || 8;
  const nextRunAt = computeNextRun(new Date(), frequency, {
    dayOfWeek: dayOfWeek !== undefined ? Number(dayOfWeek) : undefined,
    dayOfMonth: dayOfMonth !== undefined ? Number(dayOfMonth) : undefined,
    hour: h,
  });

  const schedule = await ScheduledReport.create({
    name,
    template,
    frequency,
    dayOfWeek: dayOfWeek !== undefined ? Number(dayOfWeek) : undefined,
    dayOfMonth: dayOfMonth !== undefined ? Number(dayOfMonth) : undefined,
    hour: h,
    recipients: list,
    isActive: isActive !== false,
    nextRunAt,
    createdBy: (req as any).adminId,
  });

  res.locals.data = { schedule };
};

// PUT /admin/reports/schedules/:id
export const updateSchedule = async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await ScheduledReport.findById(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Schedule not found" });
  }

  const {
    name,
    template,
    frequency,
    dayOfWeek,
    dayOfMonth,
    hour,
    recipients,
    isActive,
  } = req.body;

  if (name !== undefined) existing.name = name;
  if (template !== undefined) existing.template = template;
  if (frequency !== undefined) existing.frequency = frequency;
  if (dayOfWeek !== undefined) existing.dayOfWeek = Number(dayOfWeek);
  if (dayOfMonth !== undefined) existing.dayOfMonth = Number(dayOfMonth);
  if (hour !== undefined) existing.hour = Number(hour);
  if (recipients !== undefined) {
    existing.recipients = Array.isArray(recipients)
      ? recipients
      : String(recipients)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  }
  if (isActive !== undefined) existing.isActive = isActive;

  // Recompute next run when timing changed.
  existing.nextRunAt = computeNextRun(new Date(), existing.frequency, {
    dayOfWeek: existing.dayOfWeek,
    dayOfMonth: existing.dayOfMonth,
    hour: existing.hour,
  });
  await existing.save();

  res.locals.data = { schedule: existing };
};

// DELETE /admin/reports/schedules/:id
export const deleteSchedule = async (req: Request, res: Response) => {
  const { id } = req.params;
  const deleted = await ScheduledReport.findByIdAndDelete(id);
  if (!deleted) {
    return res.status(404).json({ success: false, message: "Schedule not found" });
  }
  res.locals.data = { message: "Schedule deleted" };
};

// POST /admin/reports/schedules/:id/run — generate + send now
export const runScheduleNow = async (req: Request, res: Response) => {
  const { id } = req.params;
  const schedule = await ScheduledReport.findById(id);
  if (!schedule) {
    return res.status(404).json({ success: false, message: "Schedule not found" });
  }
  const status = await runSchedule(schedule);
  res.locals.data = {
    message:
      status === "SENT"
        ? "Report generated and emailed"
        : status === "LOGGED"
          ? "Report generated (email not configured — logged instead)"
          : "Report run failed",
    status,
  };
};
