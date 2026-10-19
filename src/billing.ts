import { InlineKeyboard } from "grammy";
import { escapeHtml, header, row } from "./format.ts";

export interface Invoice {
  id: string;
  name: string; // за что платим
  amount: number; // руб.
  due: string; // YYYY-MM-DD
}

// Счета хостинга VPS. Новый счёт — добавить строку и задеплоить. Бот дважды в день
// (10:00 и 16:00 МСК) напоминает о тех, что не подтверждены кнопкой «Оплачен».
export const UNPAID_INVOICES: Invoice[] = [
  { id: "1547266", name: "Основной сервер", amount: 799, due: "2026-10-17" },
  { id: "1563407", name: "VPN", amount: 499, due: "2026-10-22" },
];

const DAY_MS = 86_400_000;

const dueLabel = (due: string): string => `${due.slice(8, 10)}.${due.slice(5, 7)}.${due.slice(0, 4)}`;

// Moscow is UTC+3 all year, so the Moscow calendar day is exact.
const moscowDay = (now: Date): number => Math.floor((now.getTime() + 3 * 3_600_000) / DAY_MS);

export function formatPaymentReminder(invoices: Invoice[], now = new Date()): string | null {
  if (invoices.length === 0) return null;
  const today = moscowDay(now);
  const lines = [header("💳", "Пора платить", "хостинг")];
  let total = 0;
  for (const inv of invoices) {
    total += inv.amount;
    const days = Math.floor(Date.parse(`${inv.due}T00:00:00Z`) / DAY_MS) - today;
    const state = days < 0 ? "просрочен" : days === 0 ? "сегодня последний день" : `ещё ${days} дн.`;
    lines.push(row("🧾", `${escapeHtml(inv.name)} — счёт ${escapeHtml(inv.id)}, ${inv.amount} руб., до ${dueLabel(inv.due)} (${state})`));
  }
  lines.push(row("💰", `Итого: ${total} руб.`));
  return lines.join("\n");
}

export const PAID_PREFIX = "paid:";
const paidKey = (id: string): string => `billing:paid:${id}`;

// Подтверждённые вручную кнопкой «Оплачен» счета лежат в KV и не напоминаются.
export async function unpaidInvoices(kv: KVNamespace): Promise<Invoice[]> {
  const flags = await Promise.all(UNPAID_INVOICES.map((inv) => kv.get(paidKey(inv.id))));
  return UNPAID_INVOICES.filter((_, i) => flags[i] === null);
}

export const markPaid = (kv: KVNamespace, id: string): Promise<void> => kv.put(paidKey(id), "1");

export const isKnownInvoice = (id: string): boolean => UNPAID_INVOICES.some((inv) => inv.id === id);

export function paymentKeyboard(invoices: Invoice[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const inv of invoices) kb.text(`✅ ${inv.name} оплачен`, `${PAID_PREFIX}${inv.id}`).row();
  return kb;
}

// Cron идёт раз в 10 минут: напоминаем в окнах 07:00–07:09 и 13:00–13:09 UTC
// (10:00 и 16:00 МСК), т.е. два раза в сутки.
const REMINDER_HOURS_UTC = [7, 13];

export const isReminderTick = (scheduledTime: number): boolean => {
  const d = new Date(scheduledTime);
  return REMINDER_HOURS_UTC.includes(d.getUTCHours()) && d.getUTCMinutes() < 10;
};
