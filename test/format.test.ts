import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, formatLead, formatMoscowTime, formatRecent, packMessages } from "../src/format.ts";

test("escapeHtml neutralises tags and ampersands", () => {
  assert.equal(escapeHtml("<b>&x</b>"), "&lt;b&gt;&amp;x&lt;/b&gt;");
});

test("formatMoscowTime applies a fixed UTC+3 offset", () => {
  assert.equal(formatMoscowTime("2026-10-06T21:30:00Z"), "07.10 00:30 МСК");
  assert.equal(formatMoscowTime("not a date"), "");
});

test("formatLead renders only the fields that are present", () => {
  const text = formatLead({ id: 1, name: "Иван", phone: "+7 900 000-00-00" });
  assert.match(text, /Заявка с сайта/);
  assert.match(text, /#site/);
  assert.match(text, /👤 Иван/);
  assert.match(text, /📞/);
  assert.doesNotMatch(text, /✉️|🏢|🛠|💬|📎|🔗/);
});

test("formatLead escapes user text and never lets it inject markup", () => {
  const text = formatLead({ id: 1, name: "<script>", message: "<a href=x>hi</a>" });
  assert.doesNotMatch(text, /<script>|<a href=x>/);
  assert.match(text, /&lt;script&gt;/);
});

test("formatLead trims a long message", () => {
  const text = formatLead({ id: 1, message: "я".repeat(3000) });
  assert.ok(text.length < 1700);
  assert.match(text, /…/);
});

test("formatLead only links http(s) urls and escapes quotes in them", () => {
  const bad = formatLead({ id: 1, briefUrl: "javascript:alert(1)", leadUrl: "ftp://x" });
  assert.doesNotMatch(bad, /href/);
  const ok = formatLead({ id: 1, leadUrl: 'https://3x3.team/admin/leads/1?a="b"' });
  assert.match(ok, /href="https:\/\/3x3\.team\/admin\/leads\/1\?a=&quot;b&quot;"/);
});

test("formatLead omits the default source and shows custom ones", () => {
  assert.doesNotMatch(formatLead({ id: 1, source: "site" }), /📍/);
  assert.match(formatLead({ id: 1, source: "hero-form" }), /📍 hero-form/);
});

test("packMessages splits blocks over the limit", () => {
  assert.deepEqual(packMessages(["aaa", "bbb"], 100), ["aaa\n\nbbb"]);
  assert.deepEqual(packMessages(["aaa", "bbb"], 5), ["aaa", "bbb"]);
});

test("formatRecent caps to count", () => {
  const leads = Array.from({ length: 8 }, (_, i) => ({ id: i, name: `n${i}` }));
  const joined = formatRecent(leads, 5).join("\n\n");
  assert.equal(joined.split("Заявка с сайта").length - 1, 5);
});
