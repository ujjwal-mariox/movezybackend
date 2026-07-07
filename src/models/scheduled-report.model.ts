import mongoose, { Schema, Types } from "mongoose";

export type ReportFrequency = "daily" | "weekly" | "monthly";

// Templates a schedule can produce. Must stay in sync with the report generator.
export type ReportTemplate =
  | "daily_ops"
  | "weekly_fin"
  | "driver_perf"
  | "enterprise"
  | "compliance";

export interface IScheduledReport {
  _id: Types.ObjectId;
  name: string;
  template: ReportTemplate;
  frequency: ReportFrequency;
  // For weekly: 0-6 (Mon=0). For monthly: day-of-month 1-28. Ignored for daily.
  dayOfWeek?: number;
  dayOfMonth?: number;
  hour: number; // 0-23, local server time
  recipients: string[]; // email addresses
  isActive: boolean;
  lastRunAt?: Date;
  nextRunAt: Date;
  lastStatus?: "SENT" | "LOGGED" | "FAILED";
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ScheduledReportSchema = new Schema<IScheduledReport>(
  {
    name: { type: String, required: true, trim: true },
    template: {
      type: String,
      enum: ["daily_ops", "weekly_fin", "driver_perf", "enterprise", "compliance"],
      required: true,
    },
    frequency: {
      type: String,
      enum: ["daily", "weekly", "monthly"],
      required: true,
    },
    dayOfWeek: { type: Number, min: 0, max: 6 },
    dayOfMonth: { type: Number, min: 1, max: 28 },
    hour: { type: Number, min: 0, max: 23, default: 8 },
    recipients: {
      type: [String],
      required: true,
      validate: {
        validator: (v: string[]) => Array.isArray(v) && v.length > 0,
        message: "At least one recipient is required",
      },
    },
    isActive: { type: Boolean, default: true, index: true },
    lastRunAt: Date,
    nextRunAt: { type: Date, required: true, index: true },
    lastStatus: { type: String, enum: ["SENT", "LOGGED", "FAILED"] },
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true },
);

export default mongoose.model<IScheduledReport>(
  "ScheduledReport",
  ScheduledReportSchema,
);
