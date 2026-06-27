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
function fmtMoney(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function suppliersMenu(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Add Supplier", callback_data: "sup:add" }, { text: "🔎 Search", callback_data: "sup:search" }],
      [{ text: "📋 List All", callback_data: "sup:list" }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ],
  };
}

export async function openSuppliers(chatId: number, user: BotUser) {
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Suppliers are restricted to the owner.", { reply_markup: BACK });
    return;
  }
  await sendMessage(chatId, "🚚 <b>Suppliers</b>\n\nChoose an action:", { reply_markup: suppliersMenu() });
}

async function showSupplier(chatId: number, supplierId: string) {
  const db = getServiceClient();
  const { data: s } = await db
    .from("suppliers")
    .select("id,name,phone,email,address,notes,created_at")
    .eq("id", supplierId)
    .maybeSingle();
  if (!s) {
    await sendMessage(chatId, "Supplier not found.", { reply_markup: suppliersMenu() });
    return;
  }
  const { data: products } = await db
    .from("products")
    .select("name,sku,current_stock,cost_price")
    .eq("supplier_id", supplierId)
    .eq("archived", false)
    .order("name")
    .limit(15);
  const prodList = (products ?? []).length === 0
    ? "<i>(no products linked)</i>"
    : (products ?? [])
        .map((p: any) => `• <b>${escapeHtml(p.name)}</b> — Stock: ${p.current_stock} • Cost: ₦${fmtMoney(p.cost_price)}`)
        .join("\n");

  await sendMessage(
    chatId,
    `🚚 <b>${escapeHtml(s.name)}</b>\n` +
      `Phone: ${escapeHtml(s.phone ?? "—")}\n` +
      `Email: ${escapeHtml(s.email ?? "—")}\n` +
      `Address: ${escapeHtml(s.address ?? "—")}\n` +
      `Notes: ${escapeHtml(s.notes ?? "—")}\n\n` +
      `<b>Products supplied</b>\n${prodList}`,
    { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu:suppliers" }]] } },
  );
}

export async function handleSupplierCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!data.startsWith("sup:")) return false;

  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Owner only.", { reply_markup: BACK });
    return true;
  }
  const db = getServiceClient();

  if (data === "sup:add") {
    await saveSession(user.telegram_id, {
      user_id: user.id,
      authenticated: true,
      state: "sup:add:name",
      data: {},
    });
    await sendMessage(chatId, "➕ <b>New Supplier</b>\n\nSend the supplier's <b>name</b> (company or contact).");
    return true;
  }

  if (data === "sup:search") {
    await saveSession(user.telegram_id, {
      user_id: user.id,
      authenticated: true,
      state: "sup:search:q",
      data: {},
    });
    await sendMessage(chatId, "🔎 Send a supplier <b>name</b> or <b>phone</b>.");
    return true;
  }

  if (data === "sup:list") {
    const { data: rows } = await db
      .from("suppliers")
      .select("id,name,phone")
      .order("name")
      .limit(25);
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, "No suppliers yet. Use ➕ Add Supplier.", { reply_markup: suppliersMenu() });
      return true;
    }
    const lines = rows.map(
      (s: any) => `• <b>${escapeHtml(s.name)}</b>${s.phone ? ` (${escapeHtml(s.phone)})` : ""}`,
    );
    const buttons = rows.slice(0, 10).map((s: any) => [{ text: s.name.slice(0, 60), callback_data: `sup:view:${s.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:suppliers" }]);
    await sendMessage(chatId, `📋 <b>Suppliers (${rows.length})</b>\n\n${lines.join("\n")}`, {
      reply_markup: { inline_keyboard: buttons },
    });
    return true;
  }

  if (data.startsWith("sup:view:")) {
    await showSupplier(chatId, data.slice("sup:view:".length));
    return true;
  }

  return false;
}

export async function handleSupplierMessage(text: string, chatId: number, user: BotUser): Promise<boolean> {
  const session = await loadSession(user.telegram_id);
  const state = session?.state ?? "";
  if (!state.startsWith("sup:")) return false;
  if (user.role !== "owner") return false;
  const db = getServiceClient();
  const sData = (session?.data ?? {}) as Record<string, any>;

  if (state === "sup:add:name") {
    if (text.length < 2) {
      await sendMessage(chatId, "Name too short. Try again.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "sup:add:phone", data: { ...sData, name: text.slice(0, 100) } });
    await sendMessage(chatId, `Got it: <b>${escapeHtml(text)}</b>\n\nSend the <b>phone number</b> (or <code>skip</code>).`);
    return true;
  }
  if (state === "sup:add:phone") {
    const phone = text.toLowerCase() === "skip" ? null : text.replace(/\s|-/g, "").slice(0, 20);
    if (phone && !/^\+?\d{7,15}$/.test(phone)) {
      await sendMessage(chatId, "Invalid phone. Send digits only, or <code>skip</code>.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "sup:add:address", data: { ...sData, phone } });
    await sendMessage(chatId, "Send the <b>address</b> (or <code>skip</code>).");
    return true;
  }
  if (state === "sup:add:address") {
    const address = text.toLowerCase() === "skip" ? null : text.slice(0, 200);
    await saveSession(user.telegram_id, { state: "sup:add:notes", data: { ...sData, address } });
    await sendMessage(chatId, "Any <b>notes</b>? (or <code>skip</code>)");
    return true;
  }
  if (state === "sup:add:notes") {
    const notes = text.toLowerCase() === "skip" ? null : text.slice(0, 500);
    const { data: created, error } = await db
      .from("suppliers")
      .insert({ name: sData.name, phone: sData.phone ?? null, address: sData.address ?? null, notes })
      .select("id,name,phone")
      .single();
    await saveSession(user.telegram_id, { state: null, data: {} });
    if (error || !created) {
      await sendMessage(chatId, `❌ Failed to save: ${escapeHtml(error?.message ?? "unknown")}`, { reply_markup: suppliersMenu() });
      return true;
    }
    await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: "supplier_create", meta: { supplier_id: created.id } });
    await sendMessage(
      chatId,
      `✅ <b>Supplier added</b>\n\n${escapeHtml(created.name)}${created.phone ? ` (${escapeHtml(created.phone)})` : ""}`,
      { reply_markup: suppliersMenu() },
    );
    return true;
  }

  if (state === "sup:search:q") {
    const q = text.trim();
    const { data: rows } = await db
      .from("suppliers")
      .select("id,name,phone")
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
      .limit(10);
    await saveSession(user.telegram_id, { state: null, data: {} });
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, `No suppliers match “${escapeHtml(q)}”.`, { reply_markup: suppliersMenu() });
      return true;
    }
    const lines = rows.map((s: any) => `• <b>${escapeHtml(s.name)}</b>${s.phone ? ` (${escapeHtml(s.phone)})` : ""}`);
    const buttons = rows.map((s: any) => [{ text: s.name.slice(0, 60), callback_data: `sup:view:${s.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:suppliers" }]);
    await sendMessage(chatId, `🔎 <b>Results</b>\n\n${lines.join("\n")}`, {
      reply_markup: { inline_keyboard: buttons },
    });
    return true;
  }

  return false;
}
