import { Request, Response } from "express";
import TrainingMaterial from "../../models/training-material.model";
import { uploadFileToAws } from "../../utils/s3";

/**
 * Extract YouTube video ID from various URL formats
 */
function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * List training materials (paginated, search, filter)
 */
export const getTrainingMaterials = async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
  const search = (req.query.search as string || "").trim();
  const status = req.query.status as string;
  const type = req.query.type as string;

  const filter: any = {};
  if (status === "active") filter.isActive = true;
  else if (status === "inactive") filter.isActive = false;
  if (type && ["youtube", "video", "image", "document"].includes(type)) {
    filter.type = type;
  }
  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
  }

  const [materials, total] = await Promise.all([
    TrainingMaterial.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    TrainingMaterial.countDocuments(filter),
  ]);

  res.locals.data = {
    materials,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
  };
};

/**
 * Create training material
 * For youtube: extract thumbnail automatically
 * For video/image/document: upload file to S3
 */
export const createTrainingMaterial = async (req: Request, res: Response) => {
  const { title, description, type, url: youtubeUrl, sortOrder } = req.body;
  const adminId = (res as any).locals?.admin?._id || (req as any).adminId;

  let url = "";
  let thumbnailUrl = "";

  if (type === "youtube") {
    url = youtubeUrl;
    const videoId = extractYouTubeId(youtubeUrl);
    if (videoId) {
      thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }
  } else {
    // File upload
    if (!req.file) {
      return res.status(400).json({ success: false, message: "File is required for this content type" });
    }
    const result = await uploadFileToAws([req.file]);
    url = result.images as string;
    // For images, use the uploaded image itself as thumbnail
    if (type === "image") {
      thumbnailUrl = url;
    }
  }

  const material = await TrainingMaterial.create({
    title,
    description: description || "",
    type,
    url,
    thumbnailUrl,
    sortOrder: Number(sortOrder) || 0,
    createdBy: adminId,
  });

  res.locals.data = {
    message: "Training material created",
    material,
  };
};

/**
 * Update training material
 */
export const updateTrainingMaterial = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, description, type, url: youtubeUrl, sortOrder } = req.body;

  const existing = await TrainingMaterial.findById(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Training material not found" });
  }

  const update: any = {};
  if (title !== undefined) update.title = title;
  if (description !== undefined) update.description = description;
  if (sortOrder !== undefined) update.sortOrder = Number(sortOrder) || 0;

  // Handle type change or content update
  if (type !== undefined) update.type = type;

  const effectiveType = type || existing.type;

  if (effectiveType === "youtube" && youtubeUrl) {
    update.url = youtubeUrl;
    const videoId = extractYouTubeId(youtubeUrl);
    if (videoId) {
      update.thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }
  } else if (req.file) {
    const result = await uploadFileToAws([req.file]);
    update.url = result.images as string;
    if (effectiveType === "image") {
      update.thumbnailUrl = update.url;
    }
  }

  const material = await TrainingMaterial.findByIdAndUpdate(id, update, { new: true });

  res.locals.data = {
    message: "Training material updated",
    material,
  };
};

/**
 * Toggle active status
 */
export const toggleTrainingMaterial = async (req: Request, res: Response) => {
  const { id } = req.params;
  const material = await TrainingMaterial.findById(id);
  if (!material) {
    return res.status(404).json({ success: false, message: "Training material not found" });
  }

  material.isActive = !material.isActive;
  await material.save();

  res.locals.data = {
    message: `Training material ${material.isActive ? "activated" : "deactivated"}`,
    material,
  };
};

/**
 * Delete training material
 */
export const deleteTrainingMaterial = async (req: Request, res: Response) => {
  const { id } = req.params;
  const material = await TrainingMaterial.findByIdAndDelete(id);
  if (!material) {
    return res.status(404).json({ success: false, message: "Training material not found" });
  }

  res.locals.data = {
    message: "Training material deleted",
  };
};
