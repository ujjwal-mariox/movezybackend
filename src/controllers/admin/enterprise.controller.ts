import { Request, Response } from "express";
import { Types } from "mongoose";
import * as EnterpriseService from "../../services/enterprise.service";
import { Enterprise } from "../../models/enterprise.model";
import { EnterpriseInquiry } from "../../models/enterprise-inquiry.model";
import { EnterpriseContent } from "../../models/enterprise-content.model";

/**
 * Create a new enterprise from admin panel
 */
export const createEnterprise = async (req: Request, res: Response) => {
  try {
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
      creditLimit,
      discountPercentage,
      paymentTerms,
      status,
    } = req.body;

    if (!companyName || !email || !phone || !contactPerson || !address || !city || !state || !pincode) {
      return res.status(400).json({
        success: false,
        message: "Company name, email, phone, contact person, address, city, state, and pincode are required",
      });
    }

    // Check duplicate email/gstin
    const existing = await Enterprise.findOne({
      $or: [
        { email: email.toLowerCase() },
        ...(gstin ? [{ gstin: gstin.toUpperCase() }] : []),
      ],
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Enterprise with this email or GSTIN already exists",
      });
    }

    const enterprise = await Enterprise.create({
      companyName,
      gstin: gstin?.toUpperCase(),
      email: email.toLowerCase(),
      phone,
      contactPerson,
      address,
      city,
      state,
      pincode,
      status: status || "PENDING",
      creditLimit: creditLimit || 0,
      usedCredit: 0,
      discountPercentage: discountPercentage || 0,
      paymentTerms: paymentTerms || 30,
      isActive: status === "APPROVED",
    });

    res.status(201).json({
      success: true,
      message: "Enterprise created successfully",
      data: enterprise,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to create enterprise",
    });
  }
};

/**
 * Update enterprise from admin panel
 */
export const updateEnterpriseAdmin = async (req: Request, res: Response) => {
  try {
    const { enterpriseId } = req.params;
    const updateData = req.body;

    // Remove fields that shouldn't be updated directly
    delete updateData._id;
    delete updateData.createdAt;
    delete updateData.updatedAt;

    if (updateData.email) updateData.email = updateData.email.toLowerCase();
    if (updateData.gstin) updateData.gstin = updateData.gstin.toUpperCase();

    const enterprise = await Enterprise.findByIdAndUpdate(
      enterpriseId,
      { $set: updateData },
      { new: true },
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
 * Delete enterprise from admin panel
 */
export const deleteEnterprise = async (req: Request, res: Response) => {
  try {
    const { enterpriseId } = req.params;

    const enterprise = await Enterprise.findByIdAndDelete(enterpriseId);

    if (!enterprise) {
      return res.status(404).json({
        success: false,
        message: "Enterprise not found",
      });
    }

    res.json({
      success: true,
      message: "Enterprise deleted successfully",
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to delete enterprise",
    });
  }
};

/**
 * Get all enterprises
 */
export const getAllEnterprises = async (req: Request, res: Response) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;

    const result = await EnterpriseService.getAllEnterprises(
      {
        status: status as string,
        search: search as string,
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
      message: error.message || "Failed to fetch enterprises",
    });
  }
};

/**
 * Get enterprise by ID
 */
export const getEnterpriseById = async (req: Request, res: Response) => {
  try {
    const { enterpriseId } = req.params;

    const enterprise = await EnterpriseService.getEnterpriseById(
      new Types.ObjectId(enterpriseId),
    );

    if (!enterprise) {
      return res.status(404).json({
        success: false,
        message: "Enterprise not found",
      });
    }

    // Get additional stats
    const dashboard = await EnterpriseService.getEnterpriseDashboard(
      new Types.ObjectId(enterpriseId),
    );

    res.json({
      success: true,
      data: {
        enterprise,
        stats: dashboard.stats,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch enterprise",
    });
  }
};

/**
 * Approve enterprise
 */
export const approveEnterprise = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin._id;
    const { enterpriseId } = req.params;
    const { creditLimit, discountPercentage, paymentTerms } = req.body;

    if (!creditLimit || discountPercentage === undefined || !paymentTerms) {
      return res.status(400).json({
        success: false,
        message:
          "Credit limit, discount percentage, and payment terms are required",
      });
    }

    const enterprise = await EnterpriseService.approveEnterprise(
      new Types.ObjectId(enterpriseId),
      adminId,
      creditLimit,
      discountPercentage,
      paymentTerms,
    );

    if (!enterprise) {
      return res.status(404).json({
        success: false,
        message: "Enterprise not found",
      });
    }

    res.json({
      success: true,
      message: "Enterprise approved successfully",
      data: enterprise,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to approve enterprise",
    });
  }
};

/**
 * Reject enterprise
 */
export const rejectEnterprise = async (req: Request, res: Response) => {
  try {
    const { enterpriseId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required",
      });
    }

    const enterprise = await EnterpriseService.rejectEnterprise(
      new Types.ObjectId(enterpriseId),
      reason,
    );

    if (!enterprise) {
      return res.status(404).json({
        success: false,
        message: "Enterprise not found",
      });
    }

    res.json({
      success: true,
      message: "Enterprise rejected",
      data: enterprise,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to reject enterprise",
    });
  }
};

/**
 * Suspend enterprise
 */
export const suspendEnterprise = async (req: Request, res: Response) => {
  try {
    const { enterpriseId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Suspension reason is required",
      });
    }

    const enterprise = await EnterpriseService.suspendEnterprise(
      new Types.ObjectId(enterpriseId),
      reason,
    );

    if (!enterprise) {
      return res.status(404).json({
        success: false,
        message: "Enterprise not found",
      });
    }

    res.json({
      success: true,
      message: "Enterprise suspended",
      data: enterprise,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to suspend enterprise",
    });
  }
};

/**
 * Update enterprise credit limit
 */
export const updateCreditLimit = async (req: Request, res: Response) => {
  try {
    const { enterpriseId } = req.params;
    const { creditLimit } = req.body;

    if (!creditLimit) {
      return res.status(400).json({
        success: false,
        message: "Credit limit is required",
      });
    }

    const enterprise = await EnterpriseService.updateCreditLimit(
      new Types.ObjectId(enterpriseId),
      creditLimit,
    );

    if (!enterprise) {
      return res.status(404).json({
        success: false,
        message: "Enterprise not found",
      });
    }

    res.json({
      success: true,
      message: "Credit limit updated",
      data: enterprise,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to update credit limit",
    });
  }
};

/**
 * Get enterprise users
 */
export const getEnterpriseUsers = async (req: Request, res: Response) => {
  try {
    const { enterpriseId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const result = await EnterpriseService.getEnterpriseUsers(
      new Types.ObjectId(enterpriseId),
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
 * Get enterprise bookings
 */
export const getEnterpriseBookings = async (req: Request, res: Response) => {
  try {
    const { enterpriseId } = req.params;
    const { startDate, endDate, status, page = 1, limit = 20 } = req.query;

    const result = await EnterpriseService.getEnterpriseBookings(
      new Types.ObjectId(enterpriseId),
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

// ============ ENTERPRISE INQUIRIES ============

/**
 * Get all enterprise inquiries
 */
export const getAllInquiries = async (req: Request, res: Response) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;

    const filter: any = {};
    if (status && status !== "ALL") filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { companyName: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [inquiries, total] = await Promise.all([
      EnterpriseInquiry.find(filter)
        .populate("userId", "fullName mobileNumber email profileImage")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      EnterpriseInquiry.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        inquiries,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch inquiries",
    });
  }
};

/**
 * Update inquiry status
 */
export const updateInquiryStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    const inquiry = await EnterpriseInquiry.findByIdAndUpdate(
      id,
      { status, ...(adminNotes !== undefined && { adminNotes }) },
      { new: true },
    ).populate("userId", "fullName mobileNumber email profileImage");

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: "Inquiry not found",
      });
    }

    res.json({
      success: true,
      message: "Inquiry updated successfully",
      data: inquiry,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to update inquiry",
    });
  }
};

/**
 * Delete inquiry
 */
export const deleteInquiry = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const inquiry = await EnterpriseInquiry.findByIdAndDelete(id);

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: "Inquiry not found",
      });
    }

    res.json({
      success: true,
      message: "Inquiry deleted",
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to delete inquiry",
    });
  }
};

// ============ ENTERPRISE PAGE CONTENT ============

/**
 * Get enterprise page content
 */
export const getEnterprisePageContent = async (req: Request, res: Response) => {
  try {
    let content = await EnterpriseContent.findOne({ isActive: true });
    res.json({
      success: true,
      data: content,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch content",
    });
  }
};

/**
 * Update enterprise page content (upsert)
 */
export const updateEnterprisePageContent = async (
  req: Request,
  res: Response,
) => {
  try {
    const {
      heroTitle,
      heroSubtitle,
      features,
      faqs,
      clients,
      ctaText,
      ctaSubtext,
    } = req.body;

    let content = await EnterpriseContent.findOne({ isActive: true });

    if (content) {
      // Update existing
      if (heroTitle !== undefined) content.heroTitle = heroTitle;
      if (heroSubtitle !== undefined) content.heroSubtitle = heroSubtitle;
      if (features !== undefined) content.features = features;
      if (faqs !== undefined) content.faqs = faqs;
      if (clients !== undefined) content.clients = clients;
      if (ctaText !== undefined) content.ctaText = ctaText;
      if (ctaSubtext !== undefined) content.ctaSubtext = ctaSubtext;
      await content.save();
    } else {
      // Create new
      content = await EnterpriseContent.create({
        heroTitle: heroTitle || "Upgrade to Movezy Enterprise\nfor Business Logistics",
        heroSubtitle: heroSubtitle || "All these features at No Additional Charges!",
        features: features || [],
        faqs: faqs || [],
        clients: clients || [],
        ctaText: ctaText || "Get in touch!",
        ctaSubtext: ctaSubtext || "All these features at No Additional Charges!",
        isActive: true,
      });
    }

    res.json({
      success: true,
      message: "Enterprise page content updated",
      data: content,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to update content",
    });
  }
};
