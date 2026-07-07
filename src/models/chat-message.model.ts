import mongoose, { Schema, Document } from "mongoose";

export interface IChatMessage extends Document {
  bookingId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  senderType: "USER" | "DRIVER";
  messageType: "TEXT" | "IMAGE";
  message: string;
  imageUrl?: string;
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    senderType: {
      type: String,
      enum: ["USER", "DRIVER"],
      required: true,
    },
    messageType: {
      type: String,
      enum: ["TEXT", "IMAGE"],
      default: "TEXT",
    },
    message: {
      type: String,
      default: "",
    },
    imageUrl: String,
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

ChatMessageSchema.index({ bookingId: 1, createdAt: 1 });

export default mongoose.model<IChatMessage>("ChatMessage", ChatMessageSchema);
