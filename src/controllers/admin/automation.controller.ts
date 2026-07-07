import { Request, Response } from "express";
import { AutomationRule } from "../../models/automation-rule.model";
import { runAllRules } from "../../services/automation-engine.service";

// POST /admin/automation/run — evaluate all active rules now (manual trigger)
export const runRulesNow = async (_req: Request, res: Response) => {
  const result = await runAllRules();
  res.json({
    success: true,
    message: `Evaluated ${result.evaluated} rule(s), fired ${result.fired} action(s)`,
    data: result,
  });
};

// GET /admin/automation/rules
export const getAllRules = async (req: Request, res: Response) => {
  const { page = 1, limit = 50, isActive, triggerType } = req.query;

  const filter: any = {};
  if (isActive !== undefined) filter.isActive = isActive === "true";
  if (triggerType) filter["trigger.type"] = triggerType;

  const skip = (Number(page) - 1) * Number(limit);
  const [rules, total] = await Promise.all([
    AutomationRule.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate("createdBy", "fullName email")
      .lean(),
    AutomationRule.countDocuments(filter),
  ]);

  res.locals.data = {
    rules,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

// GET /admin/automation/rules/:id
export const getRuleById = async (req: Request, res: Response) => {
  const rule = await AutomationRule.findById(req.params.id)
    .populate("createdBy", "fullName email")
    .lean();

  if (!rule) {
    return res.status(404).json({ success: false, message: "Rule not found" });
  }

  res.locals.data = rule;
};

// POST /admin/automation/rules
export const createRule = async (req: Request, res: Response) => {
  const { name, description, trigger, action, isActive } = req.body;

  const rule = await AutomationRule.create({
    name,
    description,
    trigger,
    action,
    isActive: isActive !== false,
    createdBy: req.adminId,
  });

  res.locals.data = rule;
};

// PUT /admin/automation/rules/:id
export const updateRule = async (req: Request, res: Response) => {
  const { name, description, trigger, action, isActive } = req.body;

  const rule = await AutomationRule.findByIdAndUpdate(
    req.params.id,
    {
      name,
      description,
      trigger,
      action,
      isActive,
      updatedBy: req.adminId,
    },
    { new: true },
  );

  if (!rule) {
    return res.status(404).json({ success: false, message: "Rule not found" });
  }

  res.locals.data = rule;
};

// DELETE /admin/automation/rules/:id
export const deleteRule = async (req: Request, res: Response) => {
  const rule = await AutomationRule.findByIdAndDelete(req.params.id);
  if (!rule) {
    return res.status(404).json({ success: false, message: "Rule not found" });
  }
  res.locals.data = { message: "Rule deleted successfully" };
};

// PUT /admin/automation/rules/:id/toggle
export const toggleRule = async (req: Request, res: Response) => {
  const rule = await AutomationRule.findById(req.params.id);
  if (!rule) {
    return res.status(404).json({ success: false, message: "Rule not found" });
  }

  rule.isActive = !rule.isActive;
  rule.updatedBy = req.adminId as any;
  await rule.save();

  res.locals.data = rule;
};

// GET /admin/automation/trigger-types
export const getTriggerTypes = async (_req: Request, res: Response) => {
  res.locals.data = [
    {
      type: "cancellation_rate",
      label: "Cancellation Rate",
      description: "Driver cancellation rate exceeds threshold",
      defaultMetric: "cancellation_rate_percent",
      defaultOperator: "gt",
      defaultThreshold: 30,
      defaultTimeWindowDays: 7,
    },
    {
      type: "cod_collection_delay",
      label: "COD Collection Delay",
      description: "Cash on delivery collection delayed beyond threshold",
      defaultMetric: "cod_delay_hours",
      defaultOperator: "gt",
      defaultThreshold: 48,
    },
    {
      type: "low_rating_consecutive",
      label: "Low Rating (Consecutive)",
      description: "Customer rating below threshold for consecutive rides",
      defaultMetric: "rating",
      defaultOperator: "lt",
      defaultThreshold: 3,
      defaultConsecutiveCount: 5,
    },
    {
      type: "driver_idle",
      label: "Driver Idle",
      description: "Driver idle for specified days while marked online",
      defaultMetric: "idle_days",
      defaultOperator: "gt",
      defaultThreshold: 7,
    },
    {
      type: "order_spike",
      label: "Order Spike Detection",
      description: "Unusual spike in orders within time window",
      defaultMetric: "order_count_change_percent",
      defaultOperator: "gt",
      defaultThreshold: 150,
      defaultTimeWindowDays: 1,
    },
    {
      type: "sos_spike",
      label: "SOS Spike",
      description: "Unusual increase in SOS alerts",
      defaultMetric: "sos_count",
      defaultOperator: "gt",
      defaultThreshold: 5,
      defaultTimeWindowDays: 1,
    },
    {
      type: "revenue_drop",
      label: "Revenue Drop",
      description: "Revenue drops below threshold",
      defaultMetric: "revenue_change_percent",
      defaultOperator: "lt",
      defaultThreshold: -20,
      defaultTimeWindowDays: 7,
    },
  ];
};

// GET /admin/automation/action-types
export const getActionTypes = async (_req: Request, res: Response) => {
  res.locals.data = [
    { type: "flag_driver", label: "Flag Driver", description: "Add warning flag to driver profile" },
    { type: "warn_driver", label: "Warn Driver", description: "Send warning notification to driver" },
    { type: "suspend_driver", label: "Suspend Driver", description: "Automatically suspend driver" },
    { type: "send_push_notification", label: "Send Push Notification", description: "Send push notification to target" },
    { type: "send_email", label: "Send Email", description: "Send email alert" },
    { type: "escalate_to_admin", label: "Escalate to Admin", description: "Create admin alert for manual review" },
    { type: "create_ticket", label: "Create Support Ticket", description: "Auto-create support ticket" },
    { type: "block_user", label: "Block User", description: "Automatically block user account" },
  ];
};
