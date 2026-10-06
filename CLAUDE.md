# 3x3 bot

Общий Telegram-бот сайта 3x3.team (grammY на Cloudflare Workers, TypeScript).
Две задачи:

- **Аптайм.** Cron раз в 10 минут проверяет 3x3.team + ecom-landing и `status.json`
  рабочей станции (диск), пишет подписанным чатам только при сбое. `/history` — последние
  30 инцидентов (в KV). Транзиентные сетевые блипы ретраятся (2 попытки, 300/800 мс) до того,
  как считаться падением — см. комментарии в `src/monitor.ts`. Алерты включены у любого,
  кто нажал `/start`.
- **Заявки с сайта.** Laravel (`3x3-site-laravel`, джоба `SendLeadToTelegram`) шлёт
  `POST /lead` с `Authorization: Bearer <RELAY_SECRET>`; Worker сохраняет заявку и рассылает
  подписанным чатам. Доступ **только по секретному коду**: `/start <LEADS_CODE>` (в заявках
  телефоны). Повтор той же заявки дедуплицируется по id (`leads:sent:<id>:<chat>`). Если
  подписчики есть, но доставка не удалась из-за Telegram — отвечает 502, и Laravel повторяет.

## Интерфейс бота

Один экран-меню (`/start`, `/menu`, `src/ui.ts`): два переключателя (алерты, заявки), кнопки
«Последние заявки», «Статус», «История». Кнопки правят это же сообщение. Блок заявок виден только
чатам, которые вводили код (неподписанный чат не видит и не угадывает, что код есть). «Выключить
заявки» только мьютит (`leads:chat:<id>` = `off`), доступ остаётся; полностью доступ снимается
только когда Telegram говорит, что чата нет. Скрытые алиасы: `/lastleads`, `/stop_leads`.
Все сообщения HTML в одном стиле (`format.ts` → `header`/`row`, `messages.ts`), время по МСК.

Профиль бота (меню команд, описания) ставит `ensureProfile` (`src/profile.ts`) из cron, один раз на
`PROFILE_VERSION` (флаг KV `meta:profile`). Поменял команды или тексты — подними версию и задеплой.
Имя бота («3x3 Bot») меняется только вручную в BotFather.

`staffing-leads` — отдельный сервис со своим ботом, с этим Worker-ом не связан.

## Структура

`src/index.ts` — роутинг и cron; `bot.ts` — обработчики; `ui.ts` — меню; `messages.ts` — алерт/статус/
история; `monitor.ts` — проверки; `leads.ts` — подписки/дедуп/доставка; `format.ts` — заявка и общие
хелперы; `profile.ts` — меню команд; `security.ts` — constant-time сравнение; `env.ts`,
`lead-types.ts` — типы. Тесты бота идут без сети: `bot.handleUpdate` + перехват исходящих вызовов
(`test/bot.test.ts`). Только erasable-синтаксис TS (без
enum/namespace/parameter properties), импорты с `.ts`, `import type`, без `any`.

Проверка: `npm ci && npm run typecheck && npm test` (`node --test` по `.ts`, Node >= 22.18).

## KV и секреты

- `SUBSCRIBERS` KV: голые числовые ключи (chat id) = подписка на алерты (`on`/`off`),
  `history` = JSON инцидентов, `leads:chat:<id>` = подписка на заявки, `leads:recent` = последние 20,
  `leads:sent:*` = дедуп (TTL 2 суток). Cron шлёт алерты только на ключи вида `-?\d+`.
- Secrets (`wrangler secret put`, не в репо): `TELEGRAM_BOT_TOKEN`, `RELAY_SECRET`, `LEADS_CODE`.
  Локально — `.dev.vars` (в `.gitignore`).

## Deploy

**Via GitHub Actions, not manually.** Push to `master` (touching `src/**`, `test/**`,
`wrangler.toml`, `tsconfig.json` or `package.json`) triggers `.github/workflows/deploy.yml`:
typecheck + тесты, затем `wrangler deploy` с секретом `CLOUDFLARE_API_TOKEN`.
Don't run `wrangler deploy`/`npm run deploy` from a local machine — it'll
still work (same Worker), but then the deployed code and git history can
drift out of sync silently. If you must deploy from local (CI down, urgent
fix), push immediately after so `master` matches what's live.
