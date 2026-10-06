import { InlineKeyboard } from "grammy";
import { header, row } from "./format.ts";

// Callback data (Telegram caps it at 64 bytes).
export const CB = {
  menu: "m:menu",
  toggleAlerts: "t:alerts",
  toggleLeads: "t:leads",
  lastLeads: "m:last",
  status: "m:status",
  history: "m:history",
  // Buttons on messages sent before the menu existed; behaves as toggleAlerts.
  legacyToggle: "toggle",
} as const;

export interface MenuState {
  alerts: boolean;
  // null = this chat has no access to leads (never entered the code): the leads
  // block is hidden entirely so the menu doesn't hint that a code exists.
  leads: boolean | null;
}

const status = (on: boolean): string => (on ? "включены ✅" : "выключены 🔕");

export function menuText(state: MenuState, notice?: string): string {
  const lines = [header("🤖", "3x3 Bot", "сайт 3x3.team"), ""];
  if (notice) lines.push(notice, "");
  lines.push(row("🚨", `Алерты о сбоях — ${status(state.alerts)}`));
  if (state.leads !== null) lines.push(row("📩", `Заявки с сайта — ${status(state.leads)}`));
  lines.push("", "Проверяю сайт раз в 10 минут, пишу только если что-то упало.");
  return lines.join("\n");
}

export function menuKeyboard(state: MenuState): InlineKeyboard {
  const kb = new InlineKeyboard().text(state.alerts ? "🔕 Выключить алерты" : "🔔 Включить алерты", CB.toggleAlerts).row();
  if (state.leads !== null) {
    kb.text(state.leads ? "🔕 Выключить заявки" : "🔔 Включить заявки", CB.toggleLeads).row();
    kb.text("📩 Последние заявки", CB.lastLeads).row();
  }
  return kb.text("📊 Статус", CB.status).text("🕒 История", CB.history);
}
