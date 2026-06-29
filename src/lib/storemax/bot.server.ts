import { getServiceClient } from "./db.server";
import { hashPin, isValidPinFormat, verifyPin } from "./pin.server";
import { sendMessage, answerCallbackQuery, type ReplyMarkup } from "./telegram.server";
import { loadSession, saveSession, clearSession } from "./session.server";
import { logActivity } from "./logger.server";
import { notifyOwner } from "./notify.server";
import {
  openInventory,
  handleInventoryCallback,
  handleInventoryMessage,
} from "./inventory.server";
import { openSale, handleSaleCallback, handleSaleMessage } from "./sales.server";
import { openCustomers, handleCustomerCallback, handleCustomerMessage } from "./customers.server";
import { openSuppliers, handleSupplierCallback, handleSupplierMessage } from "./suppliers.server";
import { openStaff, handleStaffCallback, handleStaffMessage } from "./staff.server";
import { openExpenses, handleExpenseCallback, handleExpenseMessage } from "./expenses.server";
import { openReports, handleReportsCallback, mySalesToday } from "./reports.server";
import { openAI, handleAIMessage } from "./ai.server";
import { openSettings, handleSettingsCallback, handleSettingsMessage } from "./settings.server";
import { buildDailySummaryPdf } from "./pdf.server";
import { sendDocument } from "./telegram.server";

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
}
interface TgCallback {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallback;
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function fullName(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || `User ${u.id}`;
}

function mainMenu(role: "owner" | "sales_rep"): ReplyMarkup {
  if (role === "owner") {
    return {
      inline_keyboard: [
        [{ text: "🛒 New Sale", callback_data: "menu:sale" }, { text: "📦 Inventory", callback_data: "menu:inventory" }],
        [{ text: "👥 Customers", callback_data: "menu:customers" }, { text: "🚚 Suppliers", callback_data: "menu:suppliers" }],
        [{ text: "💰 Expenses", callback_data: "menu:expenses" }, { text: "📊 Reports", callback_data: "menu:reports" }],
        [{ text: "🧑‍💼 Staff", callback_data: "menu:staff" }, { text: "⚙️ Settings", callback_data: "menu:settings" }],
        [{ text: "🤖 Ask Assistant", callback_data: "menu:ai" }, { text: "🔒 Logout", callback_data: "auth:logout" }],
      ],
    };
  }
  return {
    inline_keyboard: [
      [{ text: "🛒 New Sale", callback_data: "menu:sale" }, { text: "🔎 Search Product", callback_data: "menu:search" }],
      [{ text: "📋 My Sales Today", callback_data: "menu:mysales" }, { text: "👥 Customers", callback_data: "menu:customers" }],
      [{ text: "🔒 Logout", callback_data: "auth:logout" }],
    ],
  };
}

async function getOrCreateUser(tg: TgUser) {
  const db = getServiceClient();
  const { data: existing } = await db.from("bot_users").select("*").eq("telegram_id", tg.id).maybeSingle();
  if (existing) return { user: existing, created: false };

  // First user in the system becomes the owner.
  const { count } = await db.from("bot_users").select("*", { count: "exact", head: true });
  const role = (count ?? 0) === 0 ? "owner" : "sales_rep";

  const { data: inserted } = await db
    .from("bot_users")
    .insert({
      telegram_id: tg.id,
      username: tg.username ?? null,
      full_name: fullName(tg),
      role,
      is_active: role === "owner", // sales reps must be activated by the owner
    })
    .select("*")
    .single();

  if (role === "owner") {
    await db.from("settings").upsert({ key: "owner_telegram_id", value: tg.id }, { onConflict: "key" });
  }
  return { user: inserted, created: true };
}

export async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (msg && msg.from && msg.text) {
    await handleMessage(msg as Required<TgMessage>);
    return;
  }
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
}

async function handleMessage(msg: { message_id: number; chat: { id: number }; from: TgUser; text: string }) {
  const tg = msg.from;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const { user, created } = await getOrCreateUser(tg);
  if (!user) {
    await sendMessage(chatId, "⚠️ Unable to register your account. Please try again.");
    return;
  }

  await logActivity({ user_id: user.id, telegram_id: tg.id, action: "message", meta: { text } });

  if (created && user.role === "owner") {
    await notifyOwner("system", "Owner account created", `${user.full_name} (@${user.username ?? "?"}) is now the system owner.`);
  }

  // /start command
  if (text === "/start" || text.toLowerCase() === "start") {
    await clearSession(tg.id);
    if (!user.is_active) {
      await sendMessage(
        chatId,
        `👋 Welcome <b>${escapeHtml(user.full_name)}</b>.\n\nYour account is pending approval by the owner.`,
      );
      await notifyOwner(
        "system",
        "New sales rep awaiting approval",
        `${user.full_name} (Telegram ID ${tg.id}) just opened the bot. Activate them from ⚙️ Settings → Staff.`,
        { telegram_id: tg.id, user_id: user.id },
      );
      return;
    }
    if (!user.pin_hash) {
      await saveSession(tg.id, { user_id: user.id, authenticated: false, state: "awaiting_new_pin", data: {} });
      await sendMessage(
        chatId,
        `🔐 <b>Set your PIN</b>\n\nWelcome, <b>${escapeHtml(user.full_name)}</b>. Send a 4–8 digit PIN to secure your account.\n\nYou will use this PIN every time you log in.`,
      );
      return;
    }
    await saveSession(tg.id, { user_id: user.id, authenticated: false, state: "awaiting_pin", data: {} });
    await sendMessage(chatId, `🔐 Welcome back, <b>${escapeHtml(user.full_name)}</b>. Please enter your PIN to continue.`);
    return;
  }

  if (text === "/help") {
    const ownerExtra = user.role === "owner"
      ? "\n• /resetpin &lt;telegram_id|@username&gt; — reset another user's PIN"
      : "";
    await sendMessage(
      chatId,
      `<b>STOREMAX POS — Help</b>\n\n• /start — log in or set up\n• /logout — end your session\n• /whoami — show your account${ownerExtra}\n\nAfter logging in, use the menu buttons.`,
    );
    return;
  }

  if (text === "/whoami") {
    await sendMessage(
      chatId,
      `👤 <b>${escapeHtml(user.full_name)}</b>\nRole: <code>${user.role}</code>\nStatus: ${user.is_active ? "Active ✅" : "Inactive ⛔"}`,
    );
    return;
  }

  if (text === "/logout") {
    await clearSession(tg.id);
    await sendMessage(chatId, "🔒 Logged out. Send /start to log in again.");
    return;
  }

  if (text === "/resetpin" || text.startsWith("/resetpin ") || text.startsWith("/resetpin@")) {
    if (user.role !== "owner") {
      await sendMessage(chatId, "⛔ Only the owner can reset PINs.");
      return;
    }
    const parts = text.split(/\s+/);
    const target = parts[1];
    if (!target) {
      await sendMessage(
        chatId,
        "🔑 <b>Reset PIN</b>\n\nUsage: <code>/resetpin &lt;telegram_id&gt;</code> or <code>/resetpin @username</code>",
      );
      return;
    }
    const db = getServiceClient();
    let query = db.from("bot_users").select("*");
    if (target.startsWith("@")) {
      query = query.eq("username", target.slice(1));
    } else if (/^\d+$/.test(target)) {
      query = query.eq("telegram_id", Number(target));
    } else {
      query = query.eq("username", target);
    }
    const { data: targetUser } = await query.maybeSingle();
    if (!targetUser) {
      await sendMessage(chatId, `❌ No user found matching <code>${escapeHtml(target)}</code>.`);
      return;
    }
    if (targetUser.id === user.id) {
      await sendMessage(chatId, "⚠️ Use a different method to reset your own PIN.");
      return;
    }
    await db
      .from("bot_users")
      .update({
        pin_hash: null,
        failed_login_count: 0,
        locked_until: null,
      })
      .eq("id", targetUser.id);
    await clearSession(targetUser.telegram_id);
    await logActivity({
      user_id: user.id,
      telegram_id: tg.id,
      action: "pin_reset",
      meta: { target_user_id: targetUser.id, target_telegram_id: targetUser.telegram_id },
    });
    await sendMessage(
      chatId,
      `✅ PIN reset for <b>${escapeHtml(targetUser.full_name)}</b>. They will be asked to set a new PIN on next /start.`,
    );
    try {
      await sendMessage(
        targetUser.telegram_id,
        "🔐 Your PIN has been reset by the owner. Send /start to set a new PIN.",
      );
    } catch {
      // target may not have an open chat; ignore
    }
    return;
  }

  // Session-driven flows
  const session = await loadSession(tg.id);
  const state = session?.state;

  if (state === "awaiting_new_pin") {
    if (!isValidPinFormat(text)) {
      await sendMessage(chatId, "❌ PIN must be 4–8 digits. Try again.");
      return;
    }
    const hash = await hashPin(text);
    const db = getServiceClient();
    await db.from("bot_users").update({ pin_hash: hash, last_login_at: new Date().toISOString() }).eq("id", user.id);
    await saveSession(tg.id, { user_id: user.id, authenticated: true, state: null, data: {} });
    await logActivity({ user_id: user.id, telegram_id: tg.id, action: "pin_set" });
    await sendMessage(chatId, "✅ PIN set. You are now logged in.", { reply_markup: mainMenu(user.role) });
    await sendMessage(chatId, mainMenuTitle(user), { reply_markup: mainMenu(user.role) });
    return;
  }

  if (state === "awaiting_pin") {
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000);
      await sendMessage(chatId, `⛔ Account locked. Try again in ${mins} minute(s).`);
      return;
    }
    if (!isValidPinFormat(text)) {
      await sendMessage(chatId, "❌ PIN must be 4–8 digits.");
      return;
    }
    const ok = await verifyPin(text, user.pin_hash);
    const db = getServiceClient();
    if (!ok) {
      const failed = (user.failed_login_count ?? 0) + 1;
      const patch: Record<string, unknown> = { failed_login_count: failed };
      if (failed >= MAX_FAILED) {
        patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
        patch.failed_login_count = 0;
      }
      await db.from("bot_users").update(patch).eq("id", user.id);
      await logActivity({ user_id: user.id, telegram_id: tg.id, action: "login_failed" });
      await notifyOwner(
        "failed_login",
        "Failed login attempt",
        `${user.full_name} entered an invalid PIN.${failed >= MAX_FAILED ? ` Account locked for ${LOCK_MINUTES} minutes.` : ""}`,
      );
      await sendMessage(chatId, "❌ Invalid PIN.");
      return;
    }
    await db
      .from("bot_users")
      .update({ failed_login_count: 0, locked_until: null, last_login_at: new Date().toISOString() })
      .eq("id", user.id);
    await saveSession(tg.id, { user_id: user.id, authenticated: true, state: null, data: {} });
    await logActivity({ user_id: user.id, telegram_id: tg.id, action: "login_success" });
    await sendMessage(chatId, mainMenuTitle(user), { reply_markup: mainMenu(user.role) });
    return;
  }

  // Default: require login
  if (!session?.authenticated) {
    await sendMessage(chatId, "Please send /start to log in.");
    return;
  }

  // Delegate to module message handlers based on session state
  const botUser = { id: user.id, telegram_id: tg.id, role: user.role, full_name: user.full_name };
  if (await handleSaleMessage(text, chatId, botUser)) return;
  if (await handleInventoryMessage(text, chatId, botUser)) return;
  if (await handleCustomerMessage(text, chatId, botUser)) return;
  if (await handleSupplierMessage(text, chatId, botUser)) return;
  if (await handleStaffMessage(text, chatId, botUser)) return;
  if (await handleExpenseMessage(text, chatId, botUser)) return;
  if (await handleAIMessage(text, chatId, botUser)) return;

  await sendMessage(chatId, "Use the menu below.", { reply_markup: mainMenu(user.role) });
}

async function handleCallback(cb: TgCallback) {
  const tg = cb.from;
  const chatId = cb.message?.chat.id;
  if (!chatId) {
    await answerCallbackQuery(cb.id);
    return;
  }
  const db = getServiceClient();
  const { data: user } = await db.from("bot_users").select("*").eq("telegram_id", tg.id).maybeSingle();
  if (!user) {
    await answerCallbackQuery(cb.id, "Please send /start");
    return;
  }
  const session = await loadSession(tg.id);
  const data = cb.data ?? "";

  if (data === "auth:logout") {
    await clearSession(tg.id);
    await answerCallbackQuery(cb.id, "Logged out");
    await sendMessage(chatId, "🔒 Logged out. Send /start to log in.");
    return;
  }

  if (!session?.authenticated) {
    await answerCallbackQuery(cb.id, "Please log in first");
    await sendMessage(chatId, "Please send /start to log in.");
    return;
  }

  const botUser = { id: user.id, telegram_id: tg.id, role: user.role, full_name: user.full_name };

  // Module callback routing
  if (await handleSaleCallback(data, chatId, botUser)) {
    await answerCallbackQuery(cb.id);
    return;
  }
  if (await handleInventoryCallback(data, chatId, botUser)) {
    await answerCallbackQuery(cb.id);
    return;
  }
  if (await handleCustomerCallback(data, chatId, botUser)) {
    await answerCallbackQuery(cb.id);
    return;
  }
  if (await handleSupplierCallback(data, chatId, botUser)) {
    await answerCallbackQuery(cb.id);
    return;
  }

  if (await handleStaffCallback(data, chatId, botUser)) {
    await answerCallbackQuery(cb.id);
    return;
  }
  if (await handleExpenseCallback(data, chatId, botUser)) {
    await answerCallbackQuery(cb.id);
    return;
  }
  if (await handleReportsCallback(data, chatId, botUser)) {
    await answerCallbackQuery(cb.id);
    return;
  }

  if (data === "menu:main") {
    await answerCallbackQuery(cb.id);
    await sendMessage(chatId, mainMenuTitle(user), { reply_markup: mainMenu(user.role) });
    return;
  }
  if (data === "menu:sale") {
    await answerCallbackQuery(cb.id);
    await openSale(chatId, botUser);
    return;
  }
  if (data === "menu:inventory") {
    await answerCallbackQuery(cb.id);
    await openInventory(chatId, botUser);
    return;
  }
  if (data === "menu:customers") {
    await answerCallbackQuery(cb.id);
    await openCustomers(chatId, botUser);
    return;
  }
  if (data === "menu:suppliers") {
    await answerCallbackQuery(cb.id);
    await openSuppliers(chatId, botUser);
    return;
  }
  if (data === "menu:staff") {
    await answerCallbackQuery(cb.id);
    await openStaff(chatId, botUser);
    return;
  }
  if (data === "menu:expenses") {
    await answerCallbackQuery(cb.id);
    await openExpenses(chatId, botUser);
    return;
  }
  if (data === "menu:reports") {
    await answerCallbackQuery(cb.id);
    await openReports(chatId, botUser);
    return;
  }
  if (data === "menu:ai") {
    await answerCallbackQuery(cb.id);
    await openAI(chatId, botUser);
    return;
  }
  if (data === "menu:mysales") {
    await answerCallbackQuery(cb.id);
    await mySalesToday(chatId, botUser);
    return;
  }
  if (data === "menu:search") {
    await answerCallbackQuery(cb.id);
    await openSale(chatId, botUser);
    return;
  }

  if (data.startsWith("menu:")) {
    await answerCallbackQuery(cb.id);
    await sendMessage(
      chatId,
      `🚧 <b>${data.slice(5).toUpperCase()}</b> module is coming soon.`,
      { reply_markup: mainMenu(user.role) },
    );
    return;
  }

  await answerCallbackQuery(cb.id);
}

function mainMenuTitle(user: { role: "owner" | "sales_rep"; full_name: string }): string {
  const greeting = user.role === "owner" ? "🛡️ Owner Console" : "🧾 Sales Console";
  return `${greeting}\n\nWelcome, <b>${escapeHtml(user.full_name)}</b>. What would you like to do?`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
