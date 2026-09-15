import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../models";
import { seedChatQuickReplies } from "../models/chat-quick-reply.model";
(async () => { await connectDB(); const n = await seedChatQuickReplies(); console.log(`quick replies: ${n} added`); await mongoose.disconnect(); })();
