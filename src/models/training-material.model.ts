import { Schema, model, Types } from "mongoose";

export interface ITrainingMaterial {
  _id: Types.ObjectId;
  title: string;
  description: string;
  type: "youtube" | "video" | "image" | "document";
  /** YouTube URL or uploaded file URL (S3) */
  url: string;
  /** Auto-extracted YouTube thumbnail or uploaded image thumbnail */
  thumbnailUrl: string;
  sortOrder: number;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const trainingMaterialSchema = new Schema<ITrainingMaterial>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    type: {
      type: String,
      required: true,
      enum: ["youtube", "video", "image", "document"],
    },
    url: { type: String, required: true },
    thumbnailUrl: { type: String, default: "" },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true },
);

trainingMaterialSchema.index({ isActive: 1, sortOrder: 1 });

const TrainingMaterial = model<ITrainingMaterial>(
  "TrainingMaterial",
  trainingMaterialSchema,
);

export default TrainingMaterial;
