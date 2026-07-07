import { Types } from "mongoose";

export type AddressType = "Home" | "Work" | "Other";

export interface IUserAddress {
  userId: Types.ObjectId;

  fullName: string;
  mobileNumber: string;

  houseNo: string;
  area: string;

  /**
   * Derived field:
   * `${houseNo}, ${area}, ${city}, ${state} - ${pinCode}`
   */
  address: string;

  city: string;
  state: string;
  country: string; // default: "India"

  pinCode: number;

  addressType: AddressType;

  latitude?: number;
  longitude?: number;

  isSelected: boolean;
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}
