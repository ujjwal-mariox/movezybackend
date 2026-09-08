import mongoose, { Schema, Types } from "mongoose";

/**
 * Predefined chat lines for the in-trip chat — one list for drivers, one for
 * customers. Admin-managed; the apps show them as tap-to-send chips above the
 * message box.
 */
export interface IChatQuickReply {
  _id?: Types.ObjectId;
  audience: "DRIVER" | "USER";
  text: string;
  sortOrder: number;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const ChatQuickReplySchema = new Schema<IChatQuickReply>(
  {
    audience: { type: String, enum: ["DRIVER", "USER"], required: true, index: true },
    text: { type: String, required: true, trim: true, maxlength: 160 },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

ChatQuickReplySchema.index({ audience: 1, text: 1 }, { unique: true });

const ChatQuickReply = mongoose.model<IChatQuickReply>("ChatQuickReply", ChatQuickReplySchema);
export default ChatQuickReply;

export const DEFAULT_QUICK_REPLIES: Record<"DRIVER" | "USER", string[]> = {
  DRIVER: [
    "I'm on my way to the pickup.",
    "I've reached the pickup point.",
    "Please share the exact location or a landmark.",
    "Stuck in traffic — 5 to 10 minutes more.",
    "Which floor should I come to?",
    "Is there parking near the pickup?",
    "Please keep the goods ready at the gate.",
    "Goods delivered. Please confirm.",
  ],
  USER: [
    "Are you coming?",
    "I am waiting at the pickup point.",
    "Where are you right now?",
    "How long will you take to reach?",
    "Please call me when you arrive.",
    "Please handle the items carefully.",
    "The building has a lift.",
    "Please deliver to the security gate.",
    "I'll be a few minutes late — please wait.",
    "Please share your vehicle number.",
  ],
};

/** Idempotent: inserts any default line that is missing, never edits existing rows. */
export const seedChatQuickReplies = async (): Promise<number> => {
  let inserted = 0;
  for (const audience of ["DRIVER", "USER"] as const) {
    const lines = DEFAULT_QUICK_REPLIES[audience];
    for (let i = 0; i < lines.length; i++) {
      const r = await ChatQuickReply.updateOne(
        { audience, text: lines[i] },
        { $setOnInsert: { audience, text: lines[i], sortOrder: (i + 1) * 10, isActive: true } },
        { upsert: true },
      );
      if (r.upsertedCount) inserted += r.upsertedCount;
    }
  }
  return inserted;
};
