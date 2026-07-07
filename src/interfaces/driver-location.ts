import { Types } from "mongoose";

export interface IDriverLocation {
  driverId: Types.ObjectId;

  location: {
    type: "Point";
    coordinates: [number, number]; // [longitude, latitude]
  };

  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  accuracy?: number;

  isOnline?: boolean;
  lastUpdated?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}
