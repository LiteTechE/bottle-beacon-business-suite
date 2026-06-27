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

export function customersMenu(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Add Customer", callback_data: "cust:add" }, { text: "🔎 Search", callback_data: "cust:search" }],
      [{ text: "📋 List All", callback_data: "cust:list" }, { text: "💳 Debtors", callback_data: "cust:debtors" }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ],
  };
}

export async function openCustomers(chatId: number, _user: BotUser) {
  await sendMessage(chatId, "👥 <b>Customers</b>\n\nChoose an action:", { reply_markup: customersMenu() });
}

async function showCustomer(chatId: number, customerId: string, user: BotUser) {
  const db = getServiceClient();
  const { data: c } = await db
    .from("customers")
    .select("id,name,phone,email,address,outstanding_balance,loyalty_points,created_at")
    .eq("id", customerId)
    .maybeSingle();
  if (!c) {
    await sendMessage(chatId, "Customer not found.", { reply_markup: customersMenu() });
    return;
  }
  const { data: sales } = await db
    .from("sales")
    .select("invoice_no,total,created_at,status")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(5);
  const history = (sales ?? []).length === 0
    ? "<i>(no purchases yet)</i>"
    : (sales ?? [])
        .map((s: any) => `• <code>${escapeHtml(s.invoice_no)}</code> — ₦${fmtMoney(s.total)} (${new Date(s.created_at).toLocaleDateString()})`)
        .join("\n");

  const bal = Number(c.outstanding_balance ?? 0);
  const buttons: { text: string; callback_data: string }[][] = [];
  if (bal > 0 && user.role === "owner") {
    buttons.push([{ text: `💰 Record Payment (₦${fmtMoney(bal)})`, callback_data: `cust:pay:${c.id}` }]);
  }
  buttons.push([{ text: "⬅️ Back", callback_data: "menu:customers" }]);

  await sendMessage(
    chatId,
    `👤 <b>${escapeHtml(c.name)}</b>\n` +
      `Phone: ${escapeHtml(c.phone ?? "—")}\n` +
      `Email: ${escapeHtml(c.email ?? "—")}\n` +
      `Address: ${escapeHtml(c.address ?? "—")}\n` +
      `Outstanding: <b>₦${fmtMoney(bal)}</b>\n` +
      `Loyalty Points: ${c.loyalty_points ?? 0}\n\n` +
      `<b>Recent purchases</b>\n${history}`,
    { reply_markup: { inline_keyboard: buttons } },
  );
}

export async function handleCustomerCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!data.startsWith("cust:")) return false;
  const db = getServiceClient();

  if (data === "cust:add") {
    await saveSession(user.telegram_id, {
      user_id: user.id,
      authenticated: true,
      state: "cust:add:name",
      data: {},
    });
    await sendMessage(chatId, "➕ <b>New Customer</b>\n\nSend the customer's <b>full name</b>.");
    return true;
  }

  if (data === "cust:search") {
    await saveSession(user.telegram_id, {
      user_id: user.id,
      authenticated: true,
      state: "cust:search:q",
      data: {},
    });
    await sendMessage(chatId, "🔎 Send a customer <b>name</b> or <b>phone</b>.");
    return true;
  }

  if (data === "cust:list") {
    const { data: rows } = await db
      .from("customers")
      .select("id,name,phone,outstanding_balance")
      .order("name")
      .limit(25);
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, "No customers yet. Use ➕ Add Customer.", { reply_markup: customersMenu() });
      return true;
    }
    const lines = rows.map(
      (c: any) =>
        `• <b>${escapeHtml(c.name)}</b> ${c.phone ? `(${escapeHtml(c.phone)})` : ""} — Bal: ₦${fmtMoney(c.outstanding_balance)}`,
    );
    const buttons = rows.slice(0, 10).map((c: any) => [{ text: c.name.slice(0, 60), callback_data: `cust:view:${c.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:customers" }]);
    await sendMessage(chatId, `📋 <b>Customers (${rows.length})</b>\n\n${lines.join("\n")}`, {
      reply_markup: { inline_keyboard: buttons },
    });
    return true;
  }

  if (data === "cust:debtors") {
    const { data: rows } = await db
      .from("customers")
      .select("id,name,phone,outstanding_balance")
      .gt("outstanding_balance", 0)
      .order("outstanding_balance", { ascending: false })
      .limit(25);
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, "✅ No outstanding debts.", { reply_markup: customersMenu() });
      return true;
    }
    const total = rows.reduce((s: number, c: any) => s + Number(c.outstanding_balance), 0);
    const lines = rows.map(
      (c: any) => `• <b>${escapeHtml(c.name)}</b> ${c.phone ? `(${escapeHtml(c.phone)})` : ""} — ₦${fmtMoney(c.outstanding_balance)}`,
    );
    const buttons = rows.slice(0, 10).map((c: any) => [{ text: `${c.name} — ₦${fmtMoney(c.outstanding_balance)}`.slice(0, 60), callback_data: `cust:view:${c.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:customers" }]);
    await sendMessage(
      chatId,
      `💳 <b>Debtors (${rows.length})</b>\n\n${lines.join("\n")}\n\n<b>Total owed:</b> ₦${fmtMoney(total)}`,
      { reply_markup: { inline_keyboard: buttons } },
    );
    return true;
  }

  if (data.startsWith("cust:view:")) {
    const id = data.slice("cust:view:".length);
    await showCustomer(chatId, id, user);
    return true;
  }

  if (data.startsWith("cust:pay:")) {
    if (user.role !== "owner") {
      await sendMessage(chatId, "⛔ Only the owner can record customer payments.", { reply_markup: BACK });
      return true;
    }
    const id = data.slice("cust:pay:".length);
    await saveSession(user.telegram_id, {
      user_id: user.id,
      authenticated: true,
      state: "cust:pay:amount",
      data: { customer_id: id },
    });
    await sendMessage(chatId, "💰 Send the <b>amount received</b> from this customer.");
    return true;
  }

  return false;
}

export async function handleCustomerMessage(text: string, chatId: number, user: BotUser): Promise<boolean> {
  const session = await loadSession(user.telegram_id);
  const state = session?.state ?? "";
  if (!state.startsWith("cust:")) return false;
  const db = getServiceClient();
  const sData = (session?.data ?? {}) as Record<string, any>;

  if (state === "cust:add:name") {
    if (text.length < 2) {
      await sendMessage(chatId, "Name too short. Try again.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "cust:add:phone", data: { ...sData, name: text.slice(0, 100) } });
    await sendMessage(chatId, `Got it: <b>${escapeHtml(text)}</b>\n\nSend the <b>phone number</b> (or <code>skip</code>).`);
    return true;
  }
  if (state === "cust:add:phone") {
    const phone = text.toLowerCase() === "skip" ? null : text.replace(/\s|-/g, "").slice(0, 20);
    if (phone && !/^\+?\d{7,15}$/.test(phone)) {
      await sendMessage(chatId, "Invalid phone. Send digits only, or <code>skip</code>.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "cust:add:address", data: { ...sData, phone } });
    await sendMessage(chatId, "Send the <b>address</b> (or <code>skip</code>).");
    return true;
  }
  if (state === "cust:add:address") {
    const address = text.toLowerCase() === "skip" ? null : text.slice(0, 200);
    const { data: created, error } = await db
      .from("customers")
      .insert({ name: sData.name, phone: sData.phone ?? null, address })
      .select("id,name,phone")
      .single();
    await saveSession(user.telegram_id, { state: null, data: {} });
    if (error || !created) {
      await sendMessage(chatId, `❌ Failed to save: ${escapeHtml(error?.message ?? "unknown")}`, { reply_markup: customersMenu() });
      return true;
    }
    await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: "customer_create", meta: { customer_id: created.id } });
    await sendMessage(
      chatId,
      `✅ <b>Customer added</b>\n\n${escapeHtml(created.name)}${created.phone ? ` (${escapeHtml(created.phone)})` : ""}`,
      { reply_markup: customersMenu() },
    );
    return true;
  }

  if (state === "cust:search:q") {
    const q = text.trim();
    const { data: rows } = await db
      .from("customers")
      .select("id,name,phone,outstanding_balance")
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
      .limit(10);
    await saveSession(user.telegram_id, { state: null, data: {} });
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, `No customers match “${escapeHtml(q)}”.`, { reply_markup: customersMenu() });
      return true;
    }
    const lines = rows.map(
      (c: any) => `• <b>${escapeHtml(c.name)}</b> ${c.phone ? `(${escapeHtml(c.phone)})` : ""} — Bal: ₦${fmtMoney(c.outstanding_balance)}`,
    );
    const buttons = rows.map((c: any) => [{ text: c.name.slice(0, 60), callback_data: `cust:view:${c.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:customers" }]);
    await sendMessage(chatId, `🔎 <b>Results</b>\n\n${lines.join("\n")}`, {
      reply_markup: { inline_keyboard: buttons },
    });
    return true;
  }

  if (state === "cust:pay:amount") {
    const amount = Number(text);
    if (!isFinite(amount) || amount <= 0) {
      await sendMessage(chatId, "Invalid amount. Send a positive number.");
      return true;
    }
    const id = String(sData.customer_id);
    const { data: c } = await db.from("customers").select("id,name,outstanding_balance").eq("id", id).maybeSingle();
    if (!c) {
      await sendMessage(chatId, "Customer not found.", { reply_markup: customersMenu() });
      await saveSession(user.telegram_id, { state: null, data: {} });
      return true;
    }
    const bal = Number(c.outstanding_balance ?? 0);
    const applied = Math.min(amount, bal);
    const newBal = +(bal - applied).toFixed(2);
    await db.from("customers").update({ outstanding_balance: newBal }).eq("id", id);
    await logActivity({
      user_id: user.id,
      telegram_id: user.telegram_id,
      action: "customer_payment",
      meta: { customer_id: id, amount: applied, new_balance: newBal },
    });
    await saveSession(user.telegram_id, { state: null, data: {} });
    await sendMessage(
      chatId,
      `✅ Recorded ₦${fmtMoney(applied)} from <b>${escapeHtml(c.name)}</b>.\nNew balance: <b>₦${fmtMoney(newBal)}</b>${amount > applied ? `\n<i>(overpayment of ₦${fmtMoney(amount - applied)} ignored)</i>` : ""}`,
      { reply_markup: customersMenu() },
    );
    await notifyOwner(
      "system",
      "Customer payment received",
      `${user.full_name} recorded ₦${fmtMoney(applied)} from ${c.name}. New balance ₦${fmtMoney(newBal)}.`,
    );
    return true;
  }

  return false;
}
