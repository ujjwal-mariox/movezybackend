import { Request, Response } from "express";
import { Types } from "mongoose";
import TrainingProgram from "../../models/training-program.model";
import TrainingEnrollment from "../../models/training-enrollment.model";

/**
 * Attach real enrollment stats to a set of programs (enrolled / completed /
 * completionRate), computed from TrainingEnrollment.
 */
const attachStats = async (programs: any[]) => {
  const ids = programs.map((p) => p._id);
  if (ids.length === 0) return programs;

  const stats = await TrainingEnrollment.aggregate([
    { $match: { programId: { $in: ids } } },
    {
      $group: {
        _id: "$programId",
        enrolled: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
        },
      },
    },
  ]);
  const byId = new Map(stats.map((s: any) => [String(s._id), s]));

  return programs.map((p) => {
    const s = byId.get(String(p._id)) || { enrolled: 0, completed: 0 };
    const completionRate =
      s.enrolled > 0 ? Math.round((s.completed / s.enrolled) * 100) : 0;
    return { ...p, enrolled: s.enrolled, completed: s.completed, completionRate };
  });
};

// GET /admin/training/programs
export const listPrograms = async (_req: Request, res: Response) => {
  const programs = await TrainingProgram.find()
    .sort({ createdAt: -1 })
    .populate("materialIds", "title type")
    .lean();
  const withStats = await attachStats(programs);

  // Overview aggregates for the KPI strip.
  const totalPrograms = withStats.length;
  const totalEnrolled = withStats.reduce((a, p: any) => a + p.enrolled, 0);
  const totalCompleted = withStats.reduce((a, p: any) => a + p.completed, 0);
  const avgCompletion =
    totalPrograms > 0
      ? Math.round(
          withStats.reduce((a, p: any) => a + p.completionRate, 0) /
            totalPrograms,
        )
      : 0;

  res.locals.data = {
    programs: withStats,
    overview: { totalPrograms, totalEnrolled, totalCompleted, avgCompletion },
  };
};

// POST /admin/training/programs
export const createProgram = async (req: Request, res: Response) => {
  const { title, description, type, materialIds, mandatory, passScore, isActive } =
    req.body;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: "Title is required" });
  }

  const program = await TrainingProgram.create({
    title,
    description,
    type: type || "OTHER",
    materialIds: Array.isArray(materialIds)
      ? materialIds.map((id: string) => new Types.ObjectId(id))
      : [],
    mandatory: mandatory === true,
    passScore: Number(passScore) || 70,
    isActive: isActive !== false,
    createdBy: (req as any).adminId,
  });

  res.locals.data = { program };
};

// PUT /admin/training/programs/:id
export const updateProgram = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, description, type, materialIds, mandatory, passScore, isActive } =
    req.body;

  const update: any = {};
  if (title !== undefined) update.title = title;
  if (description !== undefined) update.description = description;
  if (type !== undefined) update.type = type;
  if (materialIds !== undefined)
    update.materialIds = (materialIds as string[]).map(
      (i) => new Types.ObjectId(i),
    );
  if (mandatory !== undefined) update.mandatory = mandatory;
  if (passScore !== undefined) update.passScore = Number(passScore);
  if (isActive !== undefined) update.isActive = isActive;

  const program = await TrainingProgram.findByIdAndUpdate(id, update, {
    new: true,
  });
  if (!program) {
    return res.status(404).json({ success: false, message: "Program not found" });
  }
  res.locals.data = { program };
};

// DELETE /admin/training/programs/:id
export const deleteProgram = async (req: Request, res: Response) => {
  const { id } = req.params;
  const program = await TrainingProgram.findByIdAndDelete(id);
  if (!program) {
    return res.status(404).json({ success: false, message: "Program not found" });
  }
  // Clean up enrollments for the removed program.
  await TrainingEnrollment.deleteMany({ programId: id });
  res.locals.data = { message: "Program deleted" };
};

// PUT /admin/training/programs/:id/toggle
export const toggleProgram = async (req: Request, res: Response) => {
  const { id } = req.params;
  const program = await TrainingProgram.findById(id);
  if (!program) {
    return res.status(404).json({ success: false, message: "Program not found" });
  }
  program.isActive = !program.isActive;
  await program.save();
  res.locals.data = { program };
};

// GET /admin/training/programs/:id/enrollments
export const getProgramEnrollments = async (req: Request, res: Response) => {
  const { id } = req.params;
  const enrollments = await TrainingEnrollment.find({ programId: id })
    .populate("driverId", "fullName mobileNumber")
    .sort({ enrolledAt: -1 })
    .lean();
  res.locals.data = { enrollments };
};
