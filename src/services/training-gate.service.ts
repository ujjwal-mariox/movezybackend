import { Types } from "mongoose";
import DriverModel from "../models/driver.model";
import TrainingMaterial from "../models/training-material.model";
import TrainingProgram from "../models/training-program.model";

export interface TrainingGateStatus {
  /** Is any training actually required of this driver right now? */
  required: boolean;
  /** Has the driver finished everything required? (true when nothing is required) */
  complete: boolean;
  totalRequired: number;
  completedRequired: number;
}

/**
 * Whether a driver has completed the training they are required to.
 *
 * "Required" is defined by the admin: the union of materials referenced by
 * ACTIVE, MANDATORY TrainingPrograms. This is what finally makes the
 * `TrainingProgram.mandatory` flag mean something — until now it was written by
 * admin and read by nothing.
 *
 * If no active mandatory program exists, training is simply not required and
 * the gate is inert — existing drivers are never suddenly blocked.
 */
export const getTrainingGateStatus = async (
  driverId: string | Types.ObjectId,
): Promise<TrainingGateStatus> => {
  const programs = await TrainingProgram.find({
    isActive: true,
    mandatory: true,
  })
    .select("materialIds")
    .lean();

  const requiredIds = new Set<string>();
  for (const p of programs) {
    for (const m of p.materialIds || []) requiredIds.add(String(m));
  }

  const NONE: TrainingGateStatus = {
    required: false,
    complete: true,
    totalRequired: 0,
    completedRequired: 0,
  };

  if (requiredIds.size === 0) return NONE;

  // A mandatory program can still reference a material that was later
  // deactivated; only count materials the driver can actually open today.
  const activeRequired = await TrainingMaterial.find({
    _id: { $in: [...requiredIds].map((id) => new Types.ObjectId(id)) },
    isActive: true,
  })
    .select("_id")
    .lean();
  const activeRequiredIds = activeRequired.map((m) => String(m._id));

  if (activeRequiredIds.length === 0) return NONE;

  const driver = await DriverModel.findById(driverId)
    .select("completedLessons")
    .lean();

  // completedLessons holds either a plain materialId (current) or the legacy
  // `${materialId}_${materialId}` composite (older app builds). Normalise both
  // so a driver who completed training under either scheme still counts.
  const done = new Set<string>();
  for (const e of driver?.completedLessons || []) {
    const s = String(e);
    done.add(s);
    done.add(s.split("_")[0]);
  }

  const completedRequired = activeRequiredIds.filter((id) =>
    done.has(id),
  ).length;

  return {
    required: true,
    complete: completedRequired >= activeRequiredIds.length,
    totalRequired: activeRequiredIds.length,
    completedRequired,
  };
};

/**
 * Are there any mandatory training materials at all?
 *
 * A cheap fleet-wide pre-check so callers that filter MANY drivers (dispatch)
 * can skip the per-driver work entirely on the common path, where no program has
 * been marked mandatory. Two small indexed reads instead of three per candidate.
 */
export const hasMandatoryTraining = async (): Promise<boolean> => {
  const programs = await TrainingProgram.find({
    isActive: true,
    mandatory: true,
  })
    .select("materialIds")
    .lean();

  const requiredIds = new Set<string>();
  for (const p of programs) {
    for (const m of p.materialIds || []) requiredIds.add(String(m));
  }
  if (requiredIds.size === 0) return false;

  const activeCount = await TrainingMaterial.countDocuments({
    _id: { $in: [...requiredIds].map((id) => new Types.ObjectId(id)) },
    isActive: true,
  });
  return activeCount > 0;
};
