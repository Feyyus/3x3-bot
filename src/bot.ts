import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "./env.ts";
import { checkServerHealth, checkSites, type IncidentEntry } from "./monitor.ts";
import { safeEqual } from "./security.ts";
import { formatRecent } from "./format.ts";
import { formatHistory, formatStatus } from "./messages.ts";
import { CB, menuKeyboard, menuText, type MenuState } from "./ui.ts";
import { leadsState, recentLeads, setLeadsState, subscribeChat } from "./leads.ts";

export const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

type ChatId = number | string;

async function loadState(env: Env, chatId: ChatId): Promise<MenuState> {
  const [alerts, leads] = await Promise.all([env.SUBSCRIBERS.get(String(chatId)), leadsState(env.SUBSCRIBERS, chatId)]);
  return { alerts: alerts !== "off", leads: leads === null ? null : leads === "on" };
}

async function showMenu(ctx: Context, env: Env, notice?: string): Promise<void> {
  if (!ctx.chat) return;
  const state = await loadState(env, ctx.chat.id);
  await ctx.reply(menuText(state, notice), { ...HTML, reply_markup: menuKeyboard(state) });
}

// Re-render the menu in place; Telegram rejects an edit that changes nothing.
async function refreshMenu(ctx: Context, env: Env): Promise<void> {
  if (!ctx.chat) return;
  const state = await loadState(env, ctx.chat.id);
  try {
    await ctx.editMessageText(menuText(state), { ...HTML, reply_markup: menuKeyboard(state) });
  } catch (err) {
    if (!/message is not modified/i.test(String((err as { description?: string })?.description ?? err))) throw err;
  }
}

async function sendStatus(ctx: Context): Promise<void> {
  const [results, health] = await Promise.all([checkSites(), checkServerHealth()]);
  await ctx.reply(formatStatus(results, health), HTML);
}

async function sendHistory(ctx: Context, env: Env): Promise<void> {
  const raw = await env.SUBSCRIBERS.get("history");
  const list: IncidentEntry[] = raw ? JSON.parse(raw) : [];
  await ctx.reply(formatHistory(list), HTML);
}

// Only for chats that entered the code; everyone else gets no reply.
async function sendLastLeads(ctx: Context, env: Env): Promise<void> {
  if (!ctx.chat || (await leadsState(env.SUBSCRIBERS, ctx.chat.id)) === null) return;
  const messages = formatRecent(await recentLeads(env.SUBSCRIBERS));
  if (messages.length === 0) {
    await ctx.reply("Заявок пока нет.");
    return;
  }
  for (const text of messages) await ctx.reply(text, HTML);
}

async function toggleAlerts(env: Env, chatId: ChatId): Promise<boolean> {
  const wasOff = (await env.SUBSCRIBERS.get(String(chatId))) === "off";
  await env.SUBSCRIBERS.put(String(chatId), wasOff ? "on" : "off");
  return wasOff;
}

export function createBot(env: Env, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, botInfo ? { botInfo } : undefined);

  // Алерты включены по умолчанию. `/start <код>` дополнительно открывает заявки; неверный
  // код ведёт себя как обычный /start, чтобы не выдавать, что код вообще существует.
  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const code = ctx.match.trim();
    const unlocked = Boolean(code && env.LEADS_CODE && (await safeEqual(code, env.LEADS_CODE)));
    if (unlocked) await subscribeChat(env.SUBSCRIBERS, chatId);
    if ((await env.SUBSCRIBERS.get(chatId)) === null) await env.SUBSCRIBERS.put(chatId, "on");
    await showMenu(ctx, env, unlocked ? "📩 Заявки с сайта подключены." : undefined);
  });

  bot.command("menu", (ctx) => showMenu(ctx, env));
  bot.command("status", (ctx) => sendStatus(ctx));
  bot.command("history", (ctx) => sendHistory(ctx, env));

  // Скрытые алиасы (в меню команд их нет, всё то же есть кнопками).
  bot.command("lastleads", (ctx) => sendLastLeads(ctx, env));
  bot.command("stop_leads", async (ctx) => {
    if ((await leadsState(env.SUBSCRIBERS, ctx.chat.id)) === null) return;
    await setLeadsState(env.SUBSCRIBERS, ctx.chat.id, "off");
    await ctx.reply("Заявки с сайта выключены. Включить обратно можно в /menu.");
  });

  bot.on("callback_query:data", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;
    switch (ctx.callbackQuery.data) {
      case CB.toggleAlerts:
      case CB.legacyToggle: {
        const on = await toggleAlerts(env, chat.id);
        await refreshMenu(ctx, env);
        await ctx.answerCallbackQuery(on ? "Алерты включены" : "Алерты выключены");
        return;
      }
      case CB.toggleLeads: {
        const state = await leadsState(env.SUBSCRIBERS, chat.id);
        if (state === null) {
          await ctx.answerCallbackQuery("Недоступно");
          return;
        }
        await setLeadsState(env.SUBSCRIBERS, chat.id, state === "on" ? "off" : "on");
        await refreshMenu(ctx, env);
        await ctx.answerCallbackQuery(state === "on" ? "Заявки выключены" : "Заявки включены");
        return;
      }
      case CB.menu:
        await refreshMenu(ctx, env);
        await ctx.answerCallbackQuery();
        return;
      case CB.lastLeads:
        await ctx.answerCallbackQuery();
        await sendLastLeads(ctx, env);
        return;
      case CB.status:
        await ctx.answerCallbackQuery("Проверяю…");
        await sendStatus(ctx);
        return;
      case CB.history:
        await ctx.answerCallbackQuery();
        await sendHistory(ctx, env);
        return;
      default:
        await ctx.answerCallbackQuery();
    }
  });

  return bot;
}
