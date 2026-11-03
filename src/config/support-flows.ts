/**
 * Guided support conversations for the two apps' Help & Support chat.
 *
 * Each tree is topic → issue → (detail →) answer. A node with `children`
 * asks `prompt` and offers its children as chips; a leaf shows `answer`, then
 * "That helped" / "Still need help". Escalating opens a support ticket that
 * carries the path, so the agent sees "Account › Can't log in › OTP not
 * received" instead of re-asking.
 *
 * After an agent replies, the customer/driver gets `followUps` chips (from the
 * leaf, else the nearest ancestor that has them, else DEFAULT_FOLLOW_UPS),
 * and the agent gets `agentReplies` as suggestions in the admin panel.
 * Typed messages always work alongside the chips.
 *
 * Text is a plain string (English) or { en, hi }; the API serves the
 * requested language and falls back to English. Edit wording here and
 * redeploy the backend — no app release needed. docs/support-flows.md is
 * generated from this file (npx ts-node -T src/scripts/support-flows-doc.ts).
 */

export type FlowText = string | { en: string; hi?: string };

export interface AgentReply {
  title: string;
  body: string;
}

export interface SupportNode {
  /** Stable id: stored on tickets, so never reuse one for a different issue. */
  id: string;
  label: FlowText;
  /** Question asked when this node is picked and it has children. */
  prompt?: FlowText;
  /** Leaf only: what the assistant answers. */
  answer?: FlowText;
  children?: SupportNode[];
  /** Ticket category (top-level nodes); children inherit it. */
  category?: string;
  /** Ticket priority when escalated from here (else derived by category). */
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  /** Connect to an agent at once, after the answer if there is one. */
  escalateNow?: boolean;
  /** Chips offered to the customer/driver after an agent replies. */
  followUps?: FlowText[];
  /** Suggested replies for the agent in the admin panel. */
  agentReplies?: AgentReply[];
}

export const DEFAULT_FOLLOW_UPS: FlowText[] = [
  "Thanks, that solved it",
  "I still need help",
  "Please call me",
];

// ─── Customer app ───────────────────────────────────────────────────────

export const CUSTOMER_FLOW: SupportNode[] = [
  {
    id: "booking",
    label: "Booking issues",
    prompt: "What's the problem with your booking?",
    category: "BOOKING",
    children: [
      {
        id: "booking.no_driver",
        label: "No driver has accepted yet",
        answer:
          "At busy times it can take a few minutes to find a partner. Keep the search open; we offer the booking to the nearest partners one by one. You can also cancel and try a different vehicle type.",
        followUps: ["It's been more than 10 minutes", "I want a different vehicle", "Please cancel my booking"],
        agentReplies: [
          { title: "Searching nearby", body: "We're still looking for a partner near your pickup. I've flagged your booking so it's offered to more partners." },
          { title: "Suggest vehicle change", body: "No partner with this vehicle type is free nearby right now. A different vehicle type may be quicker; shall I help you rebook?" },
        ],
      },
      {
        id: "booking.change",
        label: "Change pickup, drop or stops",
        answer:
          "Before pickup you can add a stop from the trip screen. To change the pickup or drop, tell us the new address and we'll update the booking with your driver.",
        followUps: ["Change the drop location", "Add a stop", "Change the pickup time"],
        agentReplies: [
          { title: "Ask for new address", body: "Sure. Please share the new address (or a landmark) and I'll update it with your driver." },
        ],
      },
      {
        id: "booking.cancel",
        label: "Cancel a booking",
        prompt: "What would you like to know?",
        children: [
          {
            id: "booking.cancel.how",
            label: "How do I cancel?",
            answer: "Open the booking from the trip screen or Booking history and tap Cancel. Pick a reason, and the app shows any cancellation charge before you confirm.",
            agentReplies: [
              { title: "Cancel steps", body: "Open the booking, tap Cancel, choose a reason and confirm. Any charge is shown before you confirm." },
            ],
          },
          {
            id: "booking.cancel.fee",
            label: "Why was I charged for cancelling?",
            answer:
              "The charge depends on the reason you pick and how far the trip had got, for example once a partner is on the way. The cancel screen shows exactly what you'll get back before you confirm.",
            followUps: ["The driver never came", "I cancelled before the driver was assigned"],
            agentReplies: [
              { title: "Fee reviewed", body: "I've checked your booking. The charge followed our cancellation policy for the reason and stage of the trip. If something else happened, tell me and I'll review it." },
              { title: "Fee reversed", body: "You're right — I've reversed the cancellation charge. It will reach your original payment method in 5–7 working days." },
            ],
          },
        ],
      },
      {
        id: "booking.scheduled",
        label: "Scheduled booking",
        prompt: "What's wrong with the scheduled booking?",
        children: [
          {
            id: "booking.scheduled.time",
            label: "Change the date or time",
            answer: "Scheduled bookings can't be moved in the app yet. Cancel it and book again for the new time, or ask us to change it.",
            agentReplies: [
              { title: "Ask new time", body: "Sure — what date and time would you like? I'll update the booking." },
            ],
          },
          {
            id: "booking.scheduled.no_driver",
            label: "No driver came for it",
            answer: "We start finding a partner 30 minutes before the scheduled time. If none was available, you won't be charged. Tell us and we'll help you rebook.",
            priority: "HIGH",
            agentReplies: [
              { title: "Apologise and rebook", body: "Sorry no partner was available at your scheduled time. You haven't been charged. Shall I help you rebook right now?" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "payment",
    label: "Payments & refunds",
    prompt: "What's the payment issue?",
    category: "PAYMENT",
    children: [
      {
        id: "payment.failed",
        label: "Money deducted, booking failed",
        answer:
          "If money left your account but no booking was made, it's refunded automatically to the original payment method. Banks usually take 5–7 working days to show it.",
        followUps: ["It's been more than 7 days", "I want to share the transaction ID"],
        agentReplies: [
          { title: "Refund in progress", body: "I can see the payment. The refund has been initiated and should reach your account within 5–7 working days." },
          { title: "Ask transaction ID", body: "Please share the transaction ID or UTR from your bank/UPI app so I can trace the payment." },
        ],
      },
      {
        id: "payment.refund_status",
        label: "Where is my refund?",
        answer:
          "Refunds go back to the original payment method. Card and UPI refunds usually take 5–7 working days after we process them. You'll see the status on the booking in Booking history.",
        followUps: ["It's been more than 7 days", "I haven't received a refund"],
        agentReplies: [
          { title: "Refund processed", body: "Your refund was processed on our side. Banks usually take 5–7 working days to show it." },
        ],
      },
      {
        id: "payment.fare",
        label: "Charged more than the estimate",
        answer:
          "The final fare can change with waiting time beyond the free minutes, extra stops, tolls or parking. Open the booking and check its Fare breakup to see each charge.",
        followUps: ["The breakup looks wrong", "I was charged for waiting I didn't cause"],
        agentReplies: [
          { title: "Explain breakup", body: "I've checked your fare. The extra came from the charges listed in the Fare breakup. Is there one that looks wrong?" },
          { title: "Waiting charge reviewed", body: "I've reviewed the waiting time on your trip and adjusted the charge. The difference will be refunded in 5–7 working days." },
        ],
      },
      {
        id: "payment.wallet",
        label: "Wallet or Movezy Coins",
        prompt: "What's wrong with your wallet?",
        children: [
          {
            id: "payment.wallet.topup",
            label: "Added money but it's not in my wallet",
            answer: "Wallet top-ups usually show within a few minutes. If money was deducted and it still isn't there, it's refunded automatically in 5–7 working days, or tell us and we'll check.",
            agentReplies: [
              { title: "Wallet credited", body: "I've checked and credited the amount to your wallet. Please reopen the app to see it." },
            ],
          },
          {
            id: "payment.wallet.coins",
            label: "Coins not credited",
            answer: "Coins are credited after a trip is completed and appear in Movezy Rewards. They can take a few minutes after the trip ends.",
            agentReplies: [
              { title: "Coins added", body: "I've added the missing coins to your account." },
            ],
          },
        ],
      },
      {
        id: "payment.invoice",
        label: "Invoice or GST bill",
        answer:
          "Open the booking in Booking history to download its invoice. To get your GSTIN on invoices, add it in Profile before booking.",
        agentReplies: [
          { title: "Invoice resent", body: "I've generated the invoice again. You'll find it on the booking in Booking history." },
        ],
      },
    ],
  },
  {
    id: "driver",
    label: "Driver or delivery problem",
    prompt: "What happened?",
    category: "DRIVER",
    children: [
      {
        id: "driver.late",
        label: "Driver is late or not moving",
        answer: "You can track your driver live on the trip screen and call or chat with them from there. If they still aren't moving, tell us and we'll contact them.",
        followUps: ["The driver isn't answering", "I want to cancel"],
        agentReplies: [
          { title: "Contacting driver", body: "I'm contacting your driver now and will update you here in a moment." },
        ],
      },
      {
        id: "driver.extra_money",
        label: "Driver asked for extra money",
        answer: "Please pay only the amount shown in the app, and don't pay extra in cash. Tell us what happened and we'll take it up with the partner.",
        priority: "HIGH",
        agentReplies: [
          { title: "Do not pay extra", body: "Please don't pay anything beyond the in-app fare. I've reported this to our partner team and we'll follow up with the driver." },
        ],
      },
      {
        id: "driver.behaviour",
        label: "Driver behaviour",
        answer: "We're sorry. Tell us what happened and we'll take it up with the partner. If you ever feel unsafe, use the SOS button on the trip screen or call 112.",
        priority: "HIGH",
        agentReplies: [
          { title: "Acknowledge complaint", body: "I'm sorry this happened. Thank you for telling us — I've raised it with our partner team, and we take it seriously." },
        ],
      },
      {
        id: "driver.damage",
        label: "Goods damaged or missing",
        answer: "We're sorry. Please share photos of the damage and a short description; our team will look into it with the partner.",
        priority: "HIGH",
        followUps: ["I'll share photos", "Something is missing"],
        agentReplies: [
          { title: "Ask for photos", body: "I'm sorry about this. Please share photos of the goods and the packaging so we can investigate with the partner." },
        ],
      },
      {
        id: "driver.otp",
        label: "Problem with the delivery OTP",
        answer: "The drop OTP is shown on your trip screen; share it with the driver only when your goods have arrived. If it isn't working, tell us and we'll help complete the trip.",
        agentReplies: [
          { title: "Help complete trip", body: "I can see the trip. Please confirm your goods have been delivered and I'll help close it." },
        ],
      },
    ],
  },
  {
    id: "account",
    label: "Account",
    prompt: "What do you need help with?",
    category: "ACCOUNT",
    children: [
      {
        id: "account.login",
        label: "Can't log in",
        prompt: "What happens when you try?",
        children: [
          {
            id: "account.login.otp",
            label: "OTP not received",
            answer: "Check the number is right, wait 60 seconds and tap Resend. Make sure you have network coverage; OTPs aren't blocked by DND.",
            followUps: ["Still no OTP", "I've changed my number"],
            agentReplies: [
              { title: "OTP checks", body: "Please confirm the number you're entering. I can see the OTP requests; try once more and let me know if it arrives." },
            ],
          },
          {
            id: "account.login.blocked",
            label: "My account is blocked",
            answer: "Accounts are blocked only for safety or policy reasons. Ask an agent and we'll review it.",
            agentReplies: [
              { title: "Reviewing block", body: "I'm checking your account status now. I'll update you here once it's reviewed." },
            ],
          },
        ],
      },
      {
        id: "account.phone",
        label: "Change my phone number",
        answer: "For your security, phone numbers are changed through support. Tell us your current and new number.",
        agentReplies: [
          { title: "Verify ownership", body: "To change the number, please share your registered email or a recent booking ID so I can confirm it's your account." },
        ],
      },
      {
        id: "account.profile",
        label: "Update name or email",
        answer: "Go to Profile and tap Edit profile to change your name or email.",
      },
      {
        id: "account.delete",
        label: "Delete my account",
        answer: "Go to Profile → Delete account. You're signed out at once, and you can keep the account by signing in again within 30 days.",
      },
    ],
  },
  {
    id: "app",
    label: "App problems",
    prompt: "What's not working?",
    category: "APP",
    children: [
      {
        id: "app.crash",
        label: "App crashes or freezes",
        answer: "Update Movezy to the latest version from the Play Store, then restart your phone. If it still happens, tell us your phone model.",
        followUps: ["It still crashes", "I'm on the latest version"],
        agentReplies: [
          { title: "Ask device details", body: "Thanks. Which phone model and Android version are you using, and on which screen does it happen?" },
        ],
      },
      {
        id: "app.location",
        label: "Location or map not working",
        answer: "Turn on location, and allow Movezy to use it in your phone's Settings → Apps → Movezy → Permissions.",
      },
      {
        id: "app.notifications",
        label: "Not getting notifications",
        answer: "Allow notifications for Movezy in your phone's settings, and keep the app updated.",
      },
    ],
  },
  {
    id: "other",
    label: "Something else",
    answer: "No problem — tell us what you need and our team will help.",
    category: "OTHER",
    escalateNow: true,
  },
];

// ─── Partner (driver) app ───────────────────────────────────────────────

export const DRIVER_FLOW: SupportNode[] = [
  {
    id: "emergency",
    label: "Emergency",
    answer: "Connecting you to our safety team now. If anyone is in danger, call 112.",
    category: "EMERGENCY",
    priority: "URGENT",
    escalateNow: true,
    agentReplies: [
      { title: "Safety check", body: "We're with you. Are you safe right now? Share your location if you can, and call 112 if anyone is in danger." },
    ],
  },
  {
    id: "earnings",
    label: "Earnings & payouts",
    prompt: "What's the issue with your earnings?",
    category: "PAYMENT",
    children: [
      {
        id: "earnings.payout",
        label: "Payout not received",
        answer: "Payouts are sent after the Movezy team approves them; bank transfers can then take 1–2 working days. Check the payout status in My wallet.",
        followUps: ["It's been more than 2 days", "My bank details are wrong"],
        agentReplies: [
          { title: "Payout status", body: "I've checked your payout. It's approved and should reach your bank within 1–2 working days." },
          { title: "Payout sent", body: "Your payout has been sent. Please check your bank statement; share the date if you can't see it." },
        ],
      },
      {
        id: "earnings.trip",
        label: "Earning for a trip looks wrong",
        answer: "Open the trip in Trip history to see the fare, the commission and your earning. Tell us the trip and what looks wrong.",
        followUps: ["Waiting time wasn't paid", "Tolls or parking weren't added"],
        agentReplies: [
          { title: "Explain earning", body: "I've checked the trip. Your earning is the fare minus the commission shown on the trip. Which part looks wrong?" },
        ],
      },
      {
        id: "earnings.recharge",
        label: "Wallet recharge failed",
        answer: "If money was deducted but your wallet didn't go up, it's refunded automatically within 5–7 working days. Tell us if it's been longer.",
        agentReplies: [
          { title: "Recharge credited", body: "I've checked the payment and credited your wallet. Please reopen the app to see it." },
        ],
      },
      {
        id: "earnings.bank",
        label: "Change bank details",
        answer: "Go to Profile → Bank details. Changes are reviewed before payouts use the new account.",
      },
    ],
  },
  {
    id: "documents",
    label: "Documents & verification",
    prompt: "Which of these is it?",
    category: "DOCUMENTS",
    children: [
      {
        id: "documents.pending",
        label: "Verification is still pending",
        answer: "Our team reviews documents in the order they arrive. You'll get a notification as soon as yours are approved.",
        followUps: ["It's been more than 2 days", "I uploaded the wrong document"],
        agentReplies: [
          { title: "Under review", body: "Your documents are in the review queue. I've flagged them so you get an update soon." },
        ],
      },
      {
        id: "documents.rejected",
        label: "My document was rejected",
        answer: "Open Profile or My vehicles to see the reason, then upload a clear photo of the whole document in good light.",
        agentReplies: [
          { title: "Re-upload tips", body: "The photo was unclear. Please upload it again with all four corners visible and no glare." },
        ],
      },
      {
        id: "documents.expiry",
        label: "Licence, RC or insurance expiring",
        answer: "Update your licence from Profile, and RC, insurance or PUC from My vehicles → Update documents. Upload before the expiry date to keep getting bookings.",
      },
    ],
  },
  {
    id: "trips",
    label: "Trips & bookings",
    prompt: "What's happening?",
    category: "TRIPS",
    children: [
      {
        id: "trips.none",
        label: "I'm not getting bookings",
        answer: "Stay online in an area with demand and keep your documents valid. Bookings go to the nearest free partner first, one at a time.",
        followUps: ["My documents are valid", "I'm online but get nothing"],
        agentReplies: [
          { title: "Check status", body: "I've checked your account: you're active and your documents are valid. Bookings go to the nearest partner first, so moving closer to busy areas helps." },
        ],
      },
      {
        id: "trips.customer_absent",
        label: "Customer isn't at pickup",
        answer: "Wait at the pickup and call the customer from the app; waiting beyond the free minutes is charged to them. If they don't come, tell us before cancelling.",
        priority: "HIGH",
        agentReplies: [
          { title: "Contacting customer", body: "I'm calling the customer now. Please wait a few more minutes; waiting time is being recorded." },
        ],
      },
      {
        id: "trips.otp",
        label: "Pickup or drop OTP not working",
        answer: "Ask the customer for the OTP shown on their trip screen. If it still fails, tell us and we'll help complete the step.",
        priority: "HIGH",
        agentReplies: [
          { title: "Help with OTP", body: "I can see the trip. Please confirm you're at the location and I'll help complete this step." },
        ],
      },
      {
        id: "trips.problem",
        label: "Problem during a trip",
        answer: "Tell us what happened and we'll help right away. If anyone is in danger, use SOS or call 112.",
        priority: "HIGH",
      },
    ],
  },
  {
    id: "app",
    label: "App problems",
    prompt: "What's not working?",
    category: "APP",
    children: [
      {
        id: "app.offline",
        label: "I keep going offline",
        answer: "Allow location 'All the time', and turn off battery optimisation for Movezy Partner in your phone's settings.",
        agentReplies: [
          { title: "Battery settings", body: "Please open Settings → Apps → Movezy Partner → Battery and set it to Unrestricted, then go online again." },
        ],
      },
      {
        id: "app.crash",
        label: "App crashes or freezes",
        answer: "Update Movezy Partner from the Play Store and restart your phone. If it still happens, tell us your phone model.",
        followUps: ["It still crashes", "I'm on the latest version"],
      },
      {
        id: "app.ring",
        label: "Booking alerts not ringing",
        answer: "Allow notifications for Movezy Partner and keep the phone off silent. Bookings ring while you're online.",
      },
    ],
  },
  {
    id: "account",
    label: "Account",
    prompt: "What do you need help with?",
    category: "ACCOUNT",
    children: [
      {
        id: "account.phone",
        label: "Change my phone number",
        answer: "For your security, numbers are changed through support. Tell us your current and new number.",
      },
      {
        id: "account.suspended",
        label: "My account is suspended",
        answer: "Suspensions follow a document expiry or a policy review. Check your documents, or ask us and we'll review it.",
        agentReplies: [
          { title: "Reviewing suspension", body: "I'm checking why your account was suspended and will update you here." },
        ],
      },
      {
        id: "account.delete",
        label: "Delete my account",
        answer: "Go to Profile → Delete account. Withdraw any earnings first; you can keep the account by signing in again within 30 days.",
      },
    ],
  },
  {
    id: "other",
    label: "Something else",
    answer: "No problem — tell us what you need and our team will help.",
    category: "OTHER",
    escalateNow: true,
  },
];
