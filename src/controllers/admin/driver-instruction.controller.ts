import { Request, Response } from "express";
import DriverInstruction from "../../models/driver-instruction.model";

export const getDriverInstructions = async (req: Request, res: Response) => {
  const { page = 1, limit = 20, search, status } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = {};
  if (search) {
    filter.text = { $regex: search, $options: "i" };
  }
  if (status === "active") filter.isActive = true;
  else if (status === "inactive") filter.isActive = false;

  const [instructions, total] = await Promise.all([
    DriverInstruction.find(filter)
      .sort({ sortOrder: 1 })
      .skip(skip)
      .limit(limitNum),
    DriverInstruction.countDocuments(filter),
  ]);

  res.locals.data = {
    instructions,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

export const createDriverInstruction = async (req: Request, res: Response) => {
  const { text, icon, sortOrder } = req.body;
  if (!text) {
    res.status(400);
    throw new Error("text is required");
  }

  const instruction = await DriverInstruction.create({
    text,
    icon: icon || "📋",
    sortOrder: sortOrder ?? 0,
    createdBy: (req as any).adminId,
  });

  res.locals.data = { message: "Driver instruction created", instruction };
};

export const updateDriverInstruction = async (req: Request, res: Response) => {
  const { id } = req.params;
  const instruction = await DriverInstruction.findByIdAndUpdate(
    id,
    req.body,
    { new: true },
  );
  if (!instruction) {
    res.status(404);
    throw new Error("Driver instruction not found");
  }
  res.locals.data = { message: "Driver instruction updated", instruction };
};

export const toggleDriverInstruction = async (req: Request, res: Response) => {
  const { id } = req.params;
  const instruction = await DriverInstruction.findById(id);
  if (!instruction) {
    res.status(404);
    throw new Error("Driver instruction not found");
  }
  instruction.isActive = !instruction.isActive;
  await instruction.save();
  res.locals.data = {
    message: `Instruction ${instruction.isActive ? "activated" : "deactivated"}`,
    instruction,
  };
};

export const deleteDriverInstruction = async (req: Request, res: Response) => {
  const { id } = req.params;
  const instruction = await DriverInstruction.findByIdAndDelete(id);
  if (!instruction) {
    res.status(404);
    throw new Error("Driver instruction not found");
  }
  res.locals.data = { message: "Driver instruction deleted" };
};
