import { Request, Response, NextFunction } from "express";
// Node's built-in RFC 4122 v4 generator, not the `uuid` package. uuid v13 is
// ESM-only, so the CommonJS output this project compiles to could not require()
// it on any Node older than 20.19 — it booted locally on 22.x and crashed on a
// 20.18 host. crypto.randomUUID has been available since Node 14.17 and needs
// no dependency at all.
import { randomUUID } from "crypto";
import { Types } from "mongoose";

import * as DriverService from "../services/driver.service";
import * as DriverKycService from "../services/driver-kyc.service";
import * as DriverVehicleService from "../services/driver-vehicle.service";
import * as SmsService from "../services/sms.service";
import VehicleModel from "../models/vehicle.model";
import VehicleType from "../models/vehicle-type.model";
import DriverVehicleModel from "../models/driver-vehicle.model";
import helpers from "../utils/helpers";
import redis from "../utils/redis";
import config from "../config";
import fileUploadService from "../utils/s3";

/**
 * Driver Login - Step 1
 */
export const driverLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {

  const { mobileNumber, countryCode = "+91" } = req.body;

  const otp = helpers().generateOTP();

  const driver = await DriverService.getDriverByMobile(
    mobileNumber,
    countryCode,
  );

  const redisKey = `DRIVER_Mob_${mobileNumber}`;
  const redisKeys = await redis().GetKeys(redisKey);

  let txnId: string | undefined;

  if (redisKeys.length > 0) {
    const result = await redis().GetRedis<any>(redisKeys[0]);
    if (result?.[0]) {
      txnId = result[0].txnId;
    }
  }

  const newTxnId = randomUUID();

  const otpData = {
    txnId: newTxnId,
    mobileNumber,
    countryCode,
    otp,
    reason: "DRIVER OTP LOGIN",
    is_active: 1,
    date_created: new Date(),
    date_modified: new Date(),
  };

  await redis().SetRedis(
    `DRIVER|txnId:${newTxnId}`,
    JSON.stringify(otpData),
    600,
  );
  await redis().SetRedis(
    `DRIVER|Mob:${mobileNumber}`,
    JSON.stringify(otpData),
    600,
  );

  // Deliver the OTP by SMS. Fire-and-forget so an SMS outage never blocks login;
  // no-op (logged) when Twilio is unconfigured — dev uses the master OTP.
  SmsService.sendSms(
    mobileNumber,
    `${otp} is your Movezy driver verification code. Valid for a few minutes. Do not share it.`,
  ).catch(() => null);

  req.rData = {
    driverRegistered: !!driver,
    txnId: txnId || newTxnId,
  };

  req.msg = "otp_sent";
  next();
};

export const getDriverDetails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const driverId = (req as any).driverId;

  const [driver, kyc, vehicle] = await Promise.all([
    DriverService.getDriverById(driverId),
    DriverKycService.getDriverKyc(new Types.ObjectId(driverId)),
    DriverVehicleService.getActiveDriverVehicle(new Types.ObjectId(driverId)),
  ]);

  const kycComplete = await DriverKycService.isKycComplete(
    new Types.ObjectId(driverId),
  );

  req.rData = {
    driver,
    kyc,
    vehicle,
    status: driver?.status,
    currentStep: getCurrentStep(driver, kycComplete, vehicle, kyc),
    rejectionReason: driver?.rejectionReason || null,
    suspensionReason: driver?.suspensionReason || null,
  };

  req.msg = "success";
  next();
};

/**
 * Verify OTP - Step 2
 */
export const verifyDriverOtp = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.log("DriverAuthController => verifyDriverOtp");

  const { otp, txnId } = req.body;

  const redisKey = `DRIVER|txnId:${txnId}`;
  const redisKeys = await redis().GetKeys(redisKey);

  if (!redisKeys.length) {
    req.rCode = 0;
    req.msg = "incorrect_otp";
    return next();
  }

  const result = await redis().GetRedis<any>(redisKeys[0]);

  if (!result?.[0]) {
    req.rCode = 0;
    req.msg = "incorrect_otp";
    return next();
  }

  const otpData = result[0];
  const { mobileNumber, countryCode } = JSON.parse(otpData);

  // Master OTP check (development only)
  if (
    config.env === "development" &&
    config.auth.masterOtp &&
    String(otp) === String(config.auth.masterOtp)
  ) {
    let driver = await DriverService.getDriverByMobile(
      mobileNumber,
      countryCode,
    );

    if (!driver) {
      driver = await DriverService.createDriver({
        mobileNumber,
        countryCode,
      });
    }

    const token = helpers().createJWT({ driverId: driver._id });

    req.rData = {
      token,
      driverId: driver._id,
      status: driver.status,
      isNewDriver: !driver.fullName,
    };
    req.msg = "otp_verified";
    return next();
  }

  // Normal OTP validation
  if (otp !== otpData.otp) {
    req.rCode = 0;
    req.msg = "incorrect_otp";
    return next();
  }

  let driver = await DriverService.getDriverByMobile(mobileNumber, countryCode);

  if (!driver) {
    driver = await DriverService.createDriver({
      mobileNumber,
      countryCode,
      fullName: "",
      city: "",
      state: "",
    });
  }

  const token = helpers().createJWT({ driverId: driver._id });

  req.rData = {
    token,
    driverId: driver._id,
    status: driver.status,
    isNewDriver: !driver.fullName,
  };
  req.msg = "otp_verified";
  next();
};

/**
 * Update Personal Info - Step 3
 */
export const updatePersonalInfo = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.log("DriverAuthController => updatePersonalInfo");

  const driverId = (req as any).driverId;
  const { fullName, email, gender, dob, city, state, bloodGroup } = req.body;

  const driver = await DriverService.updateDriver(driverId, {
    fullName,
    email,
    gender,
    dob,
    city,
    state,
    bloodGroup,
  });

  req.rData = driver;
  req.msg = "personal_info_updated";
  next();
};

/**
 * Upload KYC Documents - Step 4
 */
export const uploadKycDocuments = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.log("DriverAuthController => uploadKycDocuments");

  const driverId = (req as any).driverId;
  const kycData = req.body;

  const kyc = await DriverKycService.upsertDriverKyc(
    new Types.ObjectId(driverId),
    kycData,
  );

  // Check if KYC is complete
  const isComplete = await DriverKycService.isKycComplete(
    new Types.ObjectId(driverId),
  );

  if (isComplete) {
    await DriverService.updateDriverStatus(driverId, "documents_uploaded");
  }

  req.rData = { kyc, isComplete };
  req.msg = "kyc_documents_uploaded";
  next();
};

/**
 * Upload Aadhaar Card
 */
export const uploadAadhaar = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { aadhaarNumber } = req.body;

    const files = req.files as {
      frontImage?: Express.Multer.File[];
      backImage?: Express.Multer.File[];
    };

    if (!files?.frontImage?.length) {
      req.rCode = 0;
      req.msg = "aadhaar_images_required";
      return next();
    }

    // ✅ Upload front image to S3
    const frontUpload = await fileUploadService.uploadMultipleFilesToAws(
      files.frontImage,
    );

    const frontImageUrl = frontUpload.images[0];
    let backImageUrl = "";

    // ✅ Upload back image to S3 (optional)
    if (files?.backImage?.length) {
      const backUpload = await fileUploadService.uploadMultipleFilesToAws(
        files.backImage,
      );
      backImageUrl = backUpload.images[0];
    }

    // ✅ Save S3 URLs in DB
    const kyc = await DriverKycService.upsertDriverKyc(
      new Types.ObjectId(driverId),
      {
        aadhaar: {
          number: aadhaarNumber || "",
          frontImage: frontImageUrl,
          backImage: backImageUrl,
        },
      },
    );

    req.rData = kyc;
    req.msg = "aadhaar_uploaded";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Upload PAN Card
 */
export const uploadPan = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { panNumber } = req.body;

    const files = req.files as {
      frontImage?: Express.Multer.File[];
      backImage?: Express.Multer.File[];
    };

    if (!files?.frontImage?.length) {
      req.rCode = 0;
      req.msg = "pan_front_image_required";
      return next();
    }

    const [frontUpload, backUpload] = await Promise.all([
      fileUploadService.uploadMultipleFilesToAws(files.frontImage),
      files.backImage
        ? fileUploadService.uploadMultipleFilesToAws(files.backImage)
        : Promise.resolve({ images: [] as string[] }),
    ]);

    const frontImageUrl = frontUpload.images[0];
    const backImageUrl = backUpload.images[0] || "";

    if (!frontImageUrl) {
      throw new Error("PAN front image upload failed");
    }

    const kyc = await DriverKycService.upsertDriverKyc(
      new Types.ObjectId(driverId),
      {
        pan: {
          number: panNumber || "",
          frontImage: frontImageUrl,
          backImage: backImageUrl,
        },
      },
    );

    req.rData = kyc;
    req.msg = "pan_uploaded";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Upload Driving License
 */
export const uploadDrivingLicense = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { licenseNumber, expiryDate } = req.body;

    const files = req.files as {
      frontImage?: Express.Multer.File[];
      backImage?: Express.Multer.File[];
    };

    if (!files?.frontImage?.length || !files?.backImage?.length) {
      req.rCode = 0;
      req.msg = "license_images_required";
      return next();
    }

    const [frontUpload, backUpload] = await Promise.all([
      fileUploadService.uploadMultipleFilesToAws(files.frontImage),
      fileUploadService.uploadMultipleFilesToAws(files.backImage),
    ]);

    const frontImageUrl = frontUpload.images[0];
    const backImageUrl = backUpload.images[0];

    if (!frontImageUrl || !backImageUrl) {
      throw new Error("Driving license upload failed");
    }

    const kyc = await DriverKycService.upsertDriverKyc(
      new Types.ObjectId(driverId),
      {
        drivingLicense: {
          number: licenseNumber,
          expiryDate,
          frontImage: frontImageUrl,
          backImage: backImageUrl,
        },
        status: "documents_uploaded",
      },
    );

    // If vehicleId is provided, update the Vehicle record with assigned driver info
    const { vehicleId, driverName, driverPhone } = req.body;
    let vehicle = null;
    if (vehicleId) {
      vehicle = await VehicleModel.findOneAndUpdate(
        { _id: vehicleId, driverId: new Types.ObjectId(driverId) },
        {
          assignedDriverName: driverName || "",
          assignedDriverPhone: driverPhone || "",
          assignedDriverLicenseFrontImage: frontImageUrl,
          assignedDriverLicenseBackImage: backImageUrl,
        },
        { new: true },
      );
    }

    // Update driver status to vehicle_added
    await DriverService.updateDriverStatus(driverId, "vehicle_added");

    req.rData = { kyc, vehicle };
    req.msg = "driving_license_uploaded";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Upload Selfie
 */
export const uploadSelfie = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    const files = req.files as {
      selfieImage?: Express.Multer.File[];
    };

    if (!files?.selfieImage?.length) {
      req.rCode = 0;
      req.msg = "selfie_required";
      return next();
    }

    const upload = await fileUploadService.uploadFileToAws(files.selfieImage);

    const selfieUrl = upload.images;

    if (!selfieUrl) {
      throw new Error("Selfie upload failed");
    }

    const kyc = await DriverKycService.upsertDriverKyc(
      new Types.ObjectId(driverId),
      { selfie: selfieUrl },
    );

    // Also set as profile photo
    await DriverService.updateDriver(driverId, { profilePhoto: selfieUrl });

    req.rData = kyc;
    req.msg = "selfie_uploaded";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Upload Owner Details - Combined (Aadhaar + PAN + Selfie + Name)
 * Single API for Step 1 of onboarding
 */
export const uploadOwnerDetails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;
    const { ownerName } = req.body;

    const files = req.files as {
      aadhaarFrontImage?: Express.Multer.File[];
      aadhaarBackImage?: Express.Multer.File[];
      panImage?: Express.Multer.File[];
      selfieImage?: Express.Multer.File[];
    };

    // Validate required fields
    if (!ownerName || !ownerName.trim()) {
      req.rCode = 0;
      req.msg = "owner_name_required";
      return next();
    }

    if (!files?.aadhaarFrontImage?.length) {
      req.rCode = 0;
      req.msg = "aadhaar_front_image_required";
      return next();
    }

    if (!files?.aadhaarBackImage?.length) {
      req.rCode = 0;
      req.msg = "aadhaar_back_image_required";
      return next();
    }

    if (!files?.panImage?.length) {
      req.rCode = 0;
      req.msg = "pan_front_image_required";
      return next();
    }

    if (!files?.selfieImage?.length) {
      req.rCode = 0;
      req.msg = "selfie_required";
      return next();
    }

    // Upload all images to S3 in parallel
    const [aadhaarFrontUpload, aadhaarBackUpload, panUpload, selfieUpload] = await Promise.all([
      fileUploadService.uploadFileToAws(files.aadhaarFrontImage),
      fileUploadService.uploadFileToAws(files.aadhaarBackImage),
      fileUploadService.uploadMultipleFilesToAws(files.panImage),
      fileUploadService.uploadFileToAws(files.selfieImage),
    ]);

    const aadhaarFrontUrl = aadhaarFrontUpload.images;
    const aadhaarBackUrl = aadhaarBackUpload.images;
    const panImageUrl = panUpload.images[0];
    const selfieUrl = selfieUpload.images;

    if (!aadhaarFrontUrl || !aadhaarBackUrl || !panImageUrl || !selfieUrl) {
      throw new Error("One or more file uploads failed");
    }

    // Update driver name and set selfie as profile photo
    await DriverService.updateDriver(driverId, {
      fullName: ownerName.trim(),
      profilePhoto: selfieUrl,
    });

    // Save all KYC documents in one upsert
    const kyc = await DriverKycService.upsertDriverKyc(
      new Types.ObjectId(driverId),
      {
        aadhaar: {
          number: "",
          frontImage: aadhaarFrontUrl,
          backImage: aadhaarBackUrl,
        },
        pan: {
          number: "",
          frontImage: panImageUrl,
        },
        selfie: selfieUrl,
      },
    );

    req.rData = kyc;
    req.msg = "owner_details_uploaded";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Upload RC (Registration Certificate)
 */
export const uploadRC = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const driverId = (req as any).driverId;

    // Handle upload.any() - files come as an array with fieldname property
    let rcFrontFile: Express.Multer.File | undefined;
    let rcBackFile: Express.Multer.File | undefined;

    if (Array.isArray(req.files)) {
      for (const file of req.files) {
        if (file.fieldname === "rcFrontImage" || file.fieldname === "rcImage") {
          rcFrontFile = file;
        } else if (file.fieldname === "rcBackImage") {
          rcBackFile = file;
        }
      }
      // Fallback: if no rcFrontImage found, use first file as RC front
      if (!rcFrontFile && req.files.length > 0) {
        rcFrontFile = req.files[0];
      }
    } else if (req.files) {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      rcFrontFile = files?.rcFrontImage?.[0] || files?.rcImage?.[0];
      rcBackFile = files?.rcBackImage?.[0];
    } else if (req.file) {
      rcFrontFile = req.file;
    }

    if (!rcFrontFile) {
      req.rCode = 0;
      req.msg = "rc_front_image_required";
      return next();
    }

    // Upload RC images to AWS in parallel
    const uploads = await Promise.all([
      fileUploadService.uploadFileToAws([rcFrontFile]),
      rcBackFile ? fileUploadService.uploadFileToAws([rcBackFile]) : Promise.resolve(null),
    ]);

    const rcFrontUrl = uploads[0].images;
    const rcBackUrl = uploads[1]?.images || "";

    if (!rcFrontUrl) {
      throw new Error("RC front upload failed");
    }

    const kyc = await DriverKycService.upsertDriverKyc(
      new Types.ObjectId(driverId),
      {
        vehicleRc: {
          image: rcFrontUrl,
          vehicleNumber: req.body.vehicleNumber,
        },
        ...(req.body.city && { city: req.body.city }),
        ...(req.body.bodyType && { bodyType: req.body.bodyType }),
        ...(req.body.fuelType && { fuelType: req.body.fuelType }),
      },
    );

    // Also create a Vehicle record for multi-vehicle support
    const vehicleTypeMap: Record<string, string> = {
      "2 Wheeler": "2W", "3 Wheeler": "3W", "4 Wheeler": "4W",
      "2W": "2W", "3W": "3W", "4W": "4W",
    };
    const rawType = req.body.vehicalId || "4W";
    const vehicleData: any = {
      driverId: new Types.ObjectId(driverId),
      vehicleNumber: req.body.vehicleNumber,
      vehicleType: vehicleTypeMap[rawType] || "4W",
      rcFrontImage: rcFrontUrl,
      rcBackImage: rcBackUrl,
      isPrimary: true,
      isActive: true,
    };
    if (req.body.bodyType) vehicleData.vehicleBodyType = req.body.bodyType;
    if (req.body.fuelType) vehicleData.fuelType = req.body.fuelType;
    if (req.body.city) vehicleData.city = req.body.city;

    const vehicle = await new VehicleModel(vehicleData).save();

    // Tie the vehicle to the admin catalog so dispatch can match it. Dispatch
    // filters candidates via DriverVehicle.vehicleTypeId (findNearbyDrivers
    // hard-skips drivers without a matching row); the legacy VehicleModel row
    // above only stores a coarse "2W/3W/4W" string that dispatch never reads.
    // Optional for backward compat with app builds that don't send it yet.
    const rawVehicleTypeId = req.body.vehicleTypeId;
    if (rawVehicleTypeId && Types.ObjectId.isValid(rawVehicleTypeId)) {
      const catalogType = await VehicleType.findOne({
        _id: rawVehicleTypeId,
        isActive: true,
        isDeleted: false,
      }).select("_id");

      if (catalogType) {
        // Record the catalog type on the vehicle itself as well. It used to be
        // used here and then thrown away, so the Vehicle row only remembered
        // "2W"/"3W" — which meant nothing downstream (admin approval included)
        // could ever rebuild the dispatch link if it went missing.
        vehicle.vehicleTypeId = catalogType._id as Types.ObjectId;
        await vehicle.save();

        // Upsert keyed by registration number (unique, stored uppercase) so a
        // re-submitted RC updates rather than violating the unique index.
        await DriverVehicleModel.findOneAndUpdate(
          { registrationNumber: String(req.body.vehicleNumber).toUpperCase() },
          {
            $set: {
              driverId: new Types.ObjectId(driverId),
              vehicleTypeId: catalogType._id,
              isActive: true,
              isDeleted: false,
            },
          },
          { upsert: true, new: true },
        );
      }
    } else {
      // No catalog type = this vehicle can never be matched to a booking. It
      // is accepted (older app builds don't send one) but it will sit approved
      // and never ring, so make that visible instead of silent.
      console.warn(
        `[kyc/rc] vehicle ${req.body.vehicleNumber} registered without a vehicleTypeId — it will NOT be dispatchable until one is set`,
      );
    }

    // Check if driver already has license uploaded (for "add another vehicle" flow)
    const hasLicense = !!(kyc.drivingLicense?.frontImage);

    req.rData = { kyc, vehicleId: vehicle._id, hasLicense };
    req.msg = "rc_uploaded";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Vehicle-type catalog for the driver app's Add Vehicle dropdown.
 *
 * The catalog is admin-managed (VehicleType collection); the app previously
 * hardcoded '2/3/4 Wheeler', so admin changes never reached drivers and the
 * selected type couldn't be tied to the vehicleTypeId dispatch matches on.
 */
export const getVehicleTypes = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const vehicleTypes = await VehicleType.find({
      isActive: true,
      isDeleted: false,
    })
      .select("name icon image sortOrder")
      .sort({ sortOrder: 1, name: 1 });

    req.rData = { vehicleTypes };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Add Vehicle - Step 5
 */
export const addVehicle = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.log("DriverAuthController => addVehicle");

  const driverId = (req as any).driverId;
  const {
    vehicleTypeId,
    registrationNumber,
    driverName,
    driverPhoneNumber,
    uploadDrivingLicense,
    uploadDriverPhoto,
    selectVehicleBody,
    selectVehicleModel,
  } = req.body;

  // Check if registration number already exists
  const exists =
    await DriverVehicleService.checkRegistrationExists(registrationNumber);

  if (exists) {
    req.rCode = 0;
    req.msg = "registration_number_exists";
    return next();
  }

  const vehicle = await DriverVehicleService.addDriverVehicle({
    driverId: new Types.ObjectId(driverId),
    vehicleTypeId: new Types.ObjectId(vehicleTypeId),
    registrationNumber,
  });

  // Update driver status to vehicle_added
  await DriverService.updateDriverStatus(driverId, "vehicle_added");

  req.rData = vehicle;
  req.msg = "vehicle_added";
  next();
};

/**
 * Submit for Verification - Final Step
 */
export const submitForVerification = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.log("DriverAuthController => submitForVerification");

  const driverId = (req as any).driverId;

  // Check if all requirements are met
  const driver = await DriverService.getDriverById(driverId);
  const kycComplete = await DriverKycService.isKycComplete(
    new Types.ObjectId(driverId),
  );
  const vehicle = await DriverVehicleService.getActiveDriverVehicle(
    new Types.ObjectId(driverId),
  );

  if (!driver?.fullName) {
    req.rCode = 0;
    req.msg = "personal_info_incomplete";
    return next();
  }

  if (!kycComplete) {
    req.rCode = 0;
    req.msg = "kyc_incomplete";
    return next();
  }

  if (!vehicle) {
    req.rCode = 0;
    req.msg = "vehicle_not_added";
    return next();
  }

  // Update status to under_verification
  await DriverService.updateDriverStatus(driverId, "under_verification");

  req.rData = { status: "under_verification" };
  req.msg = "submitted_for_verification";
  next();
};

/**
 * Get Driver Onboarding Status
 */
export const getOnboardingStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.log("DriverAuthController => getOnboardingStatus");

  const driverId = (req as any).driverId;

  const driver = await DriverService.getDriverById(driverId);
  const kyc = await DriverKycService.getDriverKyc(new Types.ObjectId(driverId));
  const vehicle = await DriverVehicleService.getActiveDriverVehicle(
    new Types.ObjectId(driverId),
  );

  const kycComplete = await DriverKycService.isKycComplete(
    new Types.ObjectId(driverId),
  );

  // Check vehicles from Vehicle model for multi-vehicle support
  const vehicles = await VehicleModel.find({
    driverId: new Types.ObjectId(driverId),
    isDeleted: { $ne: true },
  }).lean();

  req.rData = {
    driver,
    kyc,
    vehicle,
    kycComplete,
    vehicles,
    currentStep: getCurrentStep(driver, kycComplete, vehicle, kyc, vehicles),
  };
  req.msg = "success";
  next();
};

/**
 * Helper function to determine current onboarding step
 */
function getCurrentStep(
  driver: any,
  kycComplete: boolean,
  vehicle: any,
  kyc?: any,
  vehicles?: any[],
): string {
  // If driver already paid and is under verification / active / approved,
  // trust the status — don't re-check individual onboarding steps.
  const terminalStatuses = ["under_verification", "active", "approved", "suspended"];
  if (terminalStatuses.includes(driver?.status) && driver?.onboardingFeePaid) {
    return driver.status;
  }

  // Step 1: Owner details — name + aadhaar front + PAN front + selfie
  if (!driver?.fullName) return "personal_info";

  const ownerDetailsComplete = !!(
    kyc?.aadhaar?.frontImage &&
    kyc?.aadhaar?.backImage &&
    kyc?.pan?.frontImage &&
    kyc?.selfie
  );
  if (!ownerDetailsComplete) return "personal_info";

  // Step 2: Vehicle details — RC, vehicle images, etc.
  if (!vehicle && (!vehicles || vehicles.length === 0)) return "vehicle_info";

  // Step 3: Driver details — driving license
  const hasLicense = !!(kyc?.drivingLicense?.frontImage);
  if (!hasLicense) return "driver_details";

  // Step 4: My Vehicles — payment pending
  if (vehicles && vehicles.length > 0) {
    const allPaid = vehicles.every((v: any) => v.onboardingFeePaid);
    if (!allPaid) return "my_vehicles";
  }

  // All onboarding steps done but status not yet updated
  if (driver.status === "vehicle_added" || driver.status === "draft" || driver.status === "documents_uploaded") {
    return "my_vehicles";
  }
  return driver.status;
}

/**
 * Resend OTP
 */
export const resendDriverOtp = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.log("DriverAuthController => resendDriverOtp");

  const { mobileNumber, countryCode = "+91" } = req.body;

  const otp = helpers().generateOTP();
  const newTxnId = randomUUID();

  const otpData = {
    txnId: newTxnId,
    mobileNumber,
    countryCode,
    otp,
    reason: "DRIVER OTP RESEND",
    is_active: 1,
    date_created: new Date(),
    date_modified: new Date(),
  };

  await redis().SetRedis(
    `DRIVER|txnId:${newTxnId}`,
    JSON.stringify(otpData),
    600,
  );
  await redis().SetRedis(
    `DRIVER|Mob:${mobileNumber}`,
    JSON.stringify(otpData),
    600,
  );

  const driver = await DriverService.getDriverByMobile(
    mobileNumber,
    countryCode,
  );

  req.rData = {
    driverRegistered: !!driver,
    txnId: newTxnId,
  };

  req.msg = "otp_sent";
  next();
};

/**
 * Driver Logout
 */
export const driverLogout = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.log("DriverAuthController => driverLogout");

  const driverId = (req as any).driverId;

  // Offline, and drop the push token: a logged-out driver kept receiving ride
  // dispatch notifications on a device that could no longer accept them.
  // `fcmToken` is typed `string | undefined`, but an undefined value is dropped
  // from a Mongoose update — null is what actually clears the stored token.
  await DriverService.updateDriver(driverId, {
    isOnline: false,
    fcmToken: null,
  } as any);

  req.msg = "logout_success";
  next();
};
