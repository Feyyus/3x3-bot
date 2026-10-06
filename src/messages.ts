import { escapeHtml, formatMoscowTime, header, nowMoscow, row } from "./format.ts";
import type { HealthResult, IncidentEntry, SiteResult } from "./monitor.ts";

const healthProblem = (health: HealthResult): string => health.reason ?? health.warnings?.join(", ") ?? "нет данных";

// Cron alert: only sent when something is down.
export function formatAlert(down: SiteResult[], health: HealthResult): string {
  const lines = [header("🚨", "Сбой", "3x3.team")];
  for (const r of down) lines.push(row("🌐", `${escapeHtml(r.url)} — ${escapeHtml(r.code)}`));
  if (!health.ok) lines.push(row("🖥", `Рабочая станция — ${escapeHtml(healthProblem(health))}`));
  lines.push(row("🕒", nowMoscow()));
  return lines.join("\n");
}

export function formatStatus(results: SiteResult[], health: HealthResult): string {
  const lines = [header("📊", "Статус")];
  for (const r of results) lines.push(row(r.ok ? "✅" : "⚠️", `${escapeHtml(r.url)} — ${escapeHtml(r.code)}`));
  lines.push(
    health.ok
      ? row("✅", `Рабочая станция — диск ${health.data?.disk_percent ?? "?"}%, память ${health.data?.mem_percent ?? "?"}%`)
      : row("⚠️", `Рабочая станция — ${escapeHtml(healthProblem(health))}`),
  );
  lines.push(row("🕒", nowMoscow()));
  return lines.join("\n");
}

// Newest first, capped at `count`.
export function formatHistory(list: IncidentEntry[], count = 10): string {
  if (list.length === 0) return `${header("🕒", "Инциденты")}\nПока не было.`;
  const last = list.slice(-count).reverse();
  const blocks = last.map((entry) => {
    const lines = [`<b>${formatMoscowTime(entry.time) || escapeHtml(entry.time)}</b>`];
    for (const d of entry.down) lines.push(`• ${escapeHtml(d.url)} — ${escapeHtml(d.code)}`);
    if (entry.health) lines.push(`• Рабочая станция — ${escapeHtml(entry.health.reason ?? "нет данных")}`);
    return lines.join("\n");
  });
  return `${header("🕒", "Инциденты", `последние ${last.length}`)}\n\n${blocks.join("\n\n")}`;
}
