import mongoose from "mongoose";
import config from "../config";

// Import all models
import User from "./Users";
import UserAddress from "./UserAddress";
import Driver from "./driver.model";
import DriverKyc from "./driver-kyc.model";
import DriverLocation from "./driver-location.model";
import DriverVehicle from "./driver-vehicle.model";
import Vehicle from "./vehicle.model";
import VehicleCategory from "./vehicle-category.model";
import VehicleType from "./vehicle-type.model";
import Booking from "./booking.model";
import Wallet from "./wallet.model";
import WalletTransaction from "./wallet-transaction.model";
import RewardTransaction from "./reward-transaction.model";
import UserGST from "./user-gst.model";

// New models for complete functionality
import PromoCode from "./promo-code.model";
import PromoUsage from "./promo-usage.model";
import ServiceType from "./service-type.model";
import AddonService from "./addon-service.model";
import GoodsType from "./goods-type.model";
import { CoinWallet, CoinTransaction } from "./coin.model";
import { SupportTicket, SupportMessage } from "./support-ticket.model";
import { Enterprise, EnterpriseUser } from "./enterprise.model";
import CancellationReason from "./cancellation-reason.model";
import ProhibitedItem from "./prohibited-item.model";
import { TimeSlot, ScheduleConfig } from "./time-slot.model";
import { AppConfig, FareConfig, ServiceArea } from "./app-config.model";
import { Notification, PushTemplate } from "./notification.model";
import Invoice from "./invoice.model";
import { Admin, AdminSession } from "./admin.model";
import { Content, FAQ, Language } from "./content.model";
import { EmergencyContact, SOSAlert } from "./sos.model";
import { City, BodyType, FuelType } from "./master-data.model";

// Previously imported only at usage sites; registering them here as well so the
// central `models` registry is complete and Mongoose model registration is
// guaranteed regardless of import order.
import { AuditLog } from "./audit-log.model";
import { AutomationRule } from "./automation-rule.model";
import Badge from "./badge.model";
import ChatMessage from "./chat-message.model";
import ScheduledReport from "./scheduled-report.model";
import Payout from "./payout.model";
import TrainingProgram from "./training-program.model";
import TrainingEnrollment from "./training-enrollment.model";
import { CreditHistory } from "./credit-history.model";
import DriverInstruction from "./driver-instruction.model";
import { EnterpriseContent } from "./enterprise-content.model";
import { EnterpriseInquiry } from "./enterprise-inquiry.model";
import { Expense } from "./expense.model";
import { RefundRequest } from "./refund-request.model";
import { Role } from "./role.model";
import TrainingMaterial from "./training-material.model";

mongoose.set("strictQuery", true);
// Don't 500 the whole request when a controller populates a path that isn't a
// defined ref (e.g. legacy `vehicleId`/`categoryId`) — return null for it instead.
// Individual invalid populates are still being cleaned up, but this is the safety net.
mongoose.set("strictPopulate", false);

export const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(config.database.url, config.database.options);
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ Error connecting to MongoDB:", error);
    process.exit(1);
  }
};

// Connection listeners
mongoose.connection.on("error", (error) => {
  console.error("MongoDB connection error:", error);
});

mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB disconnected");
});

mongoose.connection.on("reconnected", () => {
  console.log("✅ MongoDB reconnected");
});

// Complete model registry
export const models = {
  // User related
  User,
  UserAddress,
  UserGST,

  // Driver related
  Driver,
  DriverKyc,
  DriverLocation,
  DriverVehicle,

  // Vehicle related
  Vehicle,
  VehicleCategory,
  VehicleType,

  // Booking related
  Booking,
  ServiceType,
  AddonService,
  GoodsType,
  CancellationReason,
  ProhibitedItem,
  TimeSlot,
  ScheduleConfig,
  Invoice,

  // Wallet & Rewards
  Wallet,
  WalletTransaction,
  RewardTransaction,
  CoinWallet,
  CoinTransaction,

  // Promo related
  PromoCode,
  PromoUsage,

  // Support related
  SupportTicket,
  SupportMessage,

  // Enterprise
  Enterprise,
  EnterpriseUser,

  // Config & Settings
  AppConfig,
  FareConfig,
  ServiceArea,

  // Notifications
  Notification,
  PushTemplate,

  // Admin
  Admin,
  AdminSession,

  // Content
  Content,
  FAQ,
  Language,

  // SOS/Emergency
  EmergencyContact,
  SOSAlert,

  // Master Data
  City,
  BodyType,
  FuelType,

  // Audit & Automation
  AuditLog,
  AutomationRule,
  ScheduledReport,
  Payout,
  TrainingProgram,
  TrainingEnrollment,

  // Driver engagement
  Badge,
  DriverInstruction,
  TrainingMaterial,

  // Chat
  ChatMessage,

  // Enterprise (content / inquiry / credit)
  EnterpriseContent,
  EnterpriseInquiry,
  CreditHistory,

  // Finance
  Expense,
  RefundRequest,

  // Access control
  Role,
} as const;

export default connectDB;

export type ModelName = keyof typeof models;
