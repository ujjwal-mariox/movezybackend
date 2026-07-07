import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";

import * as UserService from "../services/user.service";
import * as UserAddressService from "../services/address.service";
import fileUploadService from "../utils/s3";
import { Express } from "express";

export const updateDeviceToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId, deviceToken, deviceType } = req.body;

  await UserService.updateUsers(userId, { deviceToken, deviceType });

  req.msg = "success";
  req.rData = {};
  next();
};

export const getDetails = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const userId = (req as any).userId;

  const user = await UserService.fetch(userId);

  if (!user) {
    req.msg = "user_not_found";
    req.rCode = 5;
    req.rData = {};
  } else {
    req.msg = "success";
    req.rData = user;
  }

  next();
};

export const editUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const userId = (req as any).userId;

  // Whitelist allowed fields to prevent mass assignment
  const allowedFields: Record<string, any> = {};
  const safeFields = ["fullName", "email", "gender", "dob", "profileImage", "notificationAllowed"];
  for (const field of safeFields) {
    if (req.body[field] !== undefined) {
      allowedFields[field] = req.body[field];
    }
  }

  if (Array.isArray(req.files) && Array.isArray(req.files)) {
    const images = await fileUploadService.uploadFileToAws(
      req.files as Express.Multer.File[]
    );
    allowedFields.profileImage = images.images;
  }

  const userData = await UserService.updateUsers(userId, allowedFields);

  req.rData = {};
  req.msg = "success";
  next();
};

/**
 * Address
 */

export const addUserAddress = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { houseNo, area, city, state, pinCode } = req.body;

  req.body.address = `${houseNo}, ${area}, ${city}, ${state} - ${pinCode}`;

  const userId = (req as any).userId;

  req.body.userId = userId;

  let address = await UserAddressService.addUserAddress(req.body);

  req.rData = address;
  req.msg = "success";
  next();
};

export const updateUserAddress = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { id } = req.params;
  const userId = (req as any).userId;
  const { houseNo, area, city, state, pinCode } = req.body;

  if (houseNo || area || city || state || pinCode) {
    req.body.address = `${houseNo}, ${area}, ${city}, ${state} - ${pinCode}`;
  }

  // Verify address belongs to this user
  const existing = await UserAddressService.fetch(id);
  if (!existing || String((existing as any).userId) !== String(userId)) {
    req.rCode = 5;
    req.msg = "address_not_found";
    return next();
  }

  const updatedAddress = await UserAddressService.updateUserAddress(
    id,
    req.body
  );

  if (!updatedAddress) {
    req.rCode = 5;
    req.msg = "address_not_found";
    return next();
  }

  req.rData = updatedAddress;
  req.msg = "success";
  next();
};

export const getUserAddress = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const rawPage = req.query.page;
  const rawLimit = req.query.limit;
  const rawIsActive = req.query.isActive;

  const page =
    rawPage && rawPage !== "" && rawPage !== "null"
      ? Math.max(Number(rawPage), 1)
      : 1;

  // ✅ Normalize limit
  const limit =
    rawLimit && rawLimit !== "" && rawLimit !== "null"
      ? Math.max(Number(rawLimit), 1)
      : 10;

  const userId = (req as any).userId;

  const query: any = { userId };
  query.isActive = rawIsActive ? rawIsActive : true;

  const data = await UserAddressService.getUserAddress(
    query,
    Number(page),
    Number(limit)
  );

  const total = await UserAddressService.countUserAddress(query);

  req.rData = { page, limit, total, data };
  req.msg = "success";
  next();
};

export const deleteUserAddress = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const addressId = req.params.id || req.body.addressId;
  const userId = (req as any).userId;

  // Verify address belongs to this user
  const existing = await UserAddressService.fetch(addressId);
  if (!existing || String((existing as any).userId) !== String(userId)) {
    req.rCode = 5;
    req.msg = "address_not_found";
    return next();
  }

  await UserAddressService.deleteUserAddress(addressId);

  req.msg = "success";
  next();
};

export const selectAddress = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const userId = (req as any).userId;
  const { id } = req.params;

  // Use bulk update instead of N+1 loop
  const UserAddress = (await import("../models/UserAddress")).default;
  await UserAddress.updateMany(
    { userId, _id: { $ne: new Types.ObjectId(id) } },
    { $set: { isSelected: false } }
  );

  await UserAddressService.updateUserAddress(id, { isSelected: true });

  req.msg = "success";
  next();
};

export const getUserAddressDetail = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { id } = req.params;

  const address = await UserAddressService.fetch(id);

  req.rData = address;
  req.msg = "success";
  next();
};

export const activateDeactivateNotification = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const userId = (req as any).userId;

  const user = await UserService.fetch(userId);

  if (user) {
    const notificationAllowed = !user.notificationAllowed;
    await UserService.updateUsers(userId, { notificationAllowed });
  }

  req.msg = "status_changed";
  next();
};
