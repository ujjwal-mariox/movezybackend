import { Request, Response } from "express";
import * as SupportService from "../../services/support.service";
import { Types } from "mongoose";
import { emitToUser } from "../../utils/socket.util";

/**
 * Get all tickets
 */
export const getAllTickets = async (req: Request, res: Response) => {
  const {
    status,
    priority,
    category,
    type,
    escalated,
    search,
    assignedTo,
    dateFrom,
    dateTo,
    userId,
    page = 0,
    limit = 20,
  } = req.query;

  const result = await SupportService.getAllTickets(
    {
      status: status as any,
      priority: priority as any,
      category: category as string,
      type: type as any,
      escalated:
        typeof escalated === "string" ? escalated === "true" : undefined,
      search: search as string,
      assignedTo: assignedTo
        ? new Types.ObjectId(assignedTo as string)
        : undefined,
      dateFrom: dateFrom ? new Date(dateFrom as string) : undefined,
      dateTo: dateTo ? new Date(dateTo as string) : undefined,
      userId: userId ? new Types.ObjectId(userId as string) : undefined,
    },
    Number(page),
    Number(limit),
  );

  res.locals.data = result;
};

/**
 * Get ticket by ID
 */
export const getTicket = async (req: Request, res: Response) => {
  const { ticketId } = req.params;
  const { channel } = req.query;

  const ticket = await SupportService.getTicketById(ticketId);

  if (!ticket) {
    return res.status(404).json({
      success: false,
      message: "Ticket not found",
    });
  }

  const messages = await SupportService.getTicketMessages(
    ticket._id,
    channel as any,
  );

  res.locals.data = { ticket, messages };
};

/**
 * Assign ticket to admin
 */
export const assignTicket = async (req: Request, res: Response) => {
  const { ticketId } = req.params;
  const { adminId, staffName, staffRole } = req.body;

  const ticket = await SupportService.assignTicket(
    ticketId,
    new Types.ObjectId(adminId || req.adminId),
    staffName,
    staffRole,
  );

  if (!ticket) {
    return res.status(404).json({
      success: false,
      message: "Ticket not found",
    });
  }

  res.locals.data = {
    message: "Ticket assigned successfully",
    ticket,
  };
};

/**
 * Update ticket status
 */
export const updateTicketStatus = async (req: Request, res: Response) => {
  const { ticketId } = req.params;
  const { status, resolution, resolutionType } = req.body;

  const ticket = await SupportService.updateTicketStatus(
    ticketId,
    status,
    resolution,
    resolutionType,
    req.adminId ? new Types.ObjectId(req.adminId) : undefined,
  );

  if (!ticket) {
    return res.status(404).json({
      success: false,
      message: "Ticket not found",
    });
  }

  res.locals.data = {
    message: "Ticket status updated",
    ticket,
  };
};

/**
 * Escalate ticket
 */
export const escalateTicket = async (req: Request, res: Response) => {
  const { ticketId } = req.params;
  const { reason } = req.body;

  const ticket = await SupportService.escalateTicket(
    ticketId,
    reason || "Escalated by admin",
    new Types.ObjectId(req.adminId),
  );

  if (!ticket) {
    return res.status(404).json({
      success: false,
      message: "Ticket not found",
    });
  }

  res.locals.data = {
    message: "Ticket escalated",
    ticket,
  };
};

/**
 * Reply to ticket
 */
export const replyToTicket = async (req: Request, res: Response) => {
  const { ticketId } = req.params;
  const { message, attachments, channel } = req.body;

  const ticket = await SupportService.getTicketById(ticketId);

  if (!ticket) {
    return res.status(404).json({
      success: false,
      message: "Ticket not found",
    });
  }

  const driverId = (ticket as any).driverId?._id || (ticket as any).driverId;
  // Default to the channel this ticket's thread actually lives on. Blindly
  // defaulting to CUSTOMER stranded replies to driver tickets on a channel the
  // driver's read path (which filters to DRIVER) never queries.
  const replyChannel = channel || (driverId ? "DRIVER" : "CUSTOMER");
  const newMessage = await SupportService.addMessage({
    ticketId: ticket._id,
    senderId: new Types.ObjectId(req.adminId),
    senderType: "ADMIN",
    channel: replyChannel,
    message,
    attachments,
  });

  // Deliver DRIVER-channel replies to the driver app in real time. The driver
  // socket joins room `user:<driverId>` (driver token → socket.userId), so
  // emitToUser(driverId, ...) reaches them. Without this the reply was only
  // stored and the driver never saw it.
  if (replyChannel === "DRIVER" && driverId) {
    emitToUser(String(driverId), "support:message", {
      ticketId: ticket.ticketId,
      _id: newMessage._id,
      senderType: "ADMIN",
      message: newMessage.message,
      attachments: newMessage.attachments,
      createdAt: (newMessage as any).createdAt,
    });
  }

  res.locals.data = {
    message: "Reply sent successfully",
    newMessage,
  };
};

/**
 * Get support stats
 */
export const getStats = async (req: Request, res: Response) => {
  const stats = await SupportService.getTicketStats();
  const categories = SupportService.getSupportCategories();

  res.locals.data = { stats, categories };
};

/* ============================================================
   Quick Reply Templates
   ============================================================ */

export const listQuickReplies = async (req: Request, res: Response) => {
  const { type, category, search, isActive } = req.query;
  const replies = await SupportService.listQuickReplies({
    type: type as any,
    category: category as string,
    search: search as string,
    isActive: typeof isActive === "string" ? isActive === "true" : undefined,
  });
  res.locals.data = { replies };
};

export const createQuickReply = async (req: Request, res: Response) => {
  const { title, body, type, category, tags } = req.body;
  const reply = await SupportService.createQuickReply({
    title,
    body,
    type,
    category,
    tags,
    createdBy: new Types.ObjectId(req.adminId),
  });
  res.locals.data = { reply };
};

export const updateQuickReply = async (req: Request, res: Response) => {
  const { id } = req.params;
  const reply = await SupportService.updateQuickReply(id, req.body);
  if (!reply) {
    return res.status(404).json({ success: false, message: "Template not found" });
  }
  res.locals.data = { reply };
};

export const deleteQuickReply = async (req: Request, res: Response) => {
  const { id } = req.params;
  await SupportService.deleteQuickReply(id);
  res.locals.data = { message: "Template deleted" };
};

export const useQuickReply = async (req: Request, res: Response) => {
  const { id } = req.params;
  const reply = await SupportService.incrementQuickReplyUse(id);
  res.locals.data = { reply };
};
