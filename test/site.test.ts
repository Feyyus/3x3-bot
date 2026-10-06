import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/env.ts";
import { fetchRecentLeads } from "../src/site.ts";
import { fakeKv } from "./helpers.ts";

const env: Env = { SUBSCRIBERS: fakeKv(), TELEGRAM_BOT_TOKEN: "1:x", RELAY_SECRET: "s3cret" };

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;

test("asks the site for recent leads with the bearer secret and parses them", async () => {
  let seen: { url: string; auth: string | null } | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), auth: new Headers(init?.headers).get("Authorization") };
    return new Response(JSON.stringify({ leads: [{ id: 83, name: "Проверка", phone: "213" }, { nope: true }] }));
  }) as typeof fetch;

  const leads = await fetchRecentLeads(env, 3, fetchImpl);

  assert.equal(seen?.url, "https://3x3.team/api/bot/leads?limit=3");
  assert.equal(seen?.auth, "Bearer s3cret");
  assert.deepEqual(leads.map((l) => l.id), [83], "entries without an id are dropped");
});

test("throws when the site answers with an error", async () => {
  await assert.rejects(fetchRecentLeads(env, 5, respond({ error: "unauthorized" }, 401)), /401/);
});

test("throws on an unexpected response shape", async () => {
  await assert.rejects(fetchRecentLeads(env, 5, respond({ leads: "nope" })), /unexpected/);
});

test("throws without a configured secret instead of calling the site unauthenticated", async () => {
  await assert.rejects(
    fetchRecentLeads({ ...env, RELAY_SECRET: undefined }, 5, (async () => assert.fail("must not fetch")) as typeof fetch),
    /RELAY_SECRET/,
  );
});
