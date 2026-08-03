import { Request, Response } from "express";
import { CoinPayout } from "../../models/coin-payout.model";
import * as CoinService from "../../services/coin.service";

/**
 * Customer coin→bank payout queue.
 *
 * Mirrors the manual driver payout lifecycle: PENDING → APPROVED → PAID, or
 * REJECTED at any point before PAID. There is no gateway call — an operator
 * settles out-of-band and records the UTR. The coins were already debited when
 * the customer requested the payout; REJECTED refunds them.
 */

const adminId = (req: Request) => (req as any).admin?._id;

/**
 * List payout requests, oldest pending first (that's the order to work them).
 */
export const listCoinPayouts = async (req: Request, res: Response) => {
  const { status, page = 0, limit = 20 } = req.query as any;

  const filter: Record<string, any> = {};
  if (status) filter.status = status;

  const pageNum = Math.max(0, Number(page) || 0);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));

  const [payouts, total, pendingCount] = await Promise.all([
    CoinPayout.find(filter)
      .populate("userId", "name phone email")
      .sort({ status: 1, createdAt: 1 })
      .skip(pageNum * limitNum)
      .limit(limitNum),
    CoinPayout.countDocuments(filter),
    CoinPayout.countDocuments({ status: "PENDING" }),
  ]);

  res.locals.data = { payouts, total, pendingCount, page: pageNum };
};

/**
 * Approve a request — clears it for payment, does not move money.
 */
export const approveCoinPayout = async (req: Request, res: Response) => {
  const payout = await CoinPayout.findById(req.params.id);
  if (!payout) {
    return res.status(404).json({ success: false, message: "Payout not found" });
  }
  if (payout.status !== "PENDING") {
    return res.status(400).json({
      success: false,
      message: `Only PENDING payouts can be approved (this one is ${payout.status})`,
    });
  }

  payout.status = "APPROVED";
  payout.approvedBy = adminId(req);
  payout.approvedAt = new Date();
  await payout.save();

  res.locals.data = { message: "Payout approved", payout };
};

/**
 * Mark an approved request as paid, recording the UTR of the real transfer.
 */
export const markCoinPayoutPaid = async (req: Request, res: Response) => {
  const { reference } = req.body;

  if (!reference || !String(reference).trim()) {
    return res.status(400).json({
      success: false,
      message: "A payment reference (UTR) is required to mark a payout paid",
    });
  }

  const payout = await CoinPayout.findById(req.params.id);
  if (!payout) {
    return res.status(404).json({ success: false, message: "Payout not found" });
  }
  if (payout.status !== "APPROVED") {
    return res.status(400).json({
      success: false,
      message: `Only APPROVED payouts can be marked paid (this one is ${payout.status})`,
    });
  }

  // Four eyes on money out, same rule as driver payouts: whoever approved the
  // request cannot also be the one who records it as paid.
  if (String(payout.approvedBy) === String(adminId(req))) {
    return res.status(400).json({
      success: false,
      message:
        "You approved this payout, so a different admin must mark it paid.",
    });
  }

  payout.status = "PAID";
  payout.reference = String(reference).trim();
  payout.paidBy = adminId(req);
  payout.paidAt = new Date();
  await payout.save();

  res.locals.data = { message: "Payout marked paid", payout };
};

/**
 * Reject a request and give the customer their coins back.
 *
 * The refund is the whole point of this endpoint: the coins were debited at
 * request time, so a rejection that only flipped the status would leave the
 * customer permanently short.
 */
export const rejectCoinPayout = async (req: Request, res: Response) => {
  const { reason } = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({
      success: false,
      message: "A rejection reason is required",
    });
  }

  const payout = await CoinPayout.findById(req.params.id);
  if (!payout) {
    return res.status(404).json({ success: false, message: "Payout not found" });
  }
  if (payout.status === "PAID") {
    return res.status(400).json({
      success: false,
      message: "A paid payout cannot be rejected",
    });
  }
  if (payout.status === "REJECTED") {
    return res.status(400).json({
      success: false,
      message: "Payout is already rejected",
    });
  }

  // Refund first, then mark rejected. If the refund throws, the request stays
  // in its current state and can be retried — the alternative order could mark
  // it REJECTED with the coins never returned, and nothing would retry it.
  await CoinService.refundCoinPayout(
    payout.userId,
    payout.coins,
    String(reason).trim(),
  );

  payout.status = "REJECTED";
  payout.rejectionReason = String(reason).trim();
  payout.rejectedBy = adminId(req);
  payout.rejectedAt = new Date();
  await payout.save();

  res.locals.data = {
    message: `Payout rejected — ${payout.coins} coins refunded`,
    payout,
  };
};
