import type { Api } from "grammy";
import type { Env } from "./env.ts";
import { createBot } from "./bot.ts";

// Bump when COMMANDS or the descriptions change; the next cron run re-applies them.
export const PROFILE_VERSION = "1";
const PROFILE_KEY = "meta:profile";

// Only what everyone may use. Leads commands stay out of the list on purpose:
// the menu shows them to chats that entered the code.
export const COMMANDS = [
  { command: "menu", description: "Меню" },
  { command: "status", description: "Статус сайта и сервера" },
  { command: "history", description: "Последние инциденты" },
];

export const SHORT_DESCRIPTION = "Алерты о сбоях 3x3.team и заявки с сайта.";
export const DESCRIPTION =
  "Следит за 3x3.team и рабочей станцией и пишет, если что-то упало. Заявки с сайта приходят подписанным чатам.";

// Idempotent: a KV flag makes it a no-op once the current version is applied.
// Never throws, so a Telegram hiccup can't break the cron run.
export type ProfileApi = Pick<Api, "setMyCommands" | "setMyShortDescription" | "setMyDescription">;

export async function ensureProfile(env: Env, api: ProfileApi = createBot(env).api): Promise<void> {
  try {
    if ((await env.SUBSCRIBERS.get(PROFILE_KEY)) === PROFILE_VERSION) return;
    await api.setMyCommands(COMMANDS);
    await api.setMyShortDescription(SHORT_DESCRIPTION);
    await api.setMyDescription(DESCRIPTION);
    await env.SUBSCRIBERS.put(PROFILE_KEY, PROFILE_VERSION);
    console.log("[profile] applied", PROFILE_VERSION);
  } catch (err) {
    console.error("[profile] failed", err instanceof Error ? err.message : String(err));
  }
}
