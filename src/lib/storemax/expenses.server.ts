import { getServiceClient } from "./db.server";
import { sendMessage, type ReplyMarkup } from "./telegram.server";
import { loadSession, saveSession } from "./session.server";
import { logActivity } from "./logger.server";
import { notifyOwner } from "./notify.server";

interface BotUser {
  id: string;
  telegram_id: number;
  role: "owner" | "sales_rep";
  full_name: string;
}

const CATEGORIES = ["fuel", "electricity", "transport", "rent", "salary", "miscellaneous"] as const;
type Category = typeof CATEGORIES[number];

const BACK: ReplyMarkup = {
  inline_keyboard: [[{ text: "⬅️ Back to Menu", callback_data: "menu:main" }]],
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtMoney(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function expensesMenu(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Add Expense", callback_data: "exp:add" }],
      [{ text: "📅 Today", callback_data: "exp:today" }, { text: "🗓 This Month", callback_data: "exp:month" }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ],
  };
}

export async function openExpenses(chatId: number, user: BotUser) {
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Expenses are restricted to the owner.", { reply_markup: BACK });
    return;
  }
  await sendMessage(chatId, "💰 <b>Expenses</b>\n\nChoose an action:", { reply_markup: expensesMenu() });
}

function categoryKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      ...CATEGORIES.map((c) => [{ text: c.charAt(0).toUpperCase() + c.slice(1), callback_data: `exp:cat:${c}` }]),
      [{ text: "⬅️ Cancel", callback_data: "menu:expenses" }],
    ],
  };
}

async function listExpenses(chatId: number, fromIso: string, label: string) {
  const db = getServiceClient();
  const { data: rows } = await db
    .from("expenses")
    .select("amount,category,note,spent_on,created_at")
    .gte("spent_on", fromIso)
    .order("spent_on", { ascending: false })
    .limit(50);
  if (!rows || rows.length === 0) {
    await sendMessage(chatId, `No expenses for ${label}.`, { reply_markup: expensesMenu() });
    return;
  }
  const total = rows.reduce((s: number, e: any) => s + Number(e.amount), 0);
  const lines = rows.map(
    (e: any) =>
      `• ${new Date(e.spent_on).toLocaleDateString()} — <b>${e.category}</b> ₦${fmtMoney(e.amount)}${e.note ? ` — ${escapeHtml(e.note)}` : ""}`,
  );
  await sendMessage(
    chatId,
    `💰 <b>Expenses — ${label}</b>\n\n${lines.join("\n")}\n\n<b>Total: ₦${fmtMoney(total)}</b>`,
    { reply_markup: expensesMenu() },
  );
}

export async function handleExpenseCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!data.startsWith("exp:")) return false;
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Owner only.", { reply_markup: BACK });
    return true;
  }

  if (data === "exp:add") {
    await saveSession(user.telegram_id, {
      user_id: user.id,
      authenticated: true,
      state: "exp:add:category",
      data: {},
    });
    await sendMessage(chatId, "➕ <b>New Expense</b>\n\nPick a category:", { reply_markup: categoryKeyboard() });
    return true;
  }

  if (data.startsWith("exp:cat:")) {
    const cat = data.slice("exp:cat:".length) as Category;
    if (!CATEGORIES.includes(cat)) return true;
    await saveSession(user.telegram_id, { state: "exp:add:amount", data: { category: cat } });
    await sendMessage(chatId, `Category: <b>${cat}</b>\n\nSend the <b>amount</b> (₦).`);
    return true;
  }

  if (data === "exp:today") {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    await listExpenses(chatId, today.toISOString().slice(0, 10), "Today");
    return true;
  }

  if (data === "exp:month") {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
    await listExpenses(chatId, d.toISOString().slice(0, 10), "This Month");
    return true;
  }

  return false;
}

export async function handleExpenseMessage(text: string, chatId: number, user: BotUser): Promise<boolean> {
  const session = await loadSession(user.telegram_id);
  const state = session?.state ?? "";
  if (!state.startsWith("exp:")) return false;
  if (user.role !== "owner") return false;
  const sData = (session?.data ?? {}) as Record<string, any>;
  const db = getServiceClient();

  if (state === "exp:add:amount") {
    const amount = Number(text);
    if (!isFinite(amount) || amount <= 0) {
      await sendMessage(chatId, "Invalid amount. Send a positive number.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "exp:add:note", data: { ...sData, amount } });
    await sendMessage(chatId, "Add a <b>note</b> describing this expense (or <code>skip</code>).");
    return true;
  }

  if (state === "exp:add:note") {
    const note = text.toLowerCase() === "skip" ? null : text.slice(0, 200);
    const { data: inserted, error } = await db
      .from("expenses")
      .insert({
        category: sData.category,
        amount: sData.amount,
        note,
        user_id: user.id,
        spent_on: new Date().toISOString().slice(0, 10),
      })
      .select("id,amount,category")
      .single();
    await saveSession(user.telegram_id, { state: null, data: {} });
    if (error || !inserted) {
      await sendMessage(chatId, `❌ Failed: ${escapeHtml(error?.message ?? "unknown")}`, { reply_markup: expensesMenu() });
      return true;
    }
    await logActivity({
      user_id: user.id,
      telegram_id: user.telegram_id,
      action: "expense_create",
      meta: { expense_id: inserted.id, amount: inserted.amount, category: inserted.category },
    });
    await notifyOwner(
      "system",
      "Expense logged",
      `${user.full_name} logged ₦${fmtMoney(inserted.amount)} — ${inserted.category}.`,
    );
    await sendMessage(
      chatId,
      `✅ Expense recorded: <b>${inserted.category}</b> ₦${fmtMoney(inserted.amount)}.`,
      { reply_markup: expensesMenu() },
    );
    return true;
  }

  return false;
}
