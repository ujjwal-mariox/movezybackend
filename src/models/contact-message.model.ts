import mongoose, { Schema, Types } from "mongoose";

/**
 * A message from the website contact form. Stored first, emailed second —
 * an SMTP hiccup must never lose an enquiry.
 */
export interface IContactMessage {
  _id?: Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  subject: string;
  message: string;
  source: string;
  ip?: string;
  userAgent?: string;
  emailedToTeam: boolean;
  acknowledged: boolean;
  status: "NEW" | "REPLIED" | "CLOSED";
  createdAt?: Date;
  updatedAt?: Date;
}

const ContactMessageSchema = new Schema<IContactMessage>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 20 },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    source: { type: String, default: "website" },
    ip: String,
    userAgent: { type: String, maxlength: 300 },
    emailedToTeam: { type: Boolean, default: false },
    acknowledged: { type: Boolean, default: false },
    status: { type: String, enum: ["NEW", "REPLIED", "CLOSED"], default: "NEW", index: true },
  },
  { timestamps: true },
);

ContactMessageSchema.index({ createdAt: -1 });

const ContactMessage = mongoose.model<IContactMessage>("ContactMessage", ContactMessageSchema);
export default ContactMessage;
