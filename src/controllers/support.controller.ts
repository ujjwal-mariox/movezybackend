import { Request, Response } from "express";
import { Types } from "mongoose";
import { SupportTicket, SupportMessage } from "../models/support-ticket.model";
import { FAQ } from "../models/content.model";
import { cache } from "../utils/redis.util";
import * as SupportService from "../services/support.service";

/**
 * Create a support ticket
 */
export const createTicket = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { category, subject, message, bookingId, priority } = req.body;

    if (!category || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: "Category, subject, and message are required",
      });
    }

    // Use the shared support service, which correctly sets ticketId, description
    // and type (the previous inline version set ticketNumber and omitted
    // description/ticketId, so SupportTicket validation always failed).
    const ticket = await SupportService.createTicket({
      userId,
      bookingId: bookingId ? new Types.ObjectId(bookingId) : undefined,
      category,
      subject,
      description: message,
      priority,
    });

    // Record the user's opening message on the ticket.
    const ticketMessage = await SupportService.addMessage({
      ticketId: ticket._id as Types.ObjectId,
      senderId: userId,
      senderType: "USER",
      message,
    });

    res.status(201).json({
      success: true,
      message: "Support ticket created successfully",
      data: {
        ticket,
        message: ticketMessage,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to create ticket",
    });
  }
};

/**
 * Get user's tickets
 */
export const getUserTickets = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { status, page = 1, limit = 10 } = req.query;

    const query: any = { userId };
    if (status) {
      query.status = status;
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [tickets, total] = await Promise.all([
      SupportTicket.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("bookingId", "bookingNumber"),
      SupportTicket.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        tickets,
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
      message: error.message || "Failed to fetch tickets",
    });
  }
};

/**
 * Get ticket by ID with messages
 */
export const getTicketById = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { ticketId } = req.params;

    const ticket = await SupportTicket.findOne({
      _id: ticketId,
      userId,
    }).populate(
      // Booking has nested pickup/drop objects — pickupAddress/dropoffAddress
      // don't exist, so those fields always came back empty.
      "bookingId",
      "bookingNumber pickup drop status",
    );

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    // Get messages. NOTE: SupportMessage.senderId has no ref in the schema, so
    // populating it always returned null — clients render by senderType, so we
    // just return the raw messages.
    //
    // MUST filter to the CUSTOMER channel. This fetched every message on the
    // ticket, and admin messages DEFAULT to the INTERNAL channel (support
    // service addMessage) — so private staff notes, and anything on the DRIVER
    // channel, would have been served straight to the customer.
    const messages = await SupportMessage.find({
      ticketId,
      channel: "CUSTOMER",
    }).sort({
      createdAt: 1,
    });

    res.json({
      success: true,
      data: {
        ticket,
        messages,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch ticket",
    });
  }
};

/**
 * Add message to ticket
 */
export const addMessage = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { ticketId } = req.params;
    const { message, messageType, attachments } = req.body;

    // Verify ticket belongs to user and is not closed
    const ticket = await SupportTicket.findOne({
      _id: ticketId,
      userId,
      status: { $ne: "CLOSED" },
    });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found or is closed",
      });
    }

    const ticketMessage = new SupportMessage({
      ticketId,
      senderId: userId,
      senderType: "USER",
      // Explicit: a customer's reply always belongs on the CUSTOMER channel.
      // (It matched the schema default, but the default is not the contract.)
      channel: "CUSTOMER",
      message,
      messageType: messageType || "TEXT",
      attachments,
    });

    await ticketMessage.save();

    // Update ticket's last activity
    ticket.lastMessageAt = new Date();
    if (ticket.status === "RESOLVED") {
      ticket.status = "OPEN"; // Reopen if user replies after resolution
    }
    await ticket.save();

    res.status(201).json({
      success: true,
      message: "Message sent",
      data: ticketMessage,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to send message",
    });
  }
};

/**
 * Close ticket
 */
export const closeTicket = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { ticketId } = req.params;
    const { rating, feedback } = req.body;

    const ticket = await SupportTicket.findOne({
      _id: ticketId,
      userId,
    });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    ticket.status = "CLOSED";
    ticket.closedAt = new Date();
    ticket.closedBy = userId;
    if (rating) ticket.rating = rating;
    if (feedback) ticket.feedback = feedback;
    await ticket.save();

    res.json({
      success: true,
      message: "Ticket closed",
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to close ticket",
    });
  }
};

/**
 * Get FAQs
 */
export const getFAQs = async (req: Request, res: Response) => {
  try {
    const { category } = req.query;

    // Try cache first
    const cacheKey = category ? `faqs:${category}` : "faqs:all";
    let faqs = await cache.get(cacheKey);

    if (!faqs) {
      const query: any = { isActive: true };
      if (category) {
        query.category = category;
      }

      faqs = await FAQ.find(query).sort({ sortOrder: 1, category: 1 });
      await cache.set(cacheKey, faqs, 3600); // Cache for 1 hour
    }

    res.json({
      success: true,
      data: faqs,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch FAQs",
    });
  }
};

/**
 * Record whether an FAQ answer actually helped.
 *
 * The app has always shown 👍/👎 under each answer and replied "Thanks for your
 * feedback!" — while posting nowhere at all. Now the vote is counted, so the
 * thanks is true and you can see which answers are failing customers.
 */
export const rateFAQ = async (req: Request, res: Response) => {
  try {
    const { faqId } = req.params;
    const { helpful } = req.body;

    if (typeof helpful !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "`helpful` must be true or false",
      });
    }

    const faq = await FAQ.findByIdAndUpdate(
      faqId,
      { $inc: helpful ? { helpfulCount: 1 } : { notHelpfulCount: 1 } },
      { new: true },
    ).select("helpfulCount notHelpfulCount");

    if (!faq) {
      return res.status(404).json({ success: false, message: "FAQ not found" });
    }

    // The list is cached for an hour; drop it so counts aren't served stale.
    await cache.del("faqs:all").catch(() => {});

    res.json({
      success: true,
      data: {
        helpfulCount: (faq as any).helpfulCount ?? 0,
        notHelpfulCount: (faq as any).notHelpfulCount ?? 0,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to record feedback",
    });
  }
};

/**
 * Get help topics/categories
 */
export const getHelpTopics = async (req: Request, res: Response) => {
  try {
    const topics = [
      { id: "BOOKING", name: "Booking Issues", icon: "📦" },
      { id: "PAYMENT", name: "Payment & Refunds", icon: "💳" },
      { id: "DRIVER", name: "Driver Related", icon: "🚗" },
      { id: "DELIVERY", name: "Delivery Issues", icon: "📍" },
      { id: "PROMO", name: "Promo & Offers", icon: "🎁" },
      { id: "ACCOUNT", name: "Account Settings", icon: "👤" },
      { id: "APP", name: "App Issues", icon: "📱" },
      { id: "OTHER", name: "Other", icon: "❓" },
    ];

    res.json({
      success: true,
      data: topics,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch topics",
    });
  }
};
