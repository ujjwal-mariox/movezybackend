import { Router } from "express";
import AuthMiddleware from "../middlewares/auth.middleware";

const { verifyUserToken } = AuthMiddleware();
import * as supportController from "../controllers/support.controller";

const router = Router();

// ── PUBLIC ──
// FAQs are help copy: no user context is read by the handler and no personal
// data is returned. They sat behind verifyUserToken, which meant the DRIVER
// app could not read them at all (it holds a driver token, not a user one) —
// its FAQ screen got a 401 and silently fell back to its bundled answers, so
// admin-managed FAQs never reached drivers no matter what was published.
// Registered before the auth middleware below so it stays reachable.
router.get("/faqs", supportController.getFAQs);

// ── AUTHENTICATED (customer) ──
router.use(verifyUserToken);

// Create a support ticket
router.post("/tickets", supportController.createTicket);

// Get user's tickets
router.get("/tickets", supportController.getUserTickets);

// Get ticket by ID
router.get("/tickets/:ticketId", supportController.getTicketById);

// Add message to ticket
router.post("/tickets/:ticketId/messages", supportController.addMessage);

// Close ticket
router.post("/tickets/:ticketId/close", supportController.closeTicket);

// Was this answer helpful? The app's 👍/👎 posted nowhere before.
// Stays authenticated: it mutates counters.
router.post("/faqs/:faqId/feedback", supportController.rateFAQ);

// Get help topics/categories
router.get("/topics", supportController.getHelpTopics);

export default router;
