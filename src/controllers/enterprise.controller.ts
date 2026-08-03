import { Request, Response } from "express";
import { Types } from "mongoose";
import * as EnterpriseService from "../services/enterprise.service";
import { EnterpriseInquiry } from "../models/enterprise-inquiry.model";
import { EnterpriseContent } from "../models/enterprise-content.model";
import User from "../models/Users";

/**
 * Get enterprise page content (public)
 */
export const getEnterpriseContent = async (req: Request, res: Response) => {
  try {
    let content = await EnterpriseContent.findOne({ isActive: true });

    // Return default content if none exists
    if (!content) {
      content = await EnterpriseContent.create({
        heroTitle: "Upgrade to Movezy Enterprise\nfor Business Logistics",
        heroSubtitle: "All these features at No Additional Charges!",
        features: [
          {
            icon: "gst_invoice",
            title: "Monthly GST Invoices",
            description:
              "Get a single monthly invoice and detailed report for all trips",
            sortOrder: 0,
            isActive: true,
          },
          {
            icon: "one_account",
            title: "One Account, Multi Users",
            description:
              "Manage all users under a single account – no petty-cash claims",
            sortOrder: 1,
            isActive: true,
          },
          {
            icon: "flexible_payments",
            title: "Flexible Payments",
            description:
              "Instant recharge with credit card, netbanking, UPI, and more",
            sortOrder: 2,
            isActive: true,
          },
        ],
        faqs: [
          {
            question: "How do I create an account on the app?",
            answer:
              "To create an account, open the app and tap on 'Sign Up'. Fill in your details such as name, email, and password, then tap 'Create Account'. You will receive a verification email.",
            sortOrder: 0,
            isActive: true,
          },
          {
            question: "Can I book a ride without creating an account?",
            answer:
              "No, you need to create an account before booking a ride. This ensures your trip details, payments, and support requests are linked securely to your profile.",
            sortOrder: 1,
            isActive: true,
          },
          {
            question: "How do I reset my password if I forget it?",
            answer:
              "On the login screen, tap on 'Forgot Password'. Enter your registered email address and follow the link sent to your inbox to set a new password.",
            sortOrder: 2,
            isActive: true,
          },
          {
            question: "How do I update my profile information?",
            answer:
              "Go to your Profile section from the main menu, then tap 'Edit Profile'. You can update your name, email, phone number, and profile picture from there.",
            sortOrder: 3,
            isActive: true,
          },
        ],
        // Deliberately empty. This used to seed Amazon, Samsung and ShopMart as
        // Movezy's enterprise clients and shipped them to every user who opened
        // the page. They are not customers — presenting real companies' names
        // and marks as references is false advertising, not placeholder copy.
        // Real clients belong here only once someone can name them.
        clients: [],
        ctaText: "Get in touch!",
        ctaSubtext: "All these features at No Additional Charges!",
        isActive: true,
      });
    }

    res.json({
      success: true,
      data: content,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch enterprise content",
    });
  }
};

/**
 * Submit enterprise inquiry
 */
export const submitEnterpriseInquiry = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    // The design's form lets the customer correct their name, mobile and email
    // before sending — the contact on the account is often not the person who
    // handles enterprise accounts. These were ignored and always overwritten
    // with the user record, so an edited value was silently discarded.
    const { companyName, name, phone, email, message, source } = req.body;

    // Get user details
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const trimmed = (v: any) => (typeof v === "string" ? v.trim() : "");

    // A lead with no company name is not a lead — every submission used to
    // arrive with companyName: "" because nothing ever collected it.
    if (!trimmed(companyName)) {
      return res.status(400).json({
        success: false,
        message: "Company name is required",
      });
    }

    const inquiry = await EnterpriseInquiry.create({
      userId,
      name:
        trimmed(name) || user.fullName || user.mobileNumber || "Unknown",
      phone: trimmed(phone) || user.mobileNumber || "",
      email: trimmed(email) || user.email || "",
      companyName: trimmed(companyName),
      message: trimmed(message),
      source: source || "GET_IN_TOUCH",
      status: "NEW",
    });

    res.status(201).json({
      success: true,
      message: "Thank you for your interest! Our team will contact you shortly.",
      data: {
        inquiryId: inquiry._id,
        status: inquiry.status,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to submit inquiry",
    });
  }
};

/**
 * Request enterprise account
 */
export const requestEnterpriseAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const {
      companyName,
      gstin,
      email,
      phone,
      contactPerson,
      address,
      city,
      state,
      pincode,
    } = req.body;

    if (
      !companyName ||
      !email ||
      !phone ||
      !contactPerson ||
      !address ||
      !city ||
      !state ||
      !pincode
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const enterprise = await EnterpriseService.createEnterpriseRequest(userId, {
      companyName,
      gstin,
      email,
      phone,
      contactPerson,
      address,
      city,
      state,
      pincode,
    });

    res.status(201).json({
      success: true,
      message: "Enterprise account request submitted successfully",
      data: enterprise,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to create enterprise request",
    });
  }
};

/**
 * Get user's enterprise
 */
export const getMyEnterprise = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    const result = await EnterpriseService.getUserEnterprise(userId);

    if (!result) {
      return res.status(404).json({
        success: false,
        message: "No enterprise account found",
      });
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch enterprise",
    });
  }
};

/**
 * Update enterprise details
 */
export const updateEnterprise = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { enterpriseId } = req.params;

    const enterprise = await EnterpriseService.updateEnterprise(
      new Types.ObjectId(enterpriseId),
      userId,
      req.body,
    );

    if (!enterprise) {
      return res.status(404).json({
        success: false,
        message: "Enterprise not found",
      });
    }

    res.json({
      success: true,
      message: "Enterprise updated successfully",
      data: enterprise,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to update enterprise",
    });
  }
};

/**
 * Get enterprise dashboard
 */
export const getEnterpriseDashboard = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    const userEnterprise = await EnterpriseService.getUserEnterprise(userId);
    if (!userEnterprise) {
      return res.status(404).json({
        success: false,
        message: "No enterprise account found",
      });
    }

    const dashboard = await EnterpriseService.getEnterpriseDashboard(
      (userEnterprise.enterprise as any)._id,
    );

    res.json({
      success: true,
      data: dashboard,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch dashboard",
    });
  }
};

/**
 * Get enterprise users
 */
export const getEnterpriseUsers = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { page = 1, limit = 20 } = req.query;

    const userEnterprise = await EnterpriseService.getUserEnterprise(userId);
    if (!userEnterprise) {
      return res.status(404).json({
        success: false,
        message: "No enterprise account found",
      });
    }

    const result = await EnterpriseService.getEnterpriseUsers(
      (userEnterprise.enterprise as any)._id,
      Number(page),
      Number(limit),
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch users",
    });
  }
};

/**
 * Add user to enterprise
 */
export const addEnterpriseUser = async (req: Request, res: Response) => {
  try {
    const adminUserId = (req as any).user._id;
    const { email, phone, role, permissions } = req.body;

    if (!role) {
      return res.status(400).json({
        success: false,
        message: "Role is required",
      });
    }

    const userEnterprise =
      await EnterpriseService.getUserEnterprise(adminUserId);
    if (!userEnterprise) {
      return res.status(404).json({
        success: false,
        message: "No enterprise account found",
      });
    }

    const enterpriseUser = await EnterpriseService.addEnterpriseUser(
      (userEnterprise.enterprise as any)._id,
      adminUserId,
      { email, phone, role, permissions: permissions || [] },
    );

    res.status(201).json({
      success: true,
      message: "User added to enterprise",
      data: enterpriseUser,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to add user",
    });
  }
};

/**
 * Remove user from enterprise
 */
export const removeEnterpriseUser = async (req: Request, res: Response) => {
  try {
    const adminUserId = (req as any).user._id;
    const { userId: targetUserId } = req.params;

    const userEnterprise =
      await EnterpriseService.getUserEnterprise(adminUserId);
    if (!userEnterprise) {
      return res.status(404).json({
        success: false,
        message: "No enterprise account found",
      });
    }

    const removed = await EnterpriseService.removeEnterpriseUser(
      (userEnterprise.enterprise as any)._id,
      adminUserId,
      new Types.ObjectId(targetUserId),
    );

    if (!removed) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      message: "User removed from enterprise",
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to remove user",
    });
  }
};

/**
 * Get enterprise bookings
 */
export const getEnterpriseBookings = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { startDate, endDate, status, page = 1, limit = 20 } = req.query;

    const userEnterprise = await EnterpriseService.getUserEnterprise(userId);
    if (!userEnterprise) {
      return res.status(404).json({
        success: false,
        message: "No enterprise account found",
      });
    }

    const result = await EnterpriseService.getEnterpriseBookings(
      (userEnterprise.enterprise as any)._id,
      {
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        status: status as string,
      },
      Number(page),
      Number(limit),
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch bookings",
    });
  }
};

/**
 * Create booking using enterprise credit
 */
export const createCreditBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    const userEnterprise = await EnterpriseService.getUserEnterprise(userId);
    if (!userEnterprise) {
      return res.status(404).json({
        success: false,
        message: "No enterprise account found",
      });
    }

    const booking = await EnterpriseService.createCreditBooking(
      (userEnterprise.enterprise as any)._id,
      userId,
      req.body,
    );

    res.status(201).json({
      success: true,
      message: "Booking created using enterprise credit",
      data: booking,
    });
  } catch (error: any) {
    // Rejected input (missing coordinates, credit exhausted, unsupported
    // add-ons) is the caller's to fix — reporting it as a 500 hid that.
    res.status(error?.status || 500).json({
      success: false,
      message: error.message || "Failed to create booking",
    });
  }
};
