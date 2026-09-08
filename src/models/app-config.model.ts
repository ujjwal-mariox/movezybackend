import mongoose, { Schema, Types } from "mongoose";

export interface IAppConfig {
  _id: Types.ObjectId;
  key: string;
  value: any;
  type: "STRING" | "NUMBER" | "BOOLEAN" | "JSON" | "ARRAY";
  category: string;
  description: string;
  isEditable: boolean;
}

/**
 * A weather surge an admin switches ON (rain, storm) for the cities it names.
 * Applies to new quotes while active; `activeUntil` lets it switch itself off.
 */
export interface IWeatherSurge {
  label: string;
  /** Empty = every city. Matched against the pickup city like rate cards. */
  cities: string[];
  /** >= 1. */
  multiplier: number;
  isActive: boolean;
  activeUntil?: Date | null;
}

export interface ISurgeWindow {
  label?: string;
  /** 0-23, inclusive start. */
  startHour: number;
  /** 0-23, exclusive end; may be less than startHour to wrap midnight. */
  endHour: number;
  /** >= 1. 1 = no surge. */
  multiplier: number;
}

export interface IFareConfig {
  _id: Types.ObjectId;
  name: string;
  gstPercentage: number;
  /** Share of the pre-GST subtotal Movezy retains from the driver's settlement. */
  driverCommissionPercent: number;
  insuranceFee: number;
  minimumFare: number;
  waitingChargePerMin: number;
  freeWaitingMinutes: number;
  nightSurgeMultiplier: number;
  nightSurgeStartHour: number;
  nightSurgeEndHour: number;
  rainSurgeMultiplier: number;
  peakHourSurgeMultiplier: number;
  peakHourStart: number;
  peakHourEnd: number;
  /**
   * Multiple surge windows, replacing the single start/end/multiplier trio
   * above (kept for older rows; ignored once a window exists). Windows may
   * wrap midnight (22 -> 6). When several match, the highest wins.
   */
  peakWindows: ISurgeWindow[];
  nightWindows: ISurgeWindow[];
  weatherSurges: IWeatherSurge[];
  /**
   * Refund ceiling by cancellation stage, as a percentage of the fare.
   *
   * Cancellation used to refund 100% at ANY stage — including PICKED and
   * IN_PROGRESS, where the goods are already on the vehicle and the driver has
   * done the work. A reason's own refundPercentage still applies, but it can
   * no longer exceed the ceiling for the stage the trip reached.
   */
  refundBeforeAssignPercent: number;
  refundAfterAssignPercent: number;
  refundAfterPickupPercent: number;
  isActive: boolean;
}

export interface IServiceArea {
  _id: Types.ObjectId;
  name: string;
  city: string;
  state: string;
  coordinates: {
    type: string;
    coordinates: number[][][];
  };
  isActive: boolean;
  fareMultiplier: number;
}

// App Config Schema
const AppConfigSchema = new Schema<IAppConfig>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    value: {
      type: Schema.Types.Mixed,
      required: true,
    },
    type: {
      type: String,
      enum: ["STRING", "NUMBER", "BOOLEAN", "JSON", "ARRAY"],
      default: "STRING",
    },
    category: {
      type: String,
      required: true,
      index: true,
    },
    description: {
      type: String,
      default: "",
    },
    isEditable: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// Fare Config Schema
const SurgeWindowSchema = new Schema<ISurgeWindow>(
  {
    label: { type: String, trim: true },
    startHour: { type: Number, required: true, min: 0, max: 23 },
    endHour: { type: Number, required: true, min: 0, max: 23 },
    multiplier: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const WeatherSurgeSchema = new Schema<IWeatherSurge>(
  {
    label: { type: String, trim: true, default: "" },
    cities: { type: [String], default: [] },
    multiplier: { type: Number, min: 1, default: 1.3 },
    isActive: { type: Boolean, default: false },
    activeUntil: { type: Date, default: null },
  },
  { _id: false },
);

const FareConfigSchema = new Schema<IFareConfig>(
  {
    name: {
      type: String,
      required: true,
      default: "default",
    },
    gstPercentage: {
      type: Number,
      default: 5,
      min: 0,
      max: 100,
    },
    driverCommissionPercent: {
      type: Number,
      default: 20,
      min: 0,
      max: 100,
    },
    // `platformFeePercentage` was removed here: it sat in config at 10 but no
    // calculation anywhere read it, so it looked like a live setting and was
    // not. Commission lives in `driverCommissionPercent` above.
    insuranceFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    minimumFare: {
      type: Number,
      default: 50,
      min: 0,
    },
    // Stage ceilings. Defaults are deliberately conservative and fully
    // admin-editable: nothing is refunded once the goods are aboard, the
    // customer keeps a full refund until a driver has been committed.
    refundBeforeAssignPercent: { type: Number, default: 100, min: 0, max: 100 },
    refundAfterAssignPercent: { type: Number, default: 100, min: 0, max: 100 },
    refundAfterPickupPercent: { type: Number, default: 0, min: 0, max: 100 },
    waitingChargePerMin: {
      type: Number,
      default: 2,
      min: 0,
    },
    freeWaitingMinutes: {
      type: Number,
      default: 10,
      min: 0,
    },
    nightSurgeMultiplier: {
      type: Number,
      default: 1.2,
      min: 1,
    },
    nightSurgeStartHour: {
      type: Number,
      default: 22, // 10 PM
    },
    nightSurgeEndHour: {
      type: Number,
      default: 6, // 6 AM
    },
    rainSurgeMultiplier: {
      type: Number,
      default: 1.3,
      min: 1,
    },
    peakHourSurgeMultiplier: {
      type: Number,
      default: 1.5,
      min: 1,
    },
    peakHourStart: {
      type: Number,
      default: 8, // 8 AM
    },
    peakHourEnd: {
      type: Number,
      default: 10, // 10 AM
    },
    // Multi-row surge (client: "Morning 8-10 AM 1.5x; Evening 6-8 PM 1.8x").
    peakWindows: { type: [SurgeWindowSchema], default: [] },
    nightWindows: { type: [SurgeWindowSchema], default: [] },
    // Weather surge: region-based, switched on/off by the admin (rainSurgeMultiplier
    // above is the legacy single figure and is no longer read).
    weatherSurges: { type: [WeatherSurgeSchema], default: [] },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// Service Area Schema
const ServiceAreaSchema = new Schema<IServiceArea>(
  {
    name: {
      type: String,
      required: true,
    },
    city: {
      type: String,
      required: true,
      index: true,
    },
    state: {
      type: String,
      required: true,
    },
    coordinates: {
      type: {
        type: String,
        enum: ["Polygon"],
        required: true,
      },
      coordinates: {
        type: [[[Number]]],
        required: true,
      },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    fareMultiplier: {
      type: Number,
      default: 1,
      min: 0.5,
    },
  },
  { timestamps: true },
);

// Create 2dsphere index for geospatial queries
ServiceAreaSchema.index({ coordinates: "2dsphere" });

export const AppConfig = mongoose.model<IAppConfig>(
  "AppConfig",
  AppConfigSchema,
);
export const FareConfig = mongoose.model<IFareConfig>(
  "FareConfig",
  FareConfigSchema,
);
export const ServiceArea = mongoose.model<IServiceArea>(
  "ServiceArea",
  ServiceAreaSchema,
);
