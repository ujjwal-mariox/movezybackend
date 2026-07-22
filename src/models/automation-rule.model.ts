import mongoose, { Schema, Types } from "mongoose";

export interface IAutomationRule {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  isActive: boolean;
  trigger: {
    type: string;
    metric: string;
    operator: "gt" | "lt" | "gte" | "lte" | "eq";
    threshold: number;
    timeWindowDays?: number;
    consecutiveCount?: number;
  };
  action: {
    type: string;
    params?: Record<string, any>;
  };
  /**
   * Minimum gap before this rule may act on the SAME target again.
   *
   * Without it a standing condition ("driver idle > 7 min") re-fired on every
   * sweep: one driver collected 116 identical nudges, over half of every
   * notification in the system. 720 = at most twice a day per driver.
   */
  cooldownMinutes: number;
  lastTriggeredAt?: Date;
  triggerCount: number;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const AutomationRuleSchema = new Schema<IAutomationRule>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    trigger: {
      type: {
        type: String,
        required: true,
        enum: [
          "cancellation_rate",
          "cod_collection_delay",
          "low_rating_consecutive",
          "driver_idle",
          "order_spike",
          "sos_spike",
          "revenue_drop",
          "custom",
        ],
      },
      metric: { type: String, required: true },
      operator: {
        type: String,
        required: true,
        enum: ["gt", "lt", "gte", "lte", "eq"],
      },
      threshold: { type: Number, required: true },
      timeWindowDays: { type: Number, default: 7 },
      consecutiveCount: Number,
    },
    action: {
      type: {
        type: String,
        required: true,
        enum: [
          "flag_driver",
          "warn_driver",
          "suspend_driver",
          "send_push_notification",
          "send_email",
          "escalate_to_admin",
          "create_ticket",
          "block_user",
          "custom",
        ],
      },
      params: Schema.Types.Mixed,
    },
    cooldownMinutes: { type: Number, default: 720 },
    lastTriggeredAt: Date,
    triggerCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true },
);

AutomationRuleSchema.index({ isActive: 1 });
AutomationRuleSchema.index({ "trigger.type": 1 });

export const AutomationRule = mongoose.model<IAutomationRule>(
  "AutomationRule",
  AutomationRuleSchema,
);
export default AutomationRule;
