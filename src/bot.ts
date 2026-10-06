import { Bot, InlineKeyboard } from "grammy";
import type { Env } from "./env.ts";
import { checkServerHealth, checkSites, type IncidentEntry } from "./monitor.ts";
import { safeEqual } from "./security.ts";
import { formatRecent } from "./format.ts";
import { isSubscribed, recentLeads, subscribeChat, unsubscribeChat } from "./leads.ts";

export const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

function subscribeKeyboard(enabled: boolean): InlineKeyboard {
  return new InlineKeyboard().text(
    enabled ? "🔕 Отключить уведомления" : "🔔 Включить уведомления",
    "toggle",
  );
}

export function createBot(env: Env): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // По умолчанию — подписан на алерты. Отключить можно кнопкой, ничего не нужно вводить руками.
  // `/start <код>` дополнительно подписывает на заявки с сайта; неверный код ведёт себя
  // как обычный /start, чтобы не выдавать, что код вообще существует.
  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const code = ctx.match.trim();
    const leadsSubscribed = Boolean(code && env.LEADS_CODE && (await safeEqual(code, env.LEADS_CODE)));
    if (leadsSubscribed) await subscribeChat(env.SUBSCRIBERS, chatId);

    if ((await env.SUBSCRIBERS.get(chatId)) === null) {
      await env.SUBSCRIBERS.put(chatId, "on");
    }
    const enabled = (await env.SUBSCRIBERS.get(chatId)) !== "off";
    await ctx.reply(
      "Слежу за 3x3.team и рабочей станцией. Раз в 10 минут проверяю тихо, " +
        "пишу только если что-то упало. /history — последние инциденты.\n\nУведомления сейчас: " +
        (enabled ? "включены ✅" : "выключены 🔕") +
        (leadsSubscribed ? "\n\n📩 Заявки с сайта подключены. /lastleads — последние 5, /stop_leads — отключить." : ""),
      { reply_markup: subscribeKeyboard(enabled) },
    );
  });

  bot.command("stop_leads", async (ctx) => {
    if (!(await isSubscribed(env.SUBSCRIBERS, ctx.chat.id))) return;
    await unsubscribeChat(env.SUBSCRIBERS, ctx.chat.id);
    await ctx.reply("Заявки с сайта отключены.");
  });

  // Только для подписанных: без кода бот про заявки молчит.
  bot.command("lastleads", async (ctx) => {
    if (!(await isSubscribed(env.SUBSCRIBERS, ctx.chat.id))) return;
    const messages = formatRecent(await recentLeads(env.SUBSCRIBERS));
    if (messages.length === 0) {
      await ctx.reply("Заявок пока нет.");
      return;
    }
    for (const text of messages) await ctx.reply(text, HTML);
  });

  bot.command("status", async (ctx) => {
    const [results, health] = await Promise.all([checkSites(), checkServerHealth()]);
    const lines = results.map((r) => `${r.ok ? "✅" : "⚠️"} ${r.url} — ${r.code}`);
    lines.push(
      health.ok
        ? `✅ сервер — диск ${health.data?.disk_percent ?? "?"}%, память ${health.data?.mem_percent ?? "?"}%`
        : `⚠️ сервер — ${health.reason ?? health.warnings?.join(", ")}`,
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.command("history", async (ctx) => {
    const raw = await env.SUBSCRIBERS.get("history");
    const list: IncidentEntry[] = raw ? JSON.parse(raw) : [];
    if (list.length === 0) {
      await ctx.reply("Инцидентов пока не зафиксировано.");
      return;
    }
    const last = list.slice(-10).reverse();
    const lines = last.map((entry) => {
      const parts: string[] = [];
      for (const d of entry.down) parts.push(`${d.url} — ${d.code}`);
      if (entry.health) parts.push(`рабочая станция — ${entry.health.reason}`);
      return `🕒 ${entry.time}\n${parts.join("\n")}`;
    });
    await ctx.reply(`Последние ${last.length} инцидент(ов):\n\n${lines.join("\n\n")}`);
  });

  bot.on("callback_query:data", async (ctx) => {
    if (ctx.callbackQuery.data !== "toggle" || !ctx.chat) return;
    const chatId = String(ctx.chat.id);
    const wasOff = (await env.SUBSCRIBERS.get(chatId)) === "off";
    await env.SUBSCRIBERS.put(chatId, wasOff ? "on" : "off");
    const enabled = wasOff;
    await ctx.editMessageReplyMarkup({ reply_markup: subscribeKeyboard(enabled) });
    await ctx.answerCallbackQuery(enabled ? "Уведомления включены" : "Уведомления выключены");
  });

  return bot;
}
