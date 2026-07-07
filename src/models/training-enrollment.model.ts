import mongoose, { Schema, Types } from "mongoose";

/**
 * Per-driver enrollment + progress in a training program. Drives the REAL
 * enrolled/completed/completion-rate numbers shown in the admin programs view.
 */
export type EnrollmentStatus = "ENROLLED" | "IN_PROGRESS" | "COMPLETED";

export interface ITrainingEnrollment {
  _id: Types.ObjectId;
  programId: Types.ObjectId;
  driverId: Types.ObjectId;
  status: EnrollmentStatus;
  progress: number; // 0-100
  completedMaterialIds: Types.ObjectId[];
  enrolledAt: Date;
  completedAt?: Date;
}

const TrainingEnrollmentSchema = new Schema<ITrainingEnrollment>(
  {
    programId: {
      type: Schema.Types.ObjectId,
      ref: "TrainingProgram",
      required: true,
      index: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["ENROLLED", "IN_PROGRESS", "COMPLETED"],
      default: "ENROLLED",
      index: true,
    },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    completedMaterialIds: [
      { type: Schema.Types.ObjectId, ref: "TrainingMaterial" },
    ],
    enrolledAt: { type: Date, default: Date.now },
    completedAt: Date,
  },
  { timestamps: true },
);

// One enrollment per driver per program.
TrainingEnrollmentSchema.index({ programId: 1, driverId: 1 }, { unique: true });

export default mongoose.model<ITrainingEnrollment>(
  "TrainingEnrollment",
  TrainingEnrollmentSchema,
);
