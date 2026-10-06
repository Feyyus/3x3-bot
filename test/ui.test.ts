import { test } from "node:test";
import assert from "node:assert/strict";
import { CB, menuKeyboard, menuText } from "../src/ui.ts";

const buttons = (kb: ReturnType<typeof menuKeyboard>) => kb.inline_keyboard.flat().map((b) => ({ text: b.text, data: "callback_data" in b ? b.callback_data : undefined }));

test("menu without leads access hides the whole leads block", () => {
  const state = { alerts: true, leads: null };
  const text = menuText(state);
  assert.match(text, /Алерты о сбоях — включены/);
  assert.doesNotMatch(text, /Заявки/);
  const data = buttons(menuKeyboard(state)).map((b) => b.data);
  assert.deepEqual(data, [CB.toggleAlerts, CB.status, CB.history]);
});

test("menu with leads on shows the block and every leads button", () => {
  const state = { alerts: true, leads: true };
  assert.match(menuText(state), /Заявки с сайта — включены/);
  const b = buttons(menuKeyboard(state));
  assert.deepEqual(b.map((x) => x.data), [CB.toggleAlerts, CB.toggleLeads, CB.lastLeads, CB.status, CB.history]);
  assert.match(b.find((x) => x.data === CB.toggleLeads)?.text ?? "", /Выключить заявки/);
});

test("muted leads and alerts flip both labels", () => {
  const state = { alerts: false, leads: false };
  const text = menuText(state);
  assert.match(text, /Алерты о сбоях — выключены/);
  assert.match(text, /Заявки с сайта — выключены/);
  const b = buttons(menuKeyboard(state));
  assert.match(b.find((x) => x.data === CB.toggleAlerts)?.text ?? "", /Включить алерты/);
  assert.match(b.find((x) => x.data === CB.toggleLeads)?.text ?? "", /Включить заявки/);
});

test("menu notice goes above the status block", () => {
  const text = menuText({ alerts: true, leads: true }, "📩 Заявки с сайта подключены.");
  assert.ok(text.indexOf("подключены") < text.indexOf("Алерты о сбоях"));
});

test("callback data fits Telegram's 64-byte limit", () => {
  for (const v of Object.values(CB)) assert.ok(new TextEncoder().encode(v).length <= 64, v);
});
