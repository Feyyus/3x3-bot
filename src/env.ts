export interface Env {
  // chat subscribe state (bare chat id keys = alerts), `history`, and `leads:*` keys
  SUBSCRIBERS: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  // Bearer secret shared with the Laravel site (POST /lead)
  RELAY_SECRET?: string;
  // `/start <code>` subscribes a chat to site leads
  LEADS_CODE?: string;
}
