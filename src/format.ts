import type { LeadPayload } from "./lead-types.ts";

const MAX_MESSAGE = 1500; // Telegram caps a message at 4096 chars

// Everything user-provided goes through escapeHtml before it touches a
// parse_mode: HTML message, so a lead can never inject tags or break markup.
export function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const escapeAttr = (value: string): string => escapeHtml(value).replace(/"/g, "&quot;");

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

// Moscow has no DST (UTC+3 all year), so a fixed offset is exact.
export function formatMoscowTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 3 * 3_600_000);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} МСК`;
}

// Shared message skeleton: `icon <b>Title</b> · suffix`, then `icon text` lines.
// Callers pass already-escaped text.
export const header = (icon: string, title: string, suffix?: string): string =>
  `${icon} <b>${escapeHtml(title)}</b>${suffix ? ` · ${escapeHtml(suffix)}` : ""}`;

export const row = (icon: string, escapedText: string): string => `${icon} ${escapedText}`;

export const nowMoscow = (): string => formatMoscowTime(new Date().toISOString());

export function formatLead(lead: LeadPayload, { maxMessage = MAX_MESSAGE }: { maxMessage?: number } = {}): string {
  const lines = [header("📩", "Заявка с сайта", "3x3"), "#site"];
  if (lead.name) lines.push(`👤 ${escapeHtml(lead.name)}`);
  if (lead.phone) lines.push(`📞 ${escapeHtml(lead.phone)}`);
  if (lead.email) lines.push(`✉️ ${escapeHtml(lead.email)}`);
  if (lead.company) lines.push(`🏢 ${escapeHtml(lead.company)}`);
  if (lead.service) lines.push(`🛠 ${escapeHtml(lead.service)}`);
  if (lead.message) {
    const text = lead.message.length > maxMessage ? `${lead.message.slice(0, maxMessage)}…` : lead.message;
    lines.push(`💬 ${escapeHtml(text)}`);
  }
  if (lead.source && lead.source !== "site") lines.push(`📍 ${escapeHtml(lead.source)}`);
  if (lead.briefUrl && isHttpUrl(lead.briefUrl)) lines.push(`📎 <a href="${escapeAttr(lead.briefUrl)}">Бриф</a>`);
  if (lead.createdAt) {
    const time = formatMoscowTime(lead.createdAt);
    if (time) lines.push(`🕒 ${time}`);
  }
  if (lead.leadUrl && isHttpUrl(lead.leadUrl)) lines.push(`🔗 <a href="${escapeAttr(lead.leadUrl)}">Открыть в админке</a>`);
  return lines.join("\n");
}

// Telegram caps a message at 4096 chars; pack blocks into as few messages as fit.
export function packMessages(blocks: string[], limit = 3800): string[] {
  const out: string[] = [];
  let cur = "";
  for (const block of blocks) {
    if (cur && cur.length + 2 + block.length > limit) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${block}` : block;
  }
  if (cur) out.push(cur);
  return out;
}

export function formatRecent(leads: LeadPayload[], count = 5): string[] {
  return packMessages(leads.slice(0, count).map((l) => formatLead(l, { maxMessage: 200 })));
}
