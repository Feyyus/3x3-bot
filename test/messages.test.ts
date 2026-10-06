import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAlert, formatHistory, formatStatus } from "../src/messages.ts";
import type { HealthResult, IncidentEntry, SiteResult } from "../src/monitor.ts";

const site = (url: string, ok: boolean, code: string): SiteResult => ({ url, ok, code, attempts: 1, elapsedMs: 10 });
const healthy: HealthResult = { ok: true, attempts: 1, data: { disk_percent: 40, mem_percent: 30 } };

test("alert lists only what is down, in the shared HTML style", () => {
  const text = formatAlert([site("https://3x3.team", false, "таймаут >5000мс")], healthy);
  assert.match(text, /^🚨 <b>Сбой<\/b> · 3x3\.team/);
  assert.match(text, /🌐 https:\/\/3x3\.team — таймаут/);
  assert.doesNotMatch(text, /Рабочая станция/);
  assert.match(text, /🕒 .* МСК$/);
});

test("alert reports the workstation problem", () => {
  const text = formatAlert([], { ok: false, warnings: ["диск заполнен на 90%"], attempts: 1 });
  assert.match(text, /🖥 Рабочая станция — диск заполнен на 90%/);
});

test("alert escapes markup coming from remote error text", () => {
  const text = formatAlert([site("https://x", false, "<b>boom</b> & co")], healthy);
  assert.doesNotMatch(text, /<b>boom/);
  assert.match(text, /&lt;b&gt;boom&lt;\/b&gt; &amp; co/);
});

test("status shows a line per site plus the workstation", () => {
  const text = formatStatus([site("https://a", true, "200"), site("https://b", false, "503")], healthy);
  assert.match(text, /^📊 <b>Статус<\/b>/);
  assert.match(text, /✅ https:\/\/a — 200/);
  assert.match(text, /⚠️ https:\/\/b — 503/);
  assert.match(text, /✅ Рабочая станция — диск 40%, память 30%/);
});

test("history prints Moscow time, newest first, and an empty state", () => {
  assert.match(formatHistory([]), /Пока не было/);
  const list: IncidentEntry[] = [
    { time: "2026-10-06T21:30:00Z", down: [{ url: "https://old", code: "500", attempts: 3 }], health: null },
    { time: "2026-10-07T10:00:00Z", down: [], health: { reason: "диск 90%", attempts: 3 } },
  ];
  const text = formatHistory(list);
  assert.match(text, /последние 2/);
  assert.ok(text.indexOf("07.10 13:00 МСК") < text.indexOf("07.10 00:30 МСК"));
  assert.match(text, /• Рабочая станция — диск 90%/);
  assert.doesNotMatch(text, /2026-10/);
});
