import { webhookCallback } from "grammy";
import type { Env } from "./env.ts";
import { createBot, HTML } from "./bot.ts";
import { checkServerHealth, checkSites, isChatKey, logIncident } from "./monitor.ts";
import { deliverLead, parseLead, shouldRetry } from "./leads.ts";
import { bearerMatches } from "./security.ts";
import { formatAlert } from "./messages.ts";
import { ensureProfile } from "./profile.ts";

const MAX_BODY_BYTES = 16 * 1024;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function handleLead(request: Request, env: Env): Promise<Response> {
  // fail closed: no secret configured -> nobody can post leads
  if (!env.RELAY_SECRET) return json(500, { ok: false, error: "misconfigured" });
  if (!(await bearerMatches(request, env.RELAY_SECRET))) return json(401, { ok: false, error: "unauthorized" });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, error: "too large" });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // falls through to "bad lead"
  }
  const lead = parseLead(body);
  if (!lead) return json(400, { ok: false, error: "bad lead" });

  const bot = createBot(env);
  let result: Awaited<ReturnType<typeof deliverLead>>;
  try {
    result = await deliverLead({
      lead,
      kv: env.SUBSCRIBERS,
      send: (chatId, text) => bot.api.sendMessage(chatId, text, HTML),
    });
  } catch (err) {
    // KV failed -> nothing stored, Laravel must retry
    console.error("lead store failed", err instanceof Error ? err.message : String(err));
    return json(500, { ok: false, error: "storage error" });
  }

  console.log(JSON.stringify({ event: "lead", id: lead.id, ...result }));
  if (shouldRetry(result)) return json(502, { ok: false, error: "telegram unavailable" });
  return json(200, { ok: true, delivered: result.delivered });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/lead") return handleLead(request, env);

    return webhookCallback(createBot(env), "cloudflare-mod")(request);
  },

  // Cron trigger — раз в 10 минут, молча если всё ок, шлёт всем подписанным при падении.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await ensureProfile(env);

    const [results, health] = await Promise.all([checkSites(), checkServerHealth()]);
    const down = results.filter((r) => !r.ok);

    // Полный лог каждого прогона (не только падений) — виден в `wrangler tail`.
    console.log(
      "[scheduled]",
      JSON.stringify({
        sites: results.map((r) => ({ url: r.url, ok: r.ok, code: r.code, attempts: r.attempts, ms: r.elapsedMs })),
        health: { ok: health.ok, reason: health.reason, attempts: health.attempts },
      }),
    );

    if (down.length === 0 && health.ok) return;

    await logIncident(env, down, health);

    const text = formatAlert(down, health);

    const list = await env.SUBSCRIBERS.list();
    for (const key of list.keys) {
      if (!isChatKey(key.name)) continue;
      const val = await env.SUBSCRIBERS.get(key.name);
      if (val === "off") continue;
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: key.name, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      });
    }
  },
} satisfies ExportedHandler<Env>;
