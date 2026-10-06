import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverLead, isPermanentChatError, parseLead, shouldRetry, type DeliveryResult } from "../src/leads.ts";
import { isChatKey } from "../src/monitor.ts";
import { bearerMatches, safeEqual } from "../src/security.ts";
import type { LeadPayload } from "../src/lead-types.ts";
import { fakeKv } from "./helpers.ts";


const lead: LeadPayload = { id: 7, name: "Иван", phone: "+7 900 000-00-00" };

test("parseLead requires an id and tolerates everything else missing", () => {
  assert.equal(parseLead(null), null);
  assert.equal(parseLead({}), null);
  assert.equal(parseLead({ id: 1.5 }), null);
  assert.equal(parseLead({ id: "x".repeat(41) }), null);
  assert.deepEqual(parseLead({ id: 3 })?.id, 3);
  assert.equal(parseLead({ id: 3, name: 42 })?.name, undefined);
  assert.equal(parseLead({ id: 3, name: "  Аня  " })?.name, "Аня");
});

test("isPermanentChatError: 403 and dead chats are permanent, network errors are not", () => {
  assert.equal(isPermanentChatError({ error_code: 403, description: "Forbidden: bot was blocked by the user" }), true);
  assert.equal(isPermanentChatError({ error_code: 400, description: "Bad Request: chat not found" }), true);
  assert.equal(isPermanentChatError({ error_code: 400, description: "Bad Request: message is too long" }), false);
  assert.equal(isPermanentChatError(new Error("network")), false);
  assert.equal(isPermanentChatError(undefined), false);
});

test("deliverLead sends to every subscriber and dedupes a retry", async () => {
  const kv = fakeKv();
  await kv.put("leads:chat:1", "1");
  await kv.put("leads:chat:-2", "1");
  const sent: string[] = [];
  const send = async (chatId: string) => void sent.push(chatId);

  const first = await deliverLead({ lead, kv, send });
  assert.equal(first.delivered, 2);
  assert.deepEqual(sent.sort(), ["-2", "1"]);

  const retry = await deliverLead({ lead, kv, send });
  assert.equal(retry.delivered, 0);
  assert.equal(retry.skipped, 2);
  assert.equal(sent.length, 2);
  assert.equal(shouldRetry(retry), false);
});

test("deliverLead with nobody subscribed sends nothing, keeps no copy and does not ask for a retry", async () => {
  const kv = fakeKv();
  const result = await deliverLead({ lead, kv, send: async () => assert.fail("nobody to send to") });
  assert.equal(result.attempted, 0);
  assert.equal(shouldRetry(result), false);
  assert.equal(await kv.get("leads:recent"), null, "the site database is the only copy of a lead");
});

test("deliverLead unsubscribes dead chats and asks for a retry on transient failures", async () => {
  const kv = fakeKv();
  await kv.put("leads:chat:1", "1");
  await kv.put("leads:chat:2", "1");
  const send = async (chatId: string) => {
    if (chatId === "1") throw { error_code: 403, description: "Forbidden: bot was blocked by the user" };
    throw new Error("network down");
  };
  const result = await deliverLead({ lead, kv, send });
  assert.equal(result.removed, 1);
  assert.equal(result.transientFailures, 1);
  assert.equal(await kv.get("leads:chat:1"), null);
  assert.equal(await kv.get("leads:chat:2"), "1");
  assert.equal(shouldRetry(result), true);
});

test("shouldRetry is false once someone got the lead", () => {
  const partial: DeliveryResult = { attempted: 2, delivered: 1, skipped: 0, transientFailures: 1, removed: 0 };
  assert.equal(shouldRetry(partial), false);
});

test("isChatKey keeps private and group chat ids but not bookkeeping keys", () => {
  assert.equal(isChatKey("123456"), true);
  assert.equal(isChatKey("-1001234"), true);
  assert.equal(isChatKey("history"), false);
  assert.equal(isChatKey("leads:chat:1"), false);
});

test("safeEqual / bearerMatches", async () => {
  assert.equal(await safeEqual("creative", "creative"), true);
  assert.equal(await safeEqual("creative", "creativ"), false);
  const req = (auth?: string) => new Request("https://x/lead", { headers: auth ? { Authorization: auth } : {} });
  assert.equal(await bearerMatches(req("Bearer s3cret"), "s3cret"), true);
  assert.equal(await bearerMatches(req("Bearer nope"), "s3cret"), false);
  assert.equal(await bearerMatches(req("s3cret"), "s3cret"), false);
  assert.equal(await bearerMatches(req(), "s3cret"), false);
});
