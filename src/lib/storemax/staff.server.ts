import { getServiceClient } from "./db.server";
import { sendMessage, type ReplyMarkup } from "./telegram.server";
import { loadSession, saveSession, clearSession } from "./session.server";
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

export function staffMenu(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "📋 List Staff", callback_data: "staff:list" }],
      [{ text: "✅ Pending Approval", callback_data: "staff:pending" }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ],
  };
}

export async function openStaff(chatId: number, user: BotUser) {
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Staff management is owner-only.", { reply_markup: BACK });
    return;
  }
  await sendMessage(chatId, "🧑‍💼 <b>Staff Management</b>\n\nChoose an action:", { reply_markup: staffMenu() });
}

async function showUser(chatId: number, targetId: string) {
  const db = getServiceClient();
  const { data: u } = await db.from("bot_users").select("*").eq("id", targetId).maybeSingle();
  if (!u) {
    await sendMessage(chatId, "User not found.", { reply_markup: staffMenu() });
    return;
  }
  const buttons: { text: string; callback_data: string }[][] = [];
  if (u.role !== "owner") {
    buttons.push([
      u.is_active
        ? { text: "⛔ Deactivate", callback_data: `staff:deact:${u.id}` }
        : { text: "✅ Activate", callback_data: `staff:act:${u.id}` },
    ]);
    buttons.push([{ text: "🔑 Reset PIN", callback_data: `staff:resetpin:${u.id}` }]);
  }
  buttons.push([{ text: "⬅️ Back", callback_data: "menu:staff" }]);

  await sendMessage(
    chatId,
    `👤 <b>${escapeHtml(u.full_name)}</b>\n` +
      `Username: @${escapeHtml(u.username ?? "—")}\n` +
      `Telegram ID: <code>${u.telegram_id}</code>\n` +
      `Role: <code>${u.role}</code>\n` +
      `Status: ${u.is_active ? "Active ✅" : "Inactive ⛔"}\n` +
      `Joined: ${new Date(u.created_at).toLocaleDateString()}`,
    { reply_markup: { inline_keyboard: buttons } },
  );
}

export async function handleStaffCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!data.startsWith("staff:")) return false;
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Owner only.", { reply_markup: BACK });
    return true;
  }
  const db = getServiceClient();

  if (data === "staff:list") {
    const { data: rows } = await db
      .from("bot_users")
      .select("id,full_name,username,role,is_active")
      .order("created_at")
      .limit(25);
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, "No staff yet.", { reply_markup: staffMenu() });
      return true;
    }
    const lines = rows.map(
      (u: any) =>
        `• <b>${escapeHtml(u.full_name)}</b> ${u.username ? `(@${escapeHtml(u.username)})` : ""} — ${u.role} ${u.is_active ? "✅" : "⛔"}`,
    );
    const buttons = rows.map((u: any) => [{ text: `${u.full_name} ${u.is_active ? "✅" : "⛔"}`.slice(0, 60), callback_data: `staff:view:${u.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:staff" }]);
    await sendMessage(chatId, `📋 <b>Staff (${rows.length})</b>\n\n${lines.join("\n")}`, {
      reply_markup: { inline_keyboard: buttons },
    });
    return true;
  }

  if (data === "staff:pending") {
    const { data: rows } = await db
      .from("bot_users")
      .select("id,full_name,username,telegram_id")
      .eq("is_active", false)
      .eq("role", "sales_rep")
      .order("created_at");
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, "✅ No pending approvals.", { reply_markup: staffMenu() });
      return true;
    }
    const buttons = rows.map((u: any) => [{ text: `${u.full_name} (@${u.username ?? u.telegram_id})`.slice(0, 60), callback_data: `staff:view:${u.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:staff" }]);
    await sendMessage(chatId, `⏳ <b>Pending Approval (${rows.length})</b>`, {
      reply_markup: { inline_keyboard: buttons },
    });
    return true;
  }

  if (data.startsWith("staff:view:")) {
    await showUser(chatId, data.slice("staff:view:".length));
    return true;
  }

  if (data.startsWith("staff:act:") || data.startsWith("staff:deact:")) {
    const activating = data.startsWith("staff:act:");
    const id = data.slice(activating ? "staff:act:".length : "staff:deact:".length);
    const { data: target } = await db.from("bot_users").select("id,full_name,role,telegram_id").eq("id", id).maybeSingle();
    if (!target || target.role === "owner") {
      await sendMessage(chatId, "Cannot modify this user.", { reply_markup: staffMenu() });
      return true;
    }
    await db.from("bot_users").update({ is_active: activating }).eq("id", id);
    if (!activating) await clearSession(target.telegram_id);
    await logActivity({
      user_id: user.id,
      telegram_id: user.telegram_id,
      action: activating ? "staff_activate" : "staff_deactivate",
      meta: { target_user_id: id },
    });
    await sendMessage(
      chatId,
      `${activating ? "✅ Activated" : "⛔ Deactivated"} <b>${escapeHtml(target.full_name)}</b>.`,
      { reply_markup: staffMenu() },
    );
    try {
      await sendMessage(
        target.telegram_id,
        activating
          ? "✅ Your account has been activated. Send /start to begin."
          : "⛔ Your account has been deactivated by the owner.",
      );
    } catch {}
    return true;
  }

  if (data.startsWith("staff:resetpin:")) {
    const id = data.slice("staff:resetpin:".length);
    const { data: target } = await db.from("bot_users").select("id,full_name,role,telegram_id").eq("id", id).maybeSingle();
    if (!target || target.role === "owner") {
      await sendMessage(chatId, "Cannot reset this user.", { reply_markup: staffMenu() });
      return true;
    }
    await db
      .from("bot_users")
      .update({ pin_hash: null, failed_login_count: 0, locked_until: null })
      .eq("id", id);
    await clearSession(target.telegram_id);
    await logActivity({
      user_id: user.id,
      telegram_id: user.telegram_id,
      action: "pin_reset",
      meta: { target_user_id: id },
    });
    await sendMessage(chatId, `🔑 PIN reset for <b>${escapeHtml(target.full_name)}</b>.`, { reply_markup: staffMenu() });
    try {
      await sendMessage(target.telegram_id, "🔐 Your PIN was reset. Send /start to set a new one.");
    } catch {}
    return true;
  }

  return false;
}

export async function handleStaffMessage(_text: string, _chatId: number, _user: BotUser): Promise<boolean> {
  const session = await loadSession(_user.telegram_id);
  if (!session?.state?.startsWith("staff:")) return false;
  // No text-input flows in staff currently; reserved for future.
  await saveSession(_user.telegram_id, { state: null, data: {} });
  return false;
}
