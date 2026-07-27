import { Types } from "mongoose";

export type DocumentReviewStatus = "PENDING" | "VERIFIED" | "REJECTED";

export interface IDocumentReview {
  status: DocumentReviewStatus;
  reviewedAt?: Date;
  reviewedBy?: Types.ObjectId;
  rejectionReason?: string;
}

export interface IDriverKyc {
  driverId: Types.ObjectId;

  aadhaar?: {
    number: string;
    frontImage: string;
    backImage: string;
  };

  pan?: {
    number: string;
    frontImage: string;
    backImage?: string;
  };

  drivingLicense?: {
    number: string;
    frontImage: string;
    backImage: string;
    expiryDate: string;
  };

  selfie?: string;

  vehicleRc?: {
    image: string;
    vehicleNumber: string;
  };

  vehicleImages?: string[];
  city?: string;
  bodyType?: string;
  fuelType?: string;

  /**
   * Per-document review state.
   *
   * `isVerified` below is a single flag covering the whole KYC set, so an admin
   * approving one document necessarily approved all five. Each document now
   * carries its own verdict; `isVerified` is derived from them.
   */
  documentStatus?: Record<string, IDocumentReview>;

  isVerified?: boolean;
  verifiedAt?: Date;

  status?: "documents_uploaded";
}
