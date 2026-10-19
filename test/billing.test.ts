import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPaymentReminder, isReminderTick } from "../src/billing.ts";

test("reminder lists invoices, total and overdue state", () => {
  const text = formatPaymentReminder(
    [
      { id: "1", name: "Основной сервер", amount: 799, due: "2026-10-17" },
      { id: "2", name: "VPN", amount: 499, due: "2026-10-22" },
    ],
    new Date("2026-10-20T06:00:00Z"),
  );
  assert.ok(text);
  assert.match(text, /Основной сервер — счёт 1, 799 руб\., до 17\.10\.2026 \(просрочен\)/);
  assert.match(text, /VPN — счёт 2, 499 руб\., до 22\.10\.2026 \(ещё 2 дн\.\)/);
  assert.match(text, /Итого: 1298 руб\./);
});

test("no invoices -> no reminder", () => {
  assert.equal(formatPaymentReminder([]), null);
});

test("reminder fires only in the 09:00 MSK tick", () => {
  assert.equal(isReminderTick(Date.parse("2026-10-20T06:00:00Z")), true);
  assert.equal(isReminderTick(Date.parse("2026-10-20T06:10:00Z")), false);
  assert.equal(isReminderTick(Date.parse("2026-10-20T07:00:00Z")), false);
});
