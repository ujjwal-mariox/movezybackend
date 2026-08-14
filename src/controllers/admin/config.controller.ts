import { Request, Response } from "express";
import {
  FareConfig,
  AppConfig,
  ServiceArea,
} from "../../models/app-config.model";
import VehicleType from "../../models/vehicle-type.model";
import VehicleCategory from "../../models/vehicle-category.model";
import ServiceType from "../../models/service-type.model";
import AddonService from "../../models/addon-service.model";
import CancellationReason from "../../models/cancellation-reason.model";
import ProhibitedItem from "../../models/prohibited-item.model";
import { TimeSlot, ScheduleConfig } from "../../models/time-slot.model";
import GoodsType from "../../models/goods-type.model";
import { City, BodyType, FuelType } from "../../models/master-data.model";
import { uploadFileToAws } from "../../utils/s3";
import { cache } from "../../utils/redis.util";
import { auditFromRequest, diffFields } from "./audit-log.controller";

/**
 * Coerce string booleans/numbers from multipart form-data into real types.
 * When multer parses form-data, every value arrives as a string.
 */
function coerceVehicleTypeFields(data: Record<string, any>) {
  const boolFields = [
    "isActive",
    "isDeleted",
    "allowIntraCity",
    "allowInterCity",
    "showOnHomeScreen",
  ];
  const numFields = [
    "maxWeightKg",
    "baseFare",
    "perKmRate",
    "perMinuteRate",
    "minDistanceKm",
    "surgeMultiplier",
    "cancellationFee",
    "minRangeKm",
    "maxRangeKm",
    "sortOrder",
  ];
  for (const key of boolFields) {
    if (key in data && typeof data[key] === "string") {
      data[key] = data[key] === "true";
    }
  }
  for (const key of numFields) {
    if (key in data && typeof data[key] === "string") {
      data[key] = Number(data[key]);
    }
  }
  return data;
}

// ============ FARE CONFIG ============

/**
 * Get fare configuration
 */
export const getFareConfig = async (req: Request, res: Response) => {
  let config = await FareConfig.findOne({ isActive: true });

  if (!config) {
    // Create default config
    config = await FareConfig.create({
      name: "default",
      gstPercentage: 5,
      minimumFare: 50,
    });
  }

  res.locals.data = { config };
};

/**
 * Update fare configuration
 */
export const updateFareConfig = async (req: Request, res: Response) => {
  const updateData = req.body;

  // Read the live config BEFORE writing, so the audit row can carry the value
  // that was replaced. Changing driver commission or GST left no record at all
  // of who changed it or what it was.
  const previous = await FareConfig.findOne({ isActive: true }).lean();

  const config = await FareConfig.findOneAndUpdate(
    { isActive: true },
    updateData,
    { new: true, upsert: true, runValidators: true },
  );

  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "settings",
    targetId: String(config?._id || ""),
    targetType: "FareConfig",
    description: "Updated fare configuration",
    changes: diffFields(previous as any, updateData),
  });

  res.locals.data = {
    message: "Fare configuration updated",
    config,
  };
};

// ============ VEHICLE TYPES ============

/**
 * Get all vehicle types
 */
export const getVehicleTypes = async (req: Request, res: Response) => {
  const { page = 1, limit = 20, search, status } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = {};
  if (search) {
    filter.name = { $regex: search, $options: "i" };
  }
  if (status === "active") { filter.isActive = true; filter.isDeleted = { $ne: true }; }
  else if (status === "inactive") { filter.isActive = false; filter.isDeleted = { $ne: true }; }
  else if (status === "deleted") { filter.isDeleted = true; }

  const [vehicleTypes, total] = await Promise.all([
    VehicleType.find(filter).sort({ sortOrder: 1, name: 1 }).skip(skip).limit(limitNum),
    VehicleType.countDocuments(filter),
  ]);

  res.locals.data = {
    vehicleTypes,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  };
};

/**
 * Create vehicle type (with optional image upload)
 */
export const createVehicleType = async (req: Request, res: Response) => {
  const data = coerceVehicleTypeFields({ ...req.body });

  // Handle image file upload
  if (req.file) {
    const result = await uploadFileToAws([req.file]);
    data.image = result.images;
  }

  const vehicleType = await VehicleType.create(data);

  await auditFromRequest(req, {
    action: "CREATE",
    module: "vehicles",
    targetId: String(vehicleType._id),
    targetType: "VehicleType",
    description: `Created vehicle type "${vehicleType.name}"`,
    after: { ...data },
  });

  res.locals.data = {
    message: "Vehicle type created",
    vehicleType,
  };
};

/**
 * Update vehicle type (with optional image upload)
 */
export const updateVehicleType = async (req: Request, res: Response) => {
  const { id } = req.params;
  const data = coerceVehicleTypeFields({ ...req.body });

  // Handle image file upload
  if (req.file) {
    const result = await uploadFileToAws([req.file]);
    data.image = result.images;
  }

  // Captured before the write so the audit row shows what the fare-affecting
  // fields (baseFare, perKmRate, …) used to be.
  const previous = await VehicleType.findById(id).lean();

  const vehicleType = await VehicleType.findByIdAndUpdate(id, data, {
    new: true,
  });

  if (!vehicleType) {
    return res.status(404).json({
      success: false,
      message: "Vehicle type not found",
    });
  }

  await auditFromRequest(req, {
    action: "UPDATE",
    module: "vehicles",
    targetId: String(vehicleType._id),
    targetType: "VehicleType",
    description: `Updated vehicle type "${vehicleType.name}"`,
    changes: diffFields(previous as any, data),
  });

  res.locals.data = {
    message: "Vehicle type updated",
    vehicleType,
  };
};

/**
 * Toggle vehicle type active status
 */
export const toggleVehicleType = async (req: Request, res: Response) => {
  const { id } = req.params;

  const vehicleType = await VehicleType.findById(id);

  if (!vehicleType) {
    return res.status(404).json({
      success: false,
      message: "Vehicle type not found",
    });
  }

  vehicleType.isActive = !vehicleType.isActive;
  await vehicleType.save();

  await auditFromRequest(req, {
    action: "CHANGE_STATUS",
    module: "vehicles",
    targetId: String(vehicleType._id),
    targetType: "VehicleType",
    description: `${vehicleType.isActive ? "Activated" : "Deactivated"} vehicle type "${vehicleType.name}"`,
    changes: [
      {
        field: "isActive",
        oldValue: !vehicleType.isActive,
        newValue: vehicleType.isActive,
      },
    ],
  });

  res.locals.data = {
    message: `Vehicle type ${vehicleType.isActive ? "activated" : "deactivated"}`,
    vehicleType,
  };
};

/**
 * Soft delete vehicle type
 */
export const deleteVehicleType = async (req: Request, res: Response) => {
  const { id } = req.params;

  const vehicleType = await VehicleType.findByIdAndUpdate(
    id,
    { isDeleted: true, isActive: false },
    { new: true, runValidators: true },
  );

  if (!vehicleType) {
    return res.status(404).json({
      success: false,
      message: "Vehicle type not found",
    });
  }

  await auditFromRequest(req, {
    action: "DELETE",
    module: "vehicles",
    targetId: String(vehicleType._id),
    targetType: "VehicleType",
    description: `Deleted vehicle type "${vehicleType.name}"`,
  });

  res.locals.data = {
    message: "Vehicle type deleted",
    vehicleType,
  };
};

/**
 * Restore deleted vehicle type
 */
export const restoreVehicleType = async (req: Request, res: Response) => {
  const { id } = req.params;

  const vehicleType = await VehicleType.findByIdAndUpdate(
    id,
    { isDeleted: false },
    { new: true, runValidators: true },
  );

  if (!vehicleType) {
    return res.status(404).json({
      success: false,
      message: "Vehicle type not found",
    });
  }

  await auditFromRequest(req, {
    action: "UPDATE",
    module: "vehicles",
    targetId: String(vehicleType._id),
    targetType: "VehicleType",
    description: `Restored vehicle type "${vehicleType.name}"`,
  });

  res.locals.data = {
    message: "Vehicle type restored",
    vehicleType,
  };
};

// ============ SERVICE TYPES ============

/**
 * Get service types
 */
export const getServiceTypes = async (req: Request, res: Response) => {
  const serviceTypes = await ServiceType.find({ isActive: true }).sort({
    sortOrder: 1,
  });

  res.locals.data = { serviceTypes };
};

/**
 * Create/Update service type
 */
export const upsertServiceType = async (req: Request, res: Response) => {
  const { code, ...data } = req.body;

  const serviceType = await ServiceType.findOneAndUpdate(
    { code },
    { code, ...data },
    { new: true, upsert: true },
  );

  res.locals.data = {
    message: "Service type saved",
    serviceType,
  };
};

// ============ ADDON SERVICES ============

/**
 * Get addon services
 */
export const getAddonServices = async (req: Request, res: Response) => {
  const { page = 1, limit = 20, search, status } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = {};
  if (search) {
    filter.name = { $regex: search, $options: "i" };
  }
  if (status === "active") filter.isActive = true;
  else if (status === "inactive") filter.isActive = false;

  const [addonServices, total] = await Promise.all([
    AddonService.find(filter)
      .populate("applicableVehicleTypes", "name")
      .sort({ sortOrder: 1 })
      .skip(skip)
      .limit(limitNum),
    AddonService.countDocuments(filter),
  ]);

  res.locals.data = {
    addonServices,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  };
};

/**
 * Create addon service
 */
export const createAddonService = async (req: Request, res: Response) => {
  // `req.body` is untyped, so Model.create resolves to its array overload —
  // annotate the single document we actually get back.
  const addon: any = await AddonService.create(req.body);
  await cache.del("addons:active");

  await auditFromRequest(req, {
    action: "CREATE",
    module: "settings",
    targetId: String(addon._id),
    targetType: "AddonService",
    description: `Created add-on "${addon.name}" at ${addon.price} (${addon.priceType})`,
    after: { name: addon.name, price: addon.price, priceType: addon.priceType },
  });

  res.locals.data = {
    message: "Addon service created",
    addon,
  };
};

/**
 * Update addon service
 */
export const updateAddonService = async (req: Request, res: Response) => {
  const { id } = req.params;

  // An add-on's price and priceType are billed on every booking that uses it,
  // so the previous values have to be on record.
  const previous = await AddonService.findById(id).lean();

  const addon = await AddonService.findByIdAndUpdate(id, req.body, {
    new: true,
  });
  await cache.del("addons:active");

  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "settings",
    targetId: String(id),
    targetType: "AddonService",
    description: `Updated add-on "${addon?.name ?? id}"`,
    changes: diffFields(previous as any, req.body),
  });

  res.locals.data = {
    message: "Addon service updated",
    addon,
  };
};

// ============ CANCELLATION REASONS ============

/**
 * Get all cancellation reasons (including inactive, for admin)
 */
export const getCancellationReasons = async (req: Request, res: Response) => {
  const { activeOnly, applicableTo, page = 1, limit = 20, search } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = activeOnly === "true" ? { isActive: true } : {};
  if (applicableTo && applicableTo !== "all") filter.applicableTo = applicableTo;
  if (search) {
    filter.$or = [
      { reason: { $regex: search, $options: "i" } },
      { code: { $regex: search, $options: "i" } },
    ];
  }

  const [reasons, total] = await Promise.all([
    CancellationReason.find(filter).sort({ sortOrder: 1 }).skip(skip).limit(limitNum),
    CancellationReason.countDocuments(filter),
  ]);

  res.locals.data = {
    reasons,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  };
};

/**
 * Create a new cancellation reason
 */
export const createCancellationReason = async (req: Request, res: Response) => {
  const { reason, code, applicableTo, penaltyType, penaltyValue, isRefundable, refundPercentage, sortOrder } = req.body;

  if (!reason || !code) {
    res.status(400);
    throw new Error("reason and code are required");
  }

  const existing = await CancellationReason.findOne({ code: code.toUpperCase() });
  if (existing) {
    res.status(409);
    throw new Error(`Cancellation reason with code '${code}' already exists`);
  }

  const newReason = await CancellationReason.create({
    reason,
    code: code.toUpperCase(),
    applicableTo: applicableTo || "BOTH",
    penaltyType: penaltyType || "NONE",
    penaltyValue: penaltyValue || 0,
    isRefundable: isRefundable !== false,
    refundPercentage: refundPercentage ?? 100,
    sortOrder: sortOrder ?? 0,
  });

  await auditFromRequest(req, {
    action: "CREATE",
    module: "settings",
    targetId: String(newReason._id),
    targetType: "CancellationReason",
    description: `Created cancellation reason ${newReason.code} — refunds ${newReason.refundPercentage}%`,
    after: newReason.toObject(),
  });

  res.locals.data = {
    message: "Cancellation reason created",
    reason: newReason,
  };

  // Invalidate user-facing cache
  await cache.del("cancellationReasons:user");
};

/**
 * Update an existing cancellation reason
 */
export const updateCancellationReason = async (req: Request, res: Response) => {
  const { id } = req.params;
  const updateData = req.body;

  // If code is being updated, uppercase it
  if (updateData.code) {
    updateData.code = updateData.code.toUpperCase();
  }

  // Before-image for the audit trail: refundPercentage and penaltyValue decide
  // real money on every cancellation, so an edit has to be attributable.
  const previous = await CancellationReason.findById(id).lean();

  const reason = await CancellationReason.findByIdAndUpdate(id, updateData, { new: true, runValidators: true });
  if (!reason) {
    res.status(404);
    throw new Error("Cancellation reason not found");
  }

  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "settings",
    targetId: String(reason._id),
    targetType: "CancellationReason",
    description: `Updated cancellation reason ${reason.code}`,
    changes: diffFields(previous as any, updateData),
  });

  res.locals.data = {
    message: "Cancellation reason updated",
    reason,
  };

  // Invalidate user-facing cache
  await cache.del("cancellationReasons:user");
};

/**
 * Delete (soft-delete by deactivating) a cancellation reason
 */
export const deleteCancellationReason = async (req: Request, res: Response) => {
  const { id } = req.params;

  const reason = await CancellationReason.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true, runValidators: true },
  );
  if (!reason) {
    res.status(404);
    throw new Error("Cancellation reason not found");
  }

  await auditFromRequest(req, {
    action: "DELETE",
    module: "settings",
    targetId: String(reason._id),
    targetType: "CancellationReason",
    description: `Deactivated cancellation reason ${reason.code}`,
  });

  res.locals.data = {
    message: "Cancellation reason deleted",
    reason,
  };

  // Invalidate user-facing cache
  await cache.del("cancellationReasons:user");
};

// ============ TIME SLOTS ============

/**
 * Get time slots
 */
export const getTimeSlots = async (req: Request, res: Response) => {
  const slots = await TimeSlot.find({ isActive: true }).sort({ sortOrder: 1 });
  const scheduleConfig = await ScheduleConfig.findOne();

  res.locals.data = {
    slots,
    scheduleConfig: scheduleConfig || {
      advanceBookingDays: 7,
      minAdvanceHours: 2,
      isSchedulingEnabled: true,
    },
  };
};

/**
 * Update schedule config
 */
export const updateScheduleConfig = async (req: Request, res: Response) => {
  const config = await ScheduleConfig.findOneAndUpdate({}, req.body, {
    new: true,
    upsert: true,
  });

  res.locals.data = {
    message: "Schedule config updated",
    config,
  };
};

// ============ GOODS TYPES ============

/**
 * Get goods types
 */
export const getGoodsTypes = async (req: Request, res: Response) => {
  const { page = 1, limit = 20, search, status } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = { isDeleted: { $ne: true } };
  if (status === "active") filter.isActive = true;
  else if (status === "inactive") filter.isActive = false;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { category: { $regex: search, $options: "i" } },
    ];
  }

  const [goodsTypes, total] = await Promise.all([
    GoodsType.find(filter)
      .populate("allowedVehicleTypes", "name image icon")
      .sort({ sortOrder: 1, category: 1 })
      .skip(skip)
      .limit(limitNum),
    GoodsType.countDocuments(filter),
  ]);

  res.locals.data = {
    goodsTypes,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  };
};

/**
 * Create goods type (delivery category)
 */
export const createGoodsType = async (req: Request, res: Response) => {
  const goodsType = await GoodsType.create(req.body);
  await cache.del("goodsTypes:active");
  res.locals.data = { message: "Category created", goodsType };
};

/**
 * Update goods type
 */
export const updateGoodsType = async (req: Request, res: Response) => {
  const { id } = req.params;
  const goodsType = await GoodsType.findByIdAndUpdate(id, req.body, { new: true, runValidators: true })
    .populate("allowedVehicleTypes", "name image icon");

  if (!goodsType) {
    return res.status(404).json({ success: false, message: "Category not found" });
  }
  await cache.del("goodsTypes:active");
  res.locals.data = { message: "Category updated", goodsType };
};

/**
 * Toggle goods type active status
 */
export const toggleGoodsType = async (req: Request, res: Response) => {
  const { id } = req.params;
  const goodsType = await GoodsType.findById(id);
  if (!goodsType) {
    return res.status(404).json({ success: false, message: "Category not found" });
  }
  goodsType.isActive = !goodsType.isActive;
  await goodsType.save();
  await cache.del("goodsTypes:active");
  res.locals.data = { message: `Category ${goodsType.isActive ? "activated" : "deactivated"}`, goodsType };
};

/**
 * Delete goods type (soft delete)
 */
export const deleteGoodsType = async (req: Request, res: Response) => {
  const { id } = req.params;
  const goodsType = await GoodsType.findByIdAndUpdate(id, { isDeleted: true, isActive: false }, { new: true, runValidators: true });
  if (!goodsType) {
    return res.status(404).json({ success: false, message: "Category not found" });
  }
  await cache.del("goodsTypes:active");
  res.locals.data = { message: "Category deleted" };
};

/**
 * Toggle addon service
 */
export const toggleAddonService = async (req: Request, res: Response) => {
  const { id } = req.params;
  const addon = await AddonService.findById(id);
  if (!addon) {
    return res.status(404).json({ success: false, message: "Addon not found" });
  }
  addon.isActive = !addon.isActive;
  await addon.save();
  await cache.del("addons:active");
  await auditFromRequest(req, {
    action: "CHANGE_STATUS",
    module: "settings",
    targetId: String(addon._id),
    targetType: "AddonService",
    description: `${addon.isActive ? "Activated" : "Deactivated"} add-on "${addon.name}"`,
    changes: [
      { field: "isActive", oldValue: !addon.isActive, newValue: addon.isActive },
    ],
  });
  res.locals.data = { message: `Addon ${addon.isActive ? "activated" : "deactivated"}`, addon };
};

/**
 * Delete addon service
 */
export const deleteAddonService = async (req: Request, res: Response) => {
  const { id } = req.params;
  // Hard delete — capture what was removed before it is gone.
  const removed = await AddonService.findByIdAndDelete(id);
  await cache.del("addons:active");
  await auditFromRequest(req, {
    action: "DELETE",
    module: "settings",
    targetId: String(id),
    targetType: "AddonService",
    description: `Deleted add-on "${removed?.name ?? id}"`,
    before: removed
      ? { name: removed.name, price: removed.price, priceType: removed.priceType }
      : undefined,
  });
  res.locals.data = { message: "Addon deleted" };
};

// ============ APP SETTINGS ============

/**
 * Get app settings
 */
export const getAppSettings = async (req: Request, res: Response) => {
  const { category } = req.query;

  const query: any = {};
  if (category) query.category = category;

  const settings = await AppConfig.find(query).sort({ category: 1, key: 1 });

  res.locals.data = { settings };
};

/**
 * Update app setting
 */
export const updateAppSetting = async (req: Request, res: Response) => {
  const { key } = req.params;
  const { value } = req.body;

  // Before-image for the audit row.
  const previousValue = (await AppConfig.findOne({ key }).lean())?.value;

  const setting = await AppConfig.findOneAndUpdate(
    { key },
    { value },
    { new: true, runValidators: true },
  );

  if (!setting) {
    return res.status(404).json({
      success: false,
      message: "Setting not found",
    });
  }

  // Invalidate cached config value
  await cache.del(`config:${key}`);

  await auditFromRequest(req, {
    action: "CONFIG_CHANGE",
    module: "settings",
    targetId: key,
    targetType: "AppConfig",
    description: `Updated app setting ${key}`,
    changes: [{ field: "value", oldValue: previousValue, newValue: value }],
  });

  res.locals.data = {
    message: "Setting updated",
    setting,
  };
};

/**
 * Create app setting
 */
export const createAppSetting = async (req: Request, res: Response) => {
  const { key, value, type, category, description } = req.body;

  const existing = await AppConfig.findOne({ key });
  if (existing) {
    return res.status(400).json({
      success: false,
      message: "Setting key already exists",
    });
  }

  const setting = await AppConfig.create({
    key,
    value,
    type: type || "STRING",
    category,
    description,
  });

  // Readers cache their FALLBACK under config:<key> when the row is absent
  // (getJoiningFee caches 999), so creating the row must invalidate too or
  // the old fallback survives for up to an hour.
  await cache.del(`config:${key}`);

  res.locals.data = {
    message: "Setting created",
    setting,
  };
};

// ============ SERVICE AREAS ============

/**
 * Get service areas
 */
export const getServiceAreas = async (req: Request, res: Response) => {
  const areas = await ServiceArea.find({ isActive: true });

  res.locals.data = { areas };
};

/**
 * Create/Update service area
 */
export const upsertServiceArea = async (req: Request, res: Response) => {
  const { id, ...data } = req.body;

  let area;
  if (id) {
    area = await ServiceArea.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  } else {
    area = await ServiceArea.create(data);
  }

  res.locals.data = {
    message: "Service area saved",
    area,
  };
};

// ============ PROHIBITED ITEMS ============

/**
 * Get all prohibited items (including inactive, for admin)
 */
export const getProhibitedItems = async (req: Request, res: Response) => {
  const { activeOnly, status, page = 1, limit = 20, search } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = activeOnly === "true" ? { isActive: true } : {};
  if (status === "active") filter.isActive = true;
  else if (status === "inactive") filter.isActive = false;
  if (search) {
    filter.name = { $regex: search, $options: "i" };
  }

  const [items, total] = await Promise.all([
    ProhibitedItem.find(filter).sort({ sortOrder: 1 }).skip(skip).limit(limitNum),
    ProhibitedItem.countDocuments(filter),
  ]);

  res.locals.data = {
    items,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  };
};

/**
 * Create a new prohibited item
 */
export const createProhibitedItem = async (req: Request, res: Response) => {
  const { name, icon, image, bgColor, description, sortOrder } = req.body;

  if (!name) {
    res.status(400);
    throw new Error("name is required");
  }

  const newItem = await ProhibitedItem.create({
    name,
    icon: icon || "",
    image: image || "",
    bgColor: bgColor || "#FFF3E0",
    description: description || "",
    sortOrder: sortOrder ?? 0,
  });

  res.locals.data = {
    message: "Prohibited item created",
    item: newItem,
  };

  await cache.del("prohibitedItems:active");
};

/**
 * Update a prohibited item
 */
export const updateProhibitedItem = async (req: Request, res: Response) => {
  const { id } = req.params;
  const updateData = req.body;

  const item = await ProhibitedItem.findByIdAndUpdate(id, updateData, { new: true, runValidators: true });
  if (!item) {
    res.status(404);
    throw new Error("Prohibited item not found");
  }

  res.locals.data = {
    message: "Prohibited item updated",
    item,
  };

  await cache.del("prohibitedItems:active");
};

/**
 * Delete (soft-delete by deactivating) a prohibited item
 */
export const deleteProhibitedItem = async (req: Request, res: Response) => {
  const { id } = req.params;

  const item = await ProhibitedItem.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true, runValidators: true },
  );
  if (!item) {
    res.status(404);
    throw new Error("Prohibited item not found");
  }

  res.locals.data = {
    message: "Prohibited item deleted",
    item,
  };

  await cache.del("prohibitedItems:active");
};

// ============ CITIES ============

export const getCities = async (req: Request, res: Response) => {
  const { page = 1, limit = 50, search, activeOnly } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = activeOnly === "true" ? { isActive: true } : {};
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { state: { $regex: search, $options: "i" } },
    ];
  }

  const [cities, total] = await Promise.all([
    City.find(filter).sort({ sortOrder: 1, name: 1 }).skip(skip).limit(limitNum),
    City.countDocuments(filter),
  ]);

  res.locals.data = {
    cities,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  };
};

export const createCity = async (req: Request, res: Response) => {
  const { name, state, sortOrder } = req.body;
  if (!name || !state) { res.status(400); throw new Error("name and state are required"); }

  const existing = await City.findOne({ name: { $regex: `^${name}$`, $options: "i" }, state: { $regex: `^${state}$`, $options: "i" } });
  if (existing) { res.status(409); throw new Error(`City '${name}, ${state}' already exists`); }

  const city = await City.create({ name, state, sortOrder: sortOrder ?? 0 });
  res.locals.data = { message: "City created", city };
};

export const updateCity = async (req: Request, res: Response) => {
  const { id } = req.params;
  const city = await City.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
  if (!city) { res.status(404); throw new Error("City not found"); }
  res.locals.data = { message: "City updated", city };
};

export const deleteCity = async (req: Request, res: Response) => {
  const { id } = req.params;
  const city = await City.findByIdAndUpdate(id, { isActive: false }, { new: true, runValidators: true });
  if (!city) { res.status(404); throw new Error("City not found"); }
  res.locals.data = { message: "City deleted", city };
};

// ============ BODY TYPES ============

export const getBodyTypes = async (req: Request, res: Response) => {
  const { page = 1, limit = 50, search, activeOnly } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = activeOnly === "true" ? { isActive: true } : {};
  if (search) { filter.name = { $regex: search, $options: "i" }; }

  const [bodyTypes, total] = await Promise.all([
    BodyType.find(filter).sort({ sortOrder: 1, name: 1 }).skip(skip).limit(limitNum),
    BodyType.countDocuments(filter),
  ]);

  res.locals.data = {
    bodyTypes,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  };
};

export const createBodyType = async (req: Request, res: Response) => {
  const { name, sortOrder } = req.body;
  if (!name) { res.status(400); throw new Error("name is required"); }

  const existing = await BodyType.findOne({ name: { $regex: `^${name}$`, $options: "i" } });
  if (existing) { res.status(409); throw new Error(`Body type '${name}' already exists`); }

  const bodyType = await BodyType.create({ name, sortOrder: sortOrder ?? 0 });
  res.locals.data = { message: "Body type created", bodyType };
};

export const updateBodyType = async (req: Request, res: Response) => {
  const { id } = req.params;
  const bodyType = await BodyType.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
  if (!bodyType) { res.status(404); throw new Error("Body type not found"); }
  res.locals.data = { message: "Body type updated", bodyType };
};

export const deleteBodyType = async (req: Request, res: Response) => {
  const { id } = req.params;
  const bodyType = await BodyType.findByIdAndUpdate(id, { isActive: false }, { new: true, runValidators: true });
  if (!bodyType) { res.status(404); throw new Error("Body type not found"); }
  res.locals.data = { message: "Body type deleted", bodyType };
};

// ============ FUEL TYPES ============

export const getFuelTypes = async (req: Request, res: Response) => {
  const { page = 1, limit = 50, search, activeOnly } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = activeOnly === "true" ? { isActive: true } : {};
  if (search) { filter.name = { $regex: search, $options: "i" }; }

  const [fuelTypes, total] = await Promise.all([
    FuelType.find(filter).sort({ sortOrder: 1, name: 1 }).skip(skip).limit(limitNum),
    FuelType.countDocuments(filter),
  ]);

  res.locals.data = {
    fuelTypes,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  };
};

export const createFuelType = async (req: Request, res: Response) => {
  const { name, sortOrder } = req.body;
  if (!name) { res.status(400); throw new Error("name is required"); }

  const existing = await FuelType.findOne({ name: { $regex: `^${name}$`, $options: "i" } });
  if (existing) { res.status(409); throw new Error(`Fuel type '${name}' already exists`); }

  const fuelType = await FuelType.create({ name, sortOrder: sortOrder ?? 0 });
  res.locals.data = { message: "Fuel type created", fuelType };
};

export const updateFuelType = async (req: Request, res: Response) => {
  const { id } = req.params;
  const fuelType = await FuelType.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
  if (!fuelType) { res.status(404); throw new Error("Fuel type not found"); }
  res.locals.data = { message: "Fuel type updated", fuelType };
};

export const deleteFuelType = async (req: Request, res: Response) => {
  const { id } = req.params;
  const fuelType = await FuelType.findByIdAndUpdate(id, { isActive: false }, { new: true, runValidators: true });
  if (!fuelType) { res.status(404); throw new Error("Fuel type not found"); }
  res.locals.data = { message: "Fuel type deleted", fuelType };
};

// ============ ALL MASTER DATA (public / driver-facing) ============

/**
 * Returns all active master data in a single response.
 * Used by the driver / user app on the vehicle-details screen.
 */
export const getAllMasterData = async (_req: Request, res: Response) => {
  const [cities, bodyTypes, fuelTypes, vehicleTypes] = await Promise.all([
    City.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select("name state"),
    BodyType.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select("name"),
    FuelType.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select("name"),
    // Admin-managed vehicle catalog for the Add Vehicle dropdown. `_id` is the
    // vehicleTypeId dispatch matches on, so the app must submit it (not a name).
    VehicleType.find({ isActive: true, isDeleted: false })
      .sort({ sortOrder: 1, name: 1 })
      .select("name icon image"),
  ]);

  res.locals.data = { cities, bodyTypes, fuelTypes, vehicleTypes };
};

/**
 * Support contact, admin-editable.
 *
 * Both apps used to dial a hardcoded placeholder (+91 1234567890) — including
 * the driver app's post-accident auto-dial, which is the worst possible place
 * for a wrong number. The number now lives in config so it can be set once and
 * corrected without an app release, and the apps hide the call control entirely
 * when it is unset rather than dialling something invented.
 */
const SUPPORT_PHONE_KEY = "SUPPORT_PHONE";

export const getSupportContact = async (_req: Request, res: Response) => {
  const doc = await AppConfig.findOne({ key: SUPPORT_PHONE_KEY }).lean();
  res.locals.data = {
    supportPhone: (doc as any)?.value ? String((doc as any).value) : "",
  };
};

export const updateSupportContact = async (req: Request, res: Response) => {
  const raw = req.body?.supportPhone;
  const supportPhone = typeof raw === "string" ? raw.trim() : "";

  // Allow clearing (empty string) — that is how an admin turns the call
  // buttons off. Anything non-empty must look like a real dialable number.
  if (supportPhone && !/^\+?[0-9][0-9 ()-]{6,19}$/.test(supportPhone)) {
    return res.status(400).json({
      success: false,
      message:
        "Enter a valid phone number (digits, optionally starting with +), or leave it blank to hide the call buttons.",
    });
  }

  await AppConfig.findOneAndUpdate(
    { key: SUPPORT_PHONE_KEY },
    {
      key: SUPPORT_PHONE_KEY,
      value: supportPhone,
      type: "STRING",
      category: "SUPPORT",
      description:
        "Phone number the user and driver apps dial for support. Blank hides the call buttons.",
      isEditable: true,
    },
    { upsert: true, new: true, runValidators: true },
  );

  res.locals.data = { supportPhone };
  res.locals.message = supportPhone
    ? "Support number updated."
    : "Support number cleared — the apps will hide their call buttons.";
};

/** Public: what the apps read. No auth — it is a published contact number. */
export const getPublicSupportContact = async (_req: Request, res: Response) => {
  const doc = await AppConfig.findOne({ key: SUPPORT_PHONE_KEY }).lean();
  res.json({
    success: true,
    data: { supportPhone: (doc as any)?.value ? String((doc as any).value) : "" },
  });
};
