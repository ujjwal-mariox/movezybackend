import mongoose, { Schema, Types } from "mongoose";

/**
 * A training program groups training materials into a structured course with
 * completion rules. Enrollment + progress is tracked per driver in
 * TrainingEnrollment, so the admin "programs" view shows REAL numbers (this
 * replaces the fabricated PROGRAM_SEEDS in the admin UI).
 */
export type ProgramType =
  | "ONBOARDING"
  | "SAFETY"
  | "SKILL_UP"
  | "COMPLIANCE"
  | "OTHER";

export interface ITrainingProgram {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  type: ProgramType;
  materialIds: Types.ObjectId[]; // ordered list of TrainingMaterial refs
  mandatory: boolean;
  passScore: number; // 0-100 (informational until assessments exist)
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TrainingProgramSchema = new Schema<ITrainingProgram>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    type: {
      type: String,
      enum: ["ONBOARDING", "SAFETY", "SKILL_UP", "COMPLIANCE", "OTHER"],
      default: "OTHER",
    },
    materialIds: [{ type: Schema.Types.ObjectId, ref: "TrainingMaterial" }],
    mandatory: { type: Boolean, default: false },
    passScore: { type: Number, min: 0, max: 100, default: 70 },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true },
);

export default mongoose.model<ITrainingProgram>(
  "TrainingProgram",
  TrainingProgramSchema,
);
