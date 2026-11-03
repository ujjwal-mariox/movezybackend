import {
  AgentReply,
  CUSTOMER_FLOW,
  DEFAULT_FOLLOW_UPS,
  DRIVER_FLOW,
  FlowText,
  SupportNode,
} from "../config/support-flows";

/**
 * Reads the guided support trees in config/support-flows.ts for the apps
 * (the tree in the user's language), for ticket creation (category, priority
 * and a readable path from the chosen issue) and for agents (suggested
 * replies for a ticket's path).
 */

export type FlowAudience = "USER" | "DRIVER";

const treeFor = (audience: FlowAudience) =>
  audience === "DRIVER" ? DRIVER_FLOW : CUSTOMER_FLOW;

const text = (t: FlowText | undefined, lang = "en"): string | undefined => {
  if (t === undefined) return undefined;
  if (typeof t === "string") return t;
  return (lang === "hi" && t.hi) || t.en;
};

/** Duplicate ids would make a stored ticket path ambiguous; flag them early. */
for (const [name, tree] of [
  ["customer", CUSTOMER_FLOW],
  ["driver", DRIVER_FLOW],
] as const) {
  const seen = new Set<string>();
  const walk = (nodes: SupportNode[]) =>
    nodes.forEach((n) => {
      if (seen.has(n.id)) console.warn(`[support-flow] duplicate id "${n.id}" in the ${name} tree`);
      seen.add(n.id);
      if (n.children) walk(n.children);
    });
  walk(tree);
}

export interface ResolvedNode {
  id: string;
  label: string;
  prompt?: string;
  answer?: string;
  escalateNow?: boolean;
  /** Chips for the user after an agent replies (inherited, then default). */
  followUps: string[];
  children?: ResolvedNode[];
}

/** The tree an app renders: text in `lang`, no agent-only fields. */
export const getFlow = (audience: FlowAudience, lang = "en"): ResolvedNode[] => {
  const resolve = (nodes: SupportNode[], inherited: FlowText[]): ResolvedNode[] =>
    nodes.map((n) => {
      const followUps = n.followUps ?? inherited;
      return {
        id: n.id,
        label: text(n.label, lang)!,
        ...(n.prompt ? { prompt: text(n.prompt, lang) } : {}),
        ...(n.answer ? { answer: text(n.answer, lang) } : {}),
        ...(n.escalateNow ? { escalateNow: true } : {}),
        followUps: followUps.map((f) => text(f, lang)!),
        ...(n.children ? { children: resolve(n.children, followUps) } : {}),
      };
    });
  return resolve(treeFor(audience), DEFAULT_FOLLOW_UPS);
};

/** Root → node chain for an id, or null when the id isn't in the tree. */
const chainTo = (audience: FlowAudience, id: string): SupportNode[] | null => {
  const search = (nodes: SupportNode[], trail: SupportNode[]): SupportNode[] | null => {
    for (const n of nodes) {
      const here = [...trail, n];
      if (n.id === id) return here;
      if (n.children) {
        const found = search(n.children, here);
        if (found) return found;
      }
    }
    return null;
  };
  return id ? search(treeFor(audience), []) : null;
};

export interface TicketFields {
  supportPath: string[];
  category: string;
  subcategory: string;
  priority?: SupportNode["priority"];
  /** "Account › Can't log in › OTP not received" */
  pathLabel: string;
}

/** What a ticket opened from this issue should carry, or null if unknown. */
export const ticketFieldsFor = (
  audience: FlowAudience,
  nodeId: string | undefined,
): TicketFields | null => {
  const chain = nodeId ? chainTo(audience, nodeId) : null;
  if (!chain) return null;
  const leaf = chain[chain.length - 1];
  const deepest = <K extends keyof SupportNode>(key: K) =>
    [...chain].reverse().find((n) => n[key] !== undefined)?.[key];
  return {
    supportPath: chain.map((n) => n.id),
    category: (deepest("category") as string) || "OTHER",
    subcategory: leaf.id,
    priority: deepest("priority") as SupportNode["priority"],
    pathLabel: chain.map((n) => text(n.label)!).join(" › "),
  };
};

/** Chips for the user after an agent reply on a ticket with this path. */
export const followUpsFor = (
  audience: FlowAudience,
  supportPath: string[] | undefined,
  lang = "en",
): string[] => {
  const chain = supportPath?.length ? chainTo(audience, supportPath[supportPath.length - 1]) : null;
  const own = chain ? [...chain].reverse().find((n) => n.followUps)?.followUps : undefined;
  return (own ?? DEFAULT_FOLLOW_UPS).map((f) => text(f, lang)!);
};

/** Agent suggestions for a ticket's path: the issue's own first, then its topic's. */
export const agentRepliesFor = (
  audience: FlowAudience,
  supportPath: string[] | undefined,
): AgentReply[] => {
  const chain = supportPath?.length ? chainTo(audience, supportPath[supportPath.length - 1]) : null;
  if (!chain) return [];
  const seen = new Set<string>();
  const out: AgentReply[] = [];
  for (const n of [...chain].reverse()) {
    for (const r of n.agentReplies || []) {
      if (seen.has(r.title)) continue;
      seen.add(r.title);
      out.push(r);
    }
  }
  return out;
};
