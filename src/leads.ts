import type { LeadPayload } from "./lead-types.ts";
import { formatLead } from "./format.ts";

export const RECENT_MAX = 20;
// Laravel retries for ~1h at most; keep the dedupe marker well beyond that.
export const DEDUPE_TTL_SECONDS = 2 * 24 * 3600;

const CHAT_PREFIX = "leads:chat:";
const RECENT_KEY = "leads:recent";

export const chatKey = (chatId: number | string): string => `${CHAT_PREFIX}${chatId}`;
export const dedupeKey = (leadId: number | string, chatId: number | string): string => `leads:sent:${leadId}:${chatId}`;

const clip = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
};

// Shape Laravel sends; this only guards against garbage so a bad call can't
// crash message formatting. Every field but `id` may be missing.
export function parseLead(body: unknown): LeadPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const id = b.id;
  const idOk = (typeof id === "number" && Number.isInteger(id)) || (typeof id === "string" && id.length > 0 && id.length <= 40);
  if (!idOk) return null;
  return {
    id,
    createdAt: clip(b.createdAt, 40),
    source: clip(b.source, 100),
    name: clip(b.name, 200),
    phone: clip(b.phone, 60),
    email: clip(b.email, 200),
    company: clip(b.company, 200),
    service: clip(b.service, 500),
    message: clip(b.message, 5000),
    leadUrl: clip(b.leadUrl, 500),
    briefUrl: clip(b.briefUrl, 500),
  };
}

// newest first, one entry per lead id (Laravel may resend the same lead)
export function addRecent(recent: LeadPayload[], lead: LeadPayload, max = RECENT_MAX): LeadPayload[] {
  return [lead, ...recent.filter((l) => String(l.id) !== String(lead.id))].slice(0, max);
}

// Telegram says the chat is gone for good -> stop sending to it.
// grammY's GrammyError carries error_code/description; anything else (network) is transient.
export function isPermanentChatError(err: unknown): boolean {
  const { error_code: code, description } = (err ?? {}) as { error_code?: number; description?: string };
  const text = String(description ?? "").toLowerCase();
  if (code === 403) return true;
  return code === 400 && /chat not found|group chat was deleted|bot was kicked|bot was blocked|user is deactivated/.test(text);
}

export async function subscribeChat(kv: KVNamespace, chatId: number | string): Promise<void> {
  await kv.put(chatKey(chatId), "1");
}

export async function unsubscribeChat(kv: KVNamespace, chatId: number | string): Promise<void> {
  await kv.delete(chatKey(chatId));
}

export async function isSubscribed(kv: KVNamespace, chatId: number | string): Promise<boolean> {
  return (await kv.get(chatKey(chatId))) !== null;
}

export async function subscribedChats(kv: KVNamespace): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: CHAT_PREFIX, cursor });
    for (const key of page.keys) ids.push(key.name.slice(CHAT_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return ids;
}

export async function recentLeads(kv: KVNamespace): Promise<LeadPayload[]> {
  return (await kv.get<LeadPayload[]>(RECENT_KEY, "json")) ?? [];
}

export type Outcome = "skipped" | "dead" | "transient" | "delivered";

export interface DeliveryResult {
  stored: true;
  attempted: number;
  delivered: number;
  skipped: number;
  transientFailures: number;
  removed: number;
}

/**
 * Store the lead, then send it to every subscribed chat.
 * `send(chatId, html)` throws on Telegram errors (grammY GrammyError/HttpError).
 */
export async function deliverLead({
  lead,
  kv,
  send,
}: {
  lead: LeadPayload;
  kv: KVNamespace;
  send: (chatId: string, html: string) => Promise<unknown>;
}): Promise<DeliveryResult> {
  // Store first: even with nobody subscribed the lead is visible via /lastleads.
  await kv.put(RECENT_KEY, JSON.stringify(addRecent(await recentLeads(kv), lead)));

  const targets = await subscribedChats(kv);
  const text = formatLead(lead);

  const outcomes = await Promise.all(
    targets.map(async (chatId): Promise<{ chatId: string; status: Outcome }> => {
      if (await kv.get(dedupeKey(lead.id, chatId))) return { chatId, status: "skipped" };
      try {
        await send(chatId, text);
      } catch (err) {
        return { chatId, status: isPermanentChatError(err) ? "dead" : "transient" };
      }
      await kv.put(dedupeKey(lead.id, chatId), "1", { expirationTtl: DEDUPE_TTL_SECONDS });
      return { chatId, status: "delivered" };
    }),
  );

  const count = (s: Outcome): number => outcomes.filter((o) => o.status === s).length;
  const dead = outcomes.filter((o) => o.status === "dead");
  await Promise.all(dead.map((o) => unsubscribeChat(kv, o.chatId)));

  return {
    stored: true,
    attempted: targets.length,
    delivered: count("delivered"),
    skipped: count("skipped"),
    transientFailures: count("transient"),
    removed: dead.length,
  };
}

// 5xx only when someone should have received the lead but nobody did because of
// transient errors; Laravel then retries (dedupe makes that safe).
export function shouldRetry(r: DeliveryResult): boolean {
  return r.attempted > 0 && r.delivered === 0 && r.skipped === 0 && r.transientFailures > 0;
}
