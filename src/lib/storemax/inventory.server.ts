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

export function inventoryMenu(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Add Product", callback_data: "inv:add" }, { text: "🔎 Search", callback_data: "inv:search" }],
      [{ text: "📉 Low Stock", callback_data: "inv:lowstock" }, { text: "📋 List All", callback_data: "inv:list" }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtMoney(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function genSku(name: string): Promise<string> {
  const prefix = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() || "PROD";
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${suffix}`;
}

export async function openInventory(chatId: number, user: BotUser) {
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Inventory management is restricted to the owner.", { reply_markup: BACK });
    return;
  }
  await sendMessage(chatId, "📦 <b>Inventory</b>\n\nChoose an action:", { reply_markup: inventoryMenu() });
}

export async function handleInventoryCallback(
  data: string,
  chatId: number,
  user: BotUser,
): Promise<boolean> {
  if (!data.startsWith("inv:")) return false;

  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Owner only.", { reply_markup: BACK });
    return true;
  }

  if (data === "inv:add") {
    await saveSession(user.telegram_id, {
      user_id: user.id,
      authenticated: true,
      state: "inv:add:name",
      data: {},
    });
    await sendMessage(chatId, "➕ <b>New Product</b>\n\nSend the product <b>name</b> (e.g. <i>Coca-Cola 50cl</i>).");
    return true;
  }

  if (data === "inv:search") {
    await saveSession(user.telegram_id, {
      user_id: user.id,
      authenticated: true,
      state: "inv:search:q",
      data: {},
    });
    await sendMessage(chatId, "🔎 <b>Search Products</b>\n\nSend a product name, SKU, or barcode.");
    return true;
  }

  if (data === "inv:lowstock") {
    const db = getServiceClient();
    const { data: rows } = await db
      .from("products")
      .select("name,sku,current_stock,min_stock,unit")
      .eq("archived", false)
      .order("current_stock", { ascending: true })
      .limit(50);
    const low = (rows ?? []).filter((p: any) => Number(p.current_stock) <= Number(p.min_stock));
    if (low.length === 0) {
      await sendMessage(chatId, "✅ No products are below their minimum stock level.", { reply_markup: inventoryMenu() });
      return true;
    }
    const lines = low
      .map((p: any) => `• <b>${escapeHtml(p.name)}</b> [${escapeHtml(p.sku ?? "")}] — ${p.current_stock}${p.unit ? " " + p.unit : ""} (min ${p.min_stock})`)
      .join("\n");
    await sendMessage(chatId, `📉 <b>Low Stock (${low.length})</b>\n\n${lines}`, { reply_markup: inventoryMenu() });
    return true;
  }

  if (data === "inv:list") {
    const db = getServiceClient();
    const { data: rows } = await db
      .from("products")
      .select("name,sku,current_stock,selling_price,unit")
      .eq("archived", false)
      .order("name")
      .limit(25);
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, "No products yet. Use ➕ Add Product.", { reply_markup: inventoryMenu() });
      return true;
    }
    const lines = rows
      .map(
        (p: any) =>
          `• <b>${escapeHtml(p.name)}</b> — ₦${fmtMoney(p.selling_price)} • Stock: ${p.current_stock}${p.unit ? " " + p.unit : ""}`,
      )
      .join("\n");
    await sendMessage(chatId, `📋 <b>Products</b>\n\n${lines}`, { reply_markup: inventoryMenu() });
    return true;
  }

  if (data.startsWith("inv:receive:")) {
    const pid = data.slice("inv:receive:".length);
    await saveSession(user.telegram_id, {
      user_id: user.id,
      authenticated: true,
      state: "inv:receive:qty",
      data: { pid },
    });
    await sendMessage(chatId, "📥 Send the <b>quantity received</b> (positive number).");
    return true;
  }

  return false;
}

export async function handleInventoryMessage(
  text: string,
  chatId: number,
  user: BotUser,
): Promise<boolean> {
  const session = await loadSession(user.telegram_id);
  const state = session?.state ?? "";
  if (!state.startsWith("inv:")) return false;
  const db = getServiceClient();
  const sData = (session?.data ?? {}) as Record<string, any>;

  if (state === "inv:add:name") {
    if (text.length < 2) {
      await sendMessage(chatId, "Name too short. Try again.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:price", data: { ...sData, name: text } });
    await sendMessage(chatId, `Got it: <b>${escapeHtml(text)}</b>\n\nSend the <b>selling price</b> (e.g. <code>500</code>).`);
    return true;
  }
  if (state === "inv:add:price") {
    const v = Number(text);
    if (!isFinite(v) || v < 0) {
      await sendMessage(chatId, "Invalid number. Send the selling price.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:cost", data: { ...sData, selling_price: v } });
    await sendMessage(chatId, "Send the <b>cost price</b> (what you pay your supplier).");
    return true;
  }
  if (state === "inv:add:cost") {
    const v = Number(text);
    if (!isFinite(v) || v < 0) {
      await sendMessage(chatId, "Invalid number. Send the cost price.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:stock", data: { ...sData, cost_price: v } });
    await sendMessage(chatId, "Send the <b>opening stock quantity</b> (e.g. <code>120</code>).");
    return true;
  }
  if (state === "inv:add:stock") {
    const v = Number(text);
    if (!isFinite(v) || v < 0) {
      await sendMessage(chatId, "Invalid number. Send the opening stock quantity.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:min", data: { ...sData, current_stock: v } });
    await sendMessage(chatId, "Send the <b>minimum stock alert level</b> (or <code>0</code> to skip).");
    return true;
  }
  if (state === "inv:add:min") {
    const minStock = Number(text);
    if (!isFinite(minStock) || minStock < 0) {
      await sendMessage(chatId, "Invalid number. Send the minimum stock level.");
      return true;
    }
    const payload = sData;
    const sku = await genSku(payload.name);
    const { data: created, error } = await db
      .from("products")
      .insert({
        name: payload.name,
        sku,
        selling_price: payload.selling_price,
        cost_price: payload.cost_price,
        current_stock: payload.current_stock,
        min_stock: minStock,
        unit: "pcs",
      })
      .select("id,name,sku,current_stock,selling_price")
      .single();
    if (error || !created) {
      await sendMessage(chatId, `❌ Failed to save product: ${escapeHtml(error?.message ?? "unknown error")}`, {
        reply_markup: inventoryMenu(),
      });
      await saveSession(user.telegram_id, { state: null, data: {} });
      return true;
    }
    if (Number(payload.current_stock) > 0) {
      await db.from("stock_movements").insert({
        product_id: created.id,
        change: Number(payload.current_stock),
        reason: "opening",
        user_id: user.id,
      });
    }
    await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: "product_create", meta: { product_id: created.id } });
    await saveSession(user.telegram_id, { state: null, data: {} });
    await sendMessage(
      chatId,
      `✅ <b>Product added</b>\n\n${escapeHtml(created.name)}\nSKU: <code>${escapeHtml(created.sku)}</code>\nPrice: ₦${fmtMoney(created.selling_price)}\nStock: ${created.current_stock}`,
      { reply_markup: inventoryMenu() },
    );
    return true;
  }

  if (state === "inv:search:q") {
    const q = text.trim();
    const { data: rows } = await db
      .from("products")
      .select("id,name,sku,barcode,current_stock,selling_price,unit,min_stock")
      .eq("archived", false)
      .or(`name.ilike.%${q}%,sku.ilike.%${q}%,barcode.eq.${q}`)
      .limit(10);
    await saveSession(user.telegram_id, { state: null, data: {} });
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, `No products match “${escapeHtml(q)}”.`, { reply_markup: inventoryMenu() });
      return true;
    }
    const lines = rows.map(
      (p: any) =>
        `• <b>${escapeHtml(p.name)}</b> [${escapeHtml(p.sku ?? "")}]\n   ₦${fmtMoney(p.selling_price)} • Stock: ${p.current_stock}${p.unit ? " " + p.unit : ""}`,
    );
    const buttons = rows.map((p: any) => [{ text: `📥 Receive: ${p.name}`.slice(0, 60), callback_data: `inv:receive:${p.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:inventory" }]);
    await sendMessage(chatId, `🔎 <b>Results</b>\n\n${lines.join("\n")}`, {
      reply_markup: { inline_keyboard: buttons },
    });
    return true;
  }

  if (state === "inv:receive:qty") {
    const qty = Number(text);
    if (!isFinite(qty) || qty <= 0) {
      await sendMessage(chatId, "Invalid quantity. Send a positive number.");
      return true;
    }
    const pid = String(sData.pid);
    const { data: prod } = await db.from("products").select("id,name,current_stock").eq("id", pid).maybeSingle();
    if (!prod) {
      await sendMessage(chatId, "Product not found.", { reply_markup: inventoryMenu() });
      await saveSession(user.telegram_id, { state: null, data: {} });
      return true;
    }
    const newStock = Number(prod.current_stock) + qty;
    await db.from("products").update({ current_stock: newStock }).eq("id", pid);
    await db.from("stock_movements").insert({
      product_id: pid,
      change: qty,
      reason: "receive",
      user_id: user.id,
    });
    await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: "stock_receive", meta: { product_id: pid, qty } });
    await saveSession(user.telegram_id, { state: null, data: {} });
    await sendMessage(
      chatId,
      `✅ Received <b>${qty}</b> × <b>${escapeHtml(prod.name)}</b>.\nNew stock: <b>${newStock}</b>`,
      { reply_markup: inventoryMenu() },
    );
    if (user.role !== "owner") {
      await notifyOwner("system", "Stock received", `${user.full_name} received ${qty} × ${prod.name}.`);
    }
    return true;
  }

  return false;
}
