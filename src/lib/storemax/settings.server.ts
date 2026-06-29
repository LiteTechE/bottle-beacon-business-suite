// Settings module — business info + system preferences stored in `settings` key/value table.
import { getServiceClient } from "./db.server";
import { sendMessage, type ReplyMarkup } from "./telegram.server";
import { loadSession, saveSession } from "./session.server";
import { logActivity } from "./logger.server";

interface BotUser {
  id: string;
  telegram_id: number;
  role: "owner" | "sales_rep";
  full_name: string;
}

const BACK: ReplyMarkup = {
  inline_keyboard: [[{ text: "⬅️ Back to Menu", callback_data: "menu:main" }]],
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface StoreSettings {
  business_name: string;
  business_address: string;
  business_phone: string;
  currency_symbol: string;
  low_stock_default: number;
  large_sale_threshold: number;
  daily_summary_enabled: boolean;
}

const DEFAULTS: StoreSettings = {
  business_name: "STOREMAX LIMITED",
  business_address: "",
  business_phone: "",
  currency_symbol: "₦",
  low_stock_default: 5,
  large_sale_threshold: 100000,
  daily_summary_enabled: true,
};

export async function getSettings(): Promise<StoreSettings> {
  const db = getServiceClient();
  const { data } = await db.from("settings").select("key,value");
  const map = new Map<string, unknown>();
  for (const row of data ?? []) map.set((row as any).key, (row as any).value);
  const read = <K extends keyof StoreSettings>(k: K): StoreSettings[K] => {
    const v = map.get(k as string);
    if (v === undefined || v === null) return DEFAULTS[k];
    if (typeof DEFAULTS[k] === "number") return Number(v) as StoreSettings[K];
    if (typeof DEFAULTS[k] === "boolean") return Boolean(v) as StoreSettings[K];
    return String(v) as StoreSettings[K];
  };
  return {
    business_name: read("business_name"),
    business_address: read("business_address"),
    business_phone: read("business_phone"),
    currency_symbol: read("currency_symbol"),
    low_stock_default: read("low_stock_default"),
    large_sale_threshold: read("large_sale_threshold"),
    daily_summary_enabled: read("daily_summary_enabled"),
  };
}

async function setSetting(key: keyof StoreSettings, value: unknown) {
  const db = getServiceClient();
  await db.from("settings").upsert({ key, value }, { onConflict: "key" });
}

function settingsMenu(s: StoreSettings): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: `🏢 Business: ${s.business_name}`.slice(0, 60), callback_data: "set:edit:business_name" }],
      [{ text: `📍 Address: ${s.business_address || "—"}`.slice(0, 60), callback_data: "set:edit:business_address" }],
      [{ text: `📞 Phone: ${s.business_phone || "—"}`.slice(0, 60), callback_data: "set:edit:business_phone" }],
      [{ text: `💱 Currency: ${s.currency_symbol}`, callback_data: "set:edit:currency_symbol" }],
      [{ text: `📉 Low-stock default: ${s.low_stock_default}`, callback_data: "set:edit:low_stock_default" }],
      [{ text: `💸 Large-sale alert: ${s.large_sale_threshold}`, callback_data: "set:edit:large_sale_threshold" }],
      [{ text: `📅 Daily summary: ${s.daily_summary_enabled ? "ON ✅" : "OFF ⛔"}`, callback_data: "set:toggle:daily_summary_enabled" }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ],
  };
}

export async function openSettings(chatId: number, user: BotUser) {
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Settings are owner-only.", { reply_markup: BACK });
    return;
  }
  const s = await getSettings();
  await sendMessage(
    chatId,
    `⚙️ <b>System Settings</b>\n\nTap a field to edit it.`,
    { reply_markup: settingsMenu(s) },
  );
}

const PROMPTS: Record<string, string> = {
  business_name: "Send the new <b>business name</b>:",
  business_address: "Send the new <b>business address</b>:",
  business_phone: "Send the new <b>business phone</b>:",
  currency_symbol: "Send the new <b>currency symbol</b> (e.g. ₦, $, €):",
  low_stock_default: "Send the new <b>low-stock default level</b> (a whole number):",
  large_sale_threshold: "Send the new <b>large-sale alert threshold</b> (numeric, in your currency):",
};

export async function handleSettingsCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!data.startsWith("set:")) return false;
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Owner only.", { reply_markup: BACK });
    return true;
  }

  if (data.startsWith("set:edit:")) {
    const field = data.slice("set:edit:".length);
    const prompt = PROMPTS[field];
    if (!prompt) return true;
    await saveSession(user.telegram_id, { state: `settings:edit:${field}`, data: {} });
    await sendMessage(chatId, `✏️ ${prompt}`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "menu:settings" }]] },
    });
    return true;
  }

  if (data === "set:toggle:daily_summary_enabled") {
    const s = await getSettings();
    await setSetting("daily_summary_enabled", !s.daily_summary_enabled);
    await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: "settings_update", meta: { key: "daily_summary_enabled", value: !s.daily_summary_enabled } });
    const updated = await getSettings();
    await sendMessage(chatId, "✅ Updated.", { reply_markup: settingsMenu(updated) });
    return true;
  }

  return false;
}

export async function handleSettingsMessage(text: string, chatId: number, user: BotUser): Promise<boolean> {
  const session = await loadSession(user.telegram_id);
  const state = session?.state;
  if (!state?.startsWith("settings:edit:")) return false;
  if (user.role !== "owner") return false;

  const field = state.slice("settings:edit:".length) as keyof StoreSettings;
  let value: unknown = text.trim();
  if (field === "low_stock_default" || field === "large_sale_threshold") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      await sendMessage(chatId, "❌ Please send a valid non-negative number.");
      return true;
    }
    value = n;
  }
  await setSetting(field, value);
  await saveSession(user.telegram_id, { state: null, data: {} });
  await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: "settings_update", meta: { key: field, value } });
  const s = await getSettings();
  await sendMessage(chatId, `✅ <b>${field}</b> updated.`, { reply_markup: settingsMenu(s) });
  return true;
}
