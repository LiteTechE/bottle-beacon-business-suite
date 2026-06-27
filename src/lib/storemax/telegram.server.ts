// Telegram Bot API client routed through the Lovable connector gateway.

const GATEWAY = "https://connector-gateway.lovable.dev/telegram";

function authHeaders(): Record<string, string> {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const telegramKey = process.env.TELEGRAM_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!telegramKey) throw new Error("TELEGRAM_API_KEY is not configured");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": telegramKey,
    "Content-Type": "application/json",
  };
}

export type InlineKeyboardButton = { text: string; callback_data?: string; url?: string };
export type ReplyMarkup = { inline_keyboard: InlineKeyboardButton[][] };

export async function tgCall<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${GATEWAY}/${method}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed [${res.status}]: ${data.description ?? JSON.stringify(data)}`);
  }
  return data.result as T;
}

export async function sendMessage(
  chatId: number,
  text: string,
  opts: { reply_markup?: ReplyMarkup; parse_mode?: "HTML" | "MarkdownV2" } = {},
) {
  return tgCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode ?? "HTML",
    reply_markup: opts.reply_markup,
  });
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  opts: { reply_markup?: ReplyMarkup; parse_mode?: "HTML" | "MarkdownV2" } = {},
) {
  return tgCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: opts.parse_mode ?? "HTML",
    reply_markup: opts.reply_markup,
  });
}

export async function answerCallbackQuery(id: string, text?: string) {
  return tgCall("answerCallbackQuery", { callback_query_id: id, text });
}

export async function deriveWebhookSecret(): Promise<string> {
  const telegramKey = process.env.TELEGRAM_API_KEY;
  if (!telegramKey) throw new Error("TELEGRAM_API_KEY is not configured");
  const data = new TextEncoder().encode(`telegram-webhook:${telegramKey}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  // base64url
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
