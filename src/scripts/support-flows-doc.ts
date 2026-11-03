/**
 * Writes docs/support-flows.md from config/support-flows.ts, so the guided
 * support conversations can be reviewed without reading code.
 *
 *   npx ts-node -T src/scripts/support-flows-doc.ts
 */
import fs from "fs";
import path from "path";
import {
  CUSTOMER_FLOW,
  DEFAULT_FOLLOW_UPS,
  DRIVER_FLOW,
  FlowText,
  SupportNode,
} from "../config/support-flows";

const t = (x: FlowText | undefined) => (x === undefined ? "" : typeof x === "string" ? x : x.en);

const lines: string[] = [];
const out = (s = "") => lines.push(s);

const render = (nodes: SupportNode[], depth: number) => {
  for (const n of nodes) {
    const pad = "  ".repeat(depth);
    const tags = [
      n.category ? `ticket category ${n.category}` : "",
      n.priority ? `priority ${n.priority}` : "",
      n.escalateNow ? "goes straight to an agent" : "",
    ]
      .filter(Boolean)
      .join(", ");
    out(`${pad}- **${t(n.label)}**${tags ? ` _(${tags})_` : ""}`);
    if (n.prompt) out(`${pad}  - Assistant asks: "${t(n.prompt)}"`);
    if (n.answer) out(`${pad}  - Assistant answers: "${t(n.answer)}"`);
    if (n.followUps) out(`${pad}  - User chips after an agent reply: ${n.followUps.map((f) => `"${t(f)}"`).join(", ")}`);
    for (const r of n.agentReplies || []) out(`${pad}  - Agent suggestion "${r.title}": "${r.body}"`);
    if (n.children) render(n.children, depth + 1);
  }
};

out("# Guided support conversations");
out();
out("Generated from `src/config/support-flows.ts` by `src/scripts/support-flows-doc.ts`. Edit the config, then rerun the script.");
out();
out("How it works, in both apps' Help & Support chat:");
out();
out("1. The assistant offers the topics below as tap chips. Each tap shows the next set of chips.");
out("2. At the end of a path, the assistant answers. The user then taps **That helped** or **Still need help**. Still need help opens a chat with an agent, with the path already on the ticket.");
out("3. In the agent chat, after each agent message the user gets follow-up chips. Those come from the issue, else its topic, else the defaults. Typing a custom message always works.");
out("4. In the admin panel, the agent sees the issue's suggested replies first, then the general quick replies.");
out();
out(`Default user follow-ups: ${DEFAULT_FOLLOW_UPS.map((f) => `"${t(f)}"`).join(", ")}.`);
out();
out("**Please confirm with Movezy:**");
out();
out("- refund times (5–7 working days)");
out("- payout timing (1–2 working days after approval)");
out("- that coins are credited after a completed trip");
out();
out("## Customer app (Movezy)");
out();
render(CUSTOMER_FLOW, 0);
out();
out("## Partner app (Movezy Partner)");
out();
render(DRIVER_FLOW, 0);
out();

const file = path.join(__dirname, "../../docs/support-flows.md");
fs.writeFileSync(file, lines.join("\n"));
console.log(`wrote ${path.relative(process.cwd(), file)} (${lines.length} lines)`);
