import UserGST from "../models/user-gst.model";
import { Types } from "mongoose";

export const upsertGST = async (
  userId: Types.ObjectId,
  gstin: string,
  businessName?: string
) => {
  return await UserGST.findOneAndUpdate(
    { userId },
    { gstin, businessName, isActive: true },
    { upsert: true, new: true }
  );
};

export const getGST = async (userId: Types.ObjectId) => {
  return await UserGST.findOne({ userId, isActive: true });
};
