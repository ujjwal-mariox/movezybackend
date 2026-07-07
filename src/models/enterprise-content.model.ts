import mongoose, { Schema, Types } from "mongoose";

export interface IEnterpriseFeature {
  icon: string;       // icon name or asset key
  title: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

export interface IEnterpriseFaq {
  question: string;
  answer: string;
  sortOrder: number;
  isActive: boolean;
}

export interface IEnterpriseClient {
  name: string;
  logoUrl: string;    // URL or asset key for logo
  sortOrder: number;
  isActive: boolean;
}

export interface IEnterpriseContent {
  _id: Types.ObjectId;
  // Hero section
  heroTitle: string;
  heroSubtitle: string;
  // Features
  features: IEnterpriseFeature[];
  // FAQs
  faqs: IEnterpriseFaq[];
  // Client logos
  clients: IEnterpriseClient[];
  // Bottom CTA
  ctaText: string;
  ctaSubtext: string;
  // Active flag
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const EnterpriseFeatureSchema = new Schema<IEnterpriseFeature>(
  {
    icon: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { _id: true },
);

const EnterpriseFaqSchema = new Schema<IEnterpriseFaq>(
  {
    question: { type: String, required: true },
    answer: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { _id: true },
);

const EnterpriseClientSchema = new Schema<IEnterpriseClient>(
  {
    name: { type: String, required: true },
    logoUrl: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { _id: true },
);

const EnterpriseContentSchema = new Schema<IEnterpriseContent>(
  {
    heroTitle: {
      type: String,
      default: "Upgrade to Movezy Enterprise\nfor Business Logistics",
    },
    heroSubtitle: {
      type: String,
      default: "All these features at No Additional Charges!",
    },
    features: {
      type: [EnterpriseFeatureSchema],
      default: [],
    },
    faqs: {
      type: [EnterpriseFaqSchema],
      default: [],
    },
    clients: {
      type: [EnterpriseClientSchema],
      default: [],
    },
    ctaText: {
      type: String,
      default: "Get in touch!",
    },
    ctaSubtext: {
      type: String,
      default: "All these features at No Additional Charges!",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

export const EnterpriseContent = mongoose.model<IEnterpriseContent>(
  "EnterpriseContent",
  EnterpriseContentSchema,
);
