import type { LeadPayload } from "./lead-types.ts";
import { formatLead } from "./format.ts";

// Laravel retries for ~1h at most; keep the dedupe marker well beyond that.
export const DEDUPE_TTL_SECONDS = 2 * 24 * 3600;

const CHAT_PREFIX = "leads:chat:";

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

// Telegram says the chat is gone for good -> stop sending to it.
// grammY's GrammyError carries error_code/description; anything else (network) is transient.
export function isPermanentChatError(err: unknown): boolean {
  const { error_code: code, description } = (err ?? {}) as { error_code?: number; description?: string };
  const text = String(description ?? "").toLowerCase();
  if (code === 403) return true;
  return code === 400 && /chat not found|group chat was deleted|bot was kicked|bot was blocked|user is deactivated/.test(text);
}

// A chat that entered the code is "authorized" for leads: key present, value "on"
// (receives leads) or "off" (muted, but can switch back on without the code).
// Legacy value "1" counts as on. A missing key = no access.
export type LeadsState = "on" | "off";

export async function leadsState(kv: KVNamespace, chatId: number | string): Promise<LeadsState | null> {
  const v = await kv.get(chatKey(chatId));
  if (v === null) return null;
  return v === "off" ? "off" : "on";
}

export async function setLeadsState(kv: KVNamespace, chatId: number | string, state: LeadsState): Promise<void> {
  await kv.put(chatKey(chatId), state);
}

// Entering the code authorizes the chat and turns leads on.
export async function subscribeChat(kv: KVNamespace, chatId: number | string): Promise<void> {
  await setLeadsState(kv, chatId, "on");
}

// Revokes access entirely (used when Telegram says the chat is gone).
export async function unsubscribeChat(kv: KVNamespace, chatId: number | string): Promise<void> {
  await kv.delete(chatKey(chatId));
}

// Authorized, whether currently on or muted.
export async function isSubscribed(kv: KVNamespace, chatId: number | string): Promise<boolean> {
  return (await leadsState(kv, chatId)) !== null;
}

// Chats that should receive leads right now (authorized and not muted).
export async function subscribedChats(kv: KVNamespace): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: CHAT_PREFIX, cursor });
    for (const key of page.keys) ids.push(key.name.slice(CHAT_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const states = await Promise.all(ids.map((id) => leadsState(kv, id)));
  return ids.filter((_, i) => states[i] === "on");
}

export type Outcome = "skipped" | "dead" | "transient" | "delivered";

export interface DeliveryResult {
  attempted: number;
  delivered: number;
  skipped: number;
  transientFailures: number;
  removed: number;
}

/**
 * Send the lead to every subscribed chat. Nothing is stored here: the lead itself
 * lives in the site's database; only per-chat dedupe markers are kept.
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
