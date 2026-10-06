import { test } from "node:test";
import assert from "node:assert/strict";
import type { UserFromGetMe } from "grammy/types";
import { createBot } from "../src/bot.ts";
import type { Env } from "../src/env.ts";
import { deliverLead, subscribedChats } from "../src/leads.ts";
import { COMMANDS, ensureProfile, PROFILE_VERSION, type ProfileApi } from "../src/profile.ts";
import { fakeKv } from "./helpers.ts";

const botInfo = { id: 1, is_bot: true, first_name: "bot", username: "bot" } as UserFromGetMe;
const CODE = "code-123";
const CHAT = 42;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

// Real bot + real handlers; only the outgoing Telegram calls are intercepted.
function harness() {
  const kv = fakeKv();
  const env: Env = { SUBSCRIBERS: kv, TELEGRAM_BOT_TOKEN: "1:x", LEADS_CODE: CODE, RELAY_SECRET: "s" };
  const bot = createBot(env, botInfo);
  const calls: Call[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true as never };
  });
  const chat = { id: CHAT, type: "private" as const, first_name: "t" };
  const from = { id: CHAT, is_bot: false, first_name: "t" };
  let n = 0;
  return {
    kv,
    env,
    calls,
    async command(text: string) {
      const cmdLen = text.split(" ")[0]?.length ?? text.length;
      await bot.handleUpdate({
        update_id: ++n,
        message: { message_id: n, date: 0, chat, from, text, entities: [{ type: "bot_command", offset: 0, length: cmdLen }] },
      });
    },
    async press(data: string) {
      await bot.handleUpdate({
        update_id: ++n,
        callback_query: { id: String(n), from, chat_instance: "x", data, message: { message_id: 5, date: 0, chat, text: "menu" } },
      });
    },
    last(method: string): Call | undefined {
      return [...calls].reverse().find((c) => c.method === method);
    },
  };
}

const callbacks = (c: Call | undefined): string[] => {
  const markup = c?.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "");
};

test("/start without a code: alerts on, no sign of leads", async () => {
  const h = harness();
  await h.command("/start");
  const sent = h.last("sendMessage");
  assert.match(String(sent?.payload.text), /Алерты о сбоях — включены/);
  assert.doesNotMatch(String(sent?.payload.text), /Заявки/);
  assert.ok(!callbacks(sent).includes("t:leads"));
  assert.equal(await h.kv.get(String(CHAT)), "on");
  assert.equal(await h.kv.get(`leads:chat:${CHAT}`), null);
});

test("/start with a wrong code behaves like a plain /start", async () => {
  const h = harness();
  await h.command("/start nope");
  assert.doesNotMatch(String(h.last("sendMessage")?.payload.text), /Заявки/);
  assert.equal(await h.kv.get(`leads:chat:${CHAT}`), null);
});

test("/start with the code unlocks leads and shows the leads block", async () => {
  const h = harness();
  await h.command(`/start ${CODE}`);
  const sent = h.last("sendMessage");
  assert.match(String(sent?.payload.text), /Заявки с сайта подключены/);
  assert.match(String(sent?.payload.text), /Заявки с сайта — включены/);
  assert.ok(callbacks(sent).includes("t:leads"));
  assert.equal(await h.kv.get(`leads:chat:${CHAT}`), "on");
});

test("leads toggle edits the menu in place and stops delivery without losing access", async () => {
  const h = harness();
  await h.command(`/start ${CODE}`);

  await h.press("t:leads");
  assert.match(String(h.last("editMessageText")?.payload.text), /Заявки с сайта — выключены/);
  assert.equal(await h.kv.get(`leads:chat:${CHAT}`), "off");
  assert.deepEqual(await subscribedChats(h.kv), []);
  const sent: string[] = [];
  await deliverLead({ lead: { id: 1, name: "x" }, kv: h.kv, send: async (id) => void sent.push(id) });
  assert.deepEqual(sent, []);

  await h.press("t:leads");
  assert.match(String(h.last("editMessageText")?.payload.text), /Заявки с сайта — включены/);
  assert.deepEqual(await subscribedChats(h.kv), [String(CHAT)]);
});

test("alerts toggle (new and legacy button) flips the alert subscription", async () => {
  const h = harness();
  await h.command("/start");
  await h.press("t:alerts");
  assert.equal(await h.kv.get(String(CHAT)), "off");
  assert.match(String(h.last("editMessageText")?.payload.text), /Алерты о сбоях — выключены/);
  await h.press("toggle");
  assert.equal(await h.kv.get(String(CHAT)), "on");
});

test("a chat without the code cannot toggle or read leads", async () => {
  const h = harness();
  await h.command("/start");
  const before = h.calls.length;
  await h.press("t:leads");
  assert.equal(h.last("answerCallbackQuery")?.payload.text, "Недоступно");
  assert.equal(h.calls.filter((c) => c.method === "editMessageText").length, 0);
  assert.equal(await h.kv.get(`leads:chat:${CHAT}`), null);

  const afterPress = h.calls.length;
  await h.command("/lastleads");
  await h.press("m:last");
  assert.equal(h.calls.filter((c) => c.method === "sendMessage").length, 1, "only the /start menu was sent");
  assert.ok(h.calls.length > before && afterPress > before);
});

test("authorized chat gets recent leads, or an empty-state line", async () => {
  const h = harness();
  await h.command(`/start ${CODE}`);
  await h.press("m:last");
  assert.equal(h.last("sendMessage")?.payload.text, "Заявок пока нет.");

  await deliverLead({ lead: { id: 7, name: "Иван", phone: "+7 900" }, kv: h.kv, send: async () => {} });
  await h.command("/lastleads");
  assert.match(String(h.last("sendMessage")?.payload.text), /Иван/);
});

test("hidden /stop_leads mutes but keeps access", async () => {
  const h = harness();
  await h.command(`/start ${CODE}`);
  await h.command("/stop_leads");
  assert.equal(await h.kv.get(`leads:chat:${CHAT}`), "off");
  assert.match(String(h.last("sendMessage")?.payload.text), /Включить обратно можно в \/menu/);
});

test("/menu and /history reply in the shared HTML style", async () => {
  const h = harness();
  await h.command("/menu");
  assert.equal(h.last("sendMessage")?.payload.parse_mode, "HTML");
  await h.command("/history");
  assert.match(String(h.last("sendMessage")?.payload.text), /^🕒 <b>Инциденты<\/b>/);
});

test("ensureProfile sets the command menu once per version", async () => {
  const kv = fakeKv();
  const env: Env = { SUBSCRIBERS: kv, TELEGRAM_BOT_TOKEN: "1:x" };
  const seen: string[] = [];
  const api: ProfileApi = {
    setMyCommands: async () => (seen.push("setMyCommands"), true as const),
    setMyShortDescription: async () => (seen.push("setMyShortDescription"), true as const),
    setMyDescription: async () => (seen.push("setMyDescription"), true as const),
  };

  await ensureProfile(env, api);
  assert.deepEqual(seen.sort(), ["setMyCommands", "setMyDescription", "setMyShortDescription"]);
  assert.equal(await kv.get("meta:profile"), PROFILE_VERSION);

  seen.length = 0;
  await ensureProfile(env, api);
  assert.deepEqual(seen, [], "second run is a no-op");

  // a Telegram failure must not throw (it would break the cron run) nor mark the version applied
  const kv2 = fakeKv();
  await ensureProfile({ SUBSCRIBERS: kv2, TELEGRAM_BOT_TOKEN: "1:x" }, { ...api, setMyCommands: async () => { throw new Error("tg down"); } });
  assert.equal(await kv2.get("meta:profile"), null);

  assert.deepEqual(COMMANDS.map((c) => c.command), ["menu", "status", "history"]);
});
