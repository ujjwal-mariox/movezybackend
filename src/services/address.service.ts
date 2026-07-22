import { Types } from "mongoose";
import UserAddress from "../models/UserAddress";
import { IUserAddress } from "../interfaces/address";

/**
 * Add address
 */
export const addUserAddress = async (data: Partial<IUserAddress>) => {
  return await UserAddress.create(data);
};

/**
 * Fetch address by ID
 */
export const fetch = async (id: string | Types.ObjectId) => {
  return await UserAddress.findById(id).select("-time -__v");
};

/**
 * Fetch address by query
 */
export const fetchByQuery = async (query: any) => {
  return await UserAddress.findOne(query).sort({ _id: -1 });
};

/**
 * Fetch address for cart
 */
export const fetchByQueryForCart = async (query: any) => {
  return await UserAddress.findOne(query)
    .select("-userId -__v -isActive")
    .sort({ _id: -1 });
};

/**
 * Fetch address to edit
 */
export const fetchByQueryToEdit = async (query: any) => {
  return await UserAddress.findOne(query);
};

/**
 * Update address
 */
export const updateUserAddress = async (
  userAddressId: string | Types.ObjectId,
  data: Partial<IUserAddress>
) => {
  return await UserAddress.findByIdAndUpdate(userAddressId, data, {
    new: true,
  });
};

/**
 * Get address list
 */
// `page` is 1-based, matching what the controller normalizes to and what
// ADDRESS_API_IMPLEMENTATION.md documents. Treating it as 0-based here made
// page=1 skip the first `limit` rows, so the saved-address list came back empty.
export const getUserAddress = async (query: any, page = 1, limit = 10) => {
  return await UserAddress.find(query)
    .select("-__v")
    .sort({ _id: -1 })
    .skip((Math.max(page, 1) - 1) * limit)
    .limit(limit);
};

/**
 * Count addresses
 */
export const countUserAddress = async (query: any) => {
  return await UserAddress.countDocuments(query);
};

/**
 * Delete address
 */
export const deleteUserAddress = async (id: string | Types.ObjectId) => {
  return await UserAddress.deleteOne({ _id: id });
};
