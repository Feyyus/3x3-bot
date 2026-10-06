import type { Env } from "./env.ts";

// ecom (31.28.5.203) убран — Cloudflare Workers режет fetch() на голый IP по
// plain HTTP ещё до выхода наружу (подтверждено: запрос не долетает до
// сервера вообще, см. nginx access.log). Вернуть, когда у ecom появится
// собственный домен.
const SITES = ["https://3x3.team", "https://ecom.try.3x3.team", "https://tracker.3x3.team"];

const DISK_WARN_PERCENT = 85;

const FETCH_TIMEOUT_MS = 5000;

// Задержки перед повторной попыткой: секундный сетевой блип (как 23.09 в 00:00
// и 04:00 — запрос не долетал до сервера вообще, см. историю чата) не должен
// считаться падением. Реальное падение переживёт все три попытки.
const RETRY_DELAYS_MS = [300, 800];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SiteResult {
  url: string;
  ok: boolean;
  code: string;
  attempts: number;
  elapsedMs: number;
}

export interface StatusData {
  disk_percent?: number;
  mem_percent?: number;
}

export interface HealthResult {
  ok: boolean;
  reason?: string;
  warnings?: string[];
  data?: StatusData;
  attempts: number;
  elapsedMs?: number;
}

interface Attempt {
  ok: boolean;
  code: string;
  elapsedMs: number;
}

interface ErrorLike {
  name?: string;
  message?: string;
  cause?: { message?: string; code?: string };
}

// Разбирает причину сетевой ошибки на человеческий текст, чтобы в логе и
// алерте сразу было видно ЧТО сломалось: таймаут / DNS / TLS / отказ в
// соединении / сброс — а не просто "нет ответа".
export function classifyError(err: unknown): string {
  const e = (err ?? {}) as ErrorLike;
  if (e.name === "TimeoutError" || e.name === "AbortError") {
    return `таймаут >${FETCH_TIMEOUT_MS}мс`;
  }
  const msg = e.message ?? String(err);
  const causeMsg = e.cause?.message ?? e.cause?.code ?? "";
  const haystack = `${msg} ${causeMsg}`;
  if (/dns|ENOTFOUND|EAI_AGAIN|resolve/i.test(haystack)) return `DNS не резолвится (${msg})`;
  if (/ECONNREFUSED|refused/i.test(haystack)) return `соединение отклонено (${msg})`;
  if (/ECONNRESET|reset/i.test(haystack)) return `соединение сброшено (${msg})`;
  if (/certificate|SSL|TLS/i.test(haystack)) return `TLS-ошибка (${msg})`;
  return causeMsg ? `${e.name ?? "Error"}: ${msg} (cause: ${causeMsg})` : `${e.name ?? "Error"}: ${msg}`;
}

async function fetchSiteOnce(url: string): Promise<Attempt> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual", // видим первый прыжок как есть, не даём fetch тихо уйти на другой хост
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 (uptime-check; 3x3-internal-monitoring)",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get("location") : null;
    return {
      ok: res.status >= 200 && res.status < 300,
      code: location ? `${res.status} -> ${location}` : String(res.status),
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, code: classifyError(err), elapsedMs: Date.now() - started };
  }
}

async function checkOneSite(url: string): Promise<SiteResult> {
  const attempts: Attempt[] = [];
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    const attempt = await fetchSiteOnce(url);
    attempts.push(attempt);
    if (attempt.ok) break;
    const delay = RETRY_DELAYS_MS[i];
    if (delay !== undefined) await sleep(delay);
  }
  const last = attempts[attempts.length - 1] as Attempt; // loop always pushes at least once
  const recovered = last.ok && attempts.length > 1;
  if (!last.ok || recovered) {
    console.log(
      `[check] ${url}`,
      JSON.stringify(attempts.map((a) => ({ ok: a.ok, code: a.code, ms: a.elapsedMs }))),
    );
  }
  return {
    url,
    ok: last.ok,
    code: recovered ? `${last.code} (ожил после ${attempts.length} попыт${attempts.length === 2 ? "ки" : "ок"})` : last.code,
    attempts: attempts.length,
    elapsedMs: last.elapsedMs,
  };
}

export function checkSites(): Promise<SiteResult[]> {
  return Promise.all(SITES.map(checkOneSite));
}

export async function checkServerHealth(): Promise<HealthResult> {
  const attempts: { ok: false; reason: string; elapsedMs: number }[] = [];
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    const started = Date.now();
    try {
      const res = await fetch("https://3x3.team/status.json", {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const elapsedMs = Date.now() - started;
      if (!res.ok) {
        attempts.push({ ok: false, reason: `status.json вернул ${res.status}`, elapsedMs });
      } else {
        const data = (await res.json()) as StatusData;
        const warnings: string[] = [];
        if ((data.disk_percent ?? 0) >= DISK_WARN_PERCENT) {
          warnings.push(`диск заполнен на ${data.disk_percent}%`);
        }
        if (i > 0) console.log("[health] ожил после ретрая", JSON.stringify(attempts));
        return { ok: warnings.length === 0, warnings, data, elapsedMs, attempts: i + 1 };
      }
    } catch (err) {
      attempts.push({ ok: false, reason: classifyError(err), elapsedMs: Date.now() - started });
    }
    const delay = RETRY_DELAYS_MS[i];
    if (delay !== undefined) await sleep(delay);
  }
  console.log("[health] все попытки провалились", JSON.stringify(attempts));
  const last = attempts[attempts.length - 1];
  return { ok: false, reason: last?.reason, attempts: attempts.length };
}

export interface IncidentEntry {
  time: string;
  down: { url: string; code: string; attempts: number }[];
  health: { reason?: string; attempts: number } | null;
}

// Хранит последние 30 зафиксированных инцидентов в KV, чтобы /history мог
// показать разбор причины сбоя без пересборки контекста через ssh заново.
export async function logIncident(env: Env, down: SiteResult[], health: HealthResult): Promise<void> {
  const entry: IncidentEntry = {
    time: new Date().toISOString(),
    down: down.map((r) => ({ url: r.url, code: r.code, attempts: r.attempts })),
    health: health.ok ? null : { reason: health.reason ?? health.warnings?.join(", "), attempts: health.attempts },
  };
  const raw = await env.SUBSCRIBERS.get("history");
  const list: IncidentEntry[] = raw ? JSON.parse(raw) : [];
  list.push(entry);
  while (list.length > 30) list.shift();
  await env.SUBSCRIBERS.put("history", JSON.stringify(list));
}

// Алерты уходят только на ключи-чаты. В том же KV лежат `history` и `leads:*`:
// без фильтра они попадали бы в рассылку как chat_id.
export const isChatKey = (name: string): boolean => /^-?\d+$/.test(name);
