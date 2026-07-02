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

type ProductRow = Record<string, any>;

const BACK: ReplyMarkup = {
  inline_keyboard: [[{ text: "⬅️ Back to Menu", callback_data: "menu:main" }]],
};

export function inventoryMenu(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Add Product", callback_data: "inv:add" }, { text: "🔎 Search/Edit", callback_data: "inv:search" }],
      [{ text: "📥 Receive Stock", callback_data: "inv:receive_search" }, { text: "🔁 Replace Goods", callback_data: "inv:replace_search" }],
      [{ text: "📉 Low Stock", callback_data: "inv:lowstock" }, { text: "📋 List All", callback_data: "inv:list" }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ],
  };
}

function productMenu(id: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "📥 Receive", callback_data: `inv:receive:${id}` }, { text: "🔁 Replace", callback_data: `inv:replace:${id}` }],
      [{ text: "✏️ Name", callback_data: `inv:edit:name:${id}` }, { text: "📦 Pack Size", callback_data: `inv:edit:pack:${id}` }],
      [{ text: "💰 Prices", callback_data: `inv:edit:prices:${id}` }, { text: "📊 Stock", callback_data: `inv:edit:stock:${id}` }],
      [{ text: "🚨 Min Level", callback_data: `inv:edit:min:${id}` }],
      [{ text: "🗑 Delete", callback_data: `inv:delete:${id}` }],
      [{ text: "⬅️ Inventory", callback_data: "menu:inventory" }],
    ],
  };
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtMoney(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtQty(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toLocaleString("en-NG", { maximumFractionDigits: 2 });
}

function parseQty(text: string): number | null {
  const v = Number(text.trim());
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function parsePacksBottles(text: string): { packs: number; bottles: number } | null {
  const trimmed = text.trim().toLowerCase();
  const nums = trimmed.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length === 0) return null;
  let packs = 0;
  let bottles = 0;
  const packMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*(?:pack|packs|carton|cartons|case|cases)/);
  const bottleMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*(?:bottle|bottles|pcs|pieces|unit|units)/);
  if (packMatch || bottleMatch) {
    packs = packMatch ? Number(packMatch[1]) : 0;
    bottles = bottleMatch ? Number(bottleMatch[1]) : 0;
  } else {
    packs = nums[0] ?? 0;
    bottles = nums[1] ?? 0;
  }
  if (!Number.isFinite(packs) || !Number.isFinite(bottles) || packs < 0 || bottles < 0) return null;
  return { packs, bottles };
}

function stockLabel(p: ProductRow): string {
  const packSize = Number(p.pack_size ?? 1);
  const packs = Number(p.stock_packs ?? 0);
  const bottles = Number(p.stock_bottles ?? p.current_stock ?? 0);
  const total = Number(p.current_stock ?? packs * packSize + bottles);
  return `${fmtQty(packs)} pack(s) + ${fmtQty(bottles)} bottle(s) (${fmtQty(total)} bottles total, ${packSize}/pack)`;
}

function productDetails(p: ProductRow): string {
  return (
    `📦 <b>${escapeHtml(p.name)}</b>\n` +
    `SKU: <code>${escapeHtml(p.sku ?? "")}</code>\n` +
    `Stock: <b>${escapeHtml(stockLabel(p))}</b>\n` +
    `Pack price: ₦${fmtMoney(p.pack_selling_price)} • Bottle price: ₦${fmtMoney(p.bottle_selling_price ?? p.selling_price)}\n` +
    `Pack cost: ₦${fmtMoney(p.pack_cost_price)} • Bottle cost: ₦${fmtMoney(p.bottle_cost_price ?? p.cost_price)}\n` +
    `Min alert: ${fmtQty(p.min_stock)} bottle(s)`
  );
}

async function genSku(name: string): Promise<string> {
  const prefix = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() || "PROD";
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${suffix}`;
}

async function fetchProduct(id: string): Promise<ProductRow | null> {
  const db = getServiceClient();
  const { data } = await db.from("products").select("*").eq("id", id).maybeSingle();
  return data as ProductRow | null;
}

async function showProduct(chatId: number, id: string) {
  const p = await fetchProduct(id);
  if (!p || p.archived) {
    await sendMessage(chatId, "Product not found or already deleted.", { reply_markup: inventoryMenu() });
    return;
  }
  await sendMessage(chatId, productDetails(p), { reply_markup: productMenu(id) });
}

export async function openInventory(chatId: number, user: BotUser) {
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Inventory management is restricted to the owner.", { reply_markup: BACK });
    return;
  }
  await sendMessage(chatId, "📦 <b>Inventory</b>\n\nManage packs, bottles, edits, stock receiving, replacements, and deletion:", {
    reply_markup: inventoryMenu(),
  });
}

export async function handleInventoryCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!data.startsWith("inv:")) return false;

  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Owner only.", { reply_markup: BACK });
    return true;
  }

  const db = getServiceClient();

  if (data === "inv:add") {
    await saveSession(user.telegram_id, { user_id: user.id, authenticated: true, state: "inv:add:name", data: {} });
    await sendMessage(chatId, "➕ <b>New Product</b>\n\nSend the product <b>name</b> (e.g. <i>Coca-Cola 50cl</i>).", { reply_markup: BACK });
    return true;
  }

  if (data === "inv:search" || data === "inv:receive_search" || data === "inv:replace_search") {
    const mode = data === "inv:receive_search" ? "receive" : data === "inv:replace_search" ? "replace" : "view";
    await saveSession(user.telegram_id, { user_id: user.id, authenticated: true, state: `inv:search:${mode}`, data: { mode } });
    await sendMessage(chatId, "🔎 Send a product name, SKU, or barcode.", { reply_markup: BACK });
    return true;
  }

  if (data === "inv:lowstock") {
    const { data: rows } = await db
      .from("products")
      .select("id,name,sku,current_stock,min_stock,pack_size,stock_packs,stock_bottles")
      .eq("archived", false)
      .order("current_stock", { ascending: true })
      .limit(50);
    const low = (rows ?? []).filter((p: any) => Number(p.current_stock) <= Number(p.min_stock));
    if (low.length === 0) {
      await sendMessage(chatId, "✅ No products are below their minimum stock level.", { reply_markup: inventoryMenu() });
      return true;
    }
    const lines = low.map((p: any) => `• <b>${escapeHtml(p.name)}</b> [${escapeHtml(p.sku ?? "")}] — ${escapeHtml(stockLabel(p))} (min ${fmtQty(p.min_stock)})`).join("\n");
    await sendMessage(chatId, `📉 <b>Low Stock (${low.length})</b>\n\n${lines}`, { reply_markup: inventoryMenu() });
    return true;
  }

  if (data === "inv:list") {
    const { data: rows } = await db
      .from("products")
      .select("id,name,sku,current_stock,pack_size,stock_packs,stock_bottles,pack_selling_price,bottle_selling_price")
      .eq("archived", false)
      .order("name")
      .limit(25);
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, "No products yet. Use ➕ Add Product.", { reply_markup: inventoryMenu() });
      return true;
    }
    const lines = rows.map((p: any) => `• <b>${escapeHtml(p.name)}</b> — ${escapeHtml(stockLabel(p))}\n   Pack ₦${fmtMoney(p.pack_selling_price)} • Bottle ₦${fmtMoney(p.bottle_selling_price)}`).join("\n");
    const buttons = rows.map((p: any) => [{ text: `✏️ ${p.name}`.slice(0, 60), callback_data: `inv:view:${p.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:inventory" }]);
    await sendMessage(chatId, `📋 <b>Products</b>\n\n${lines}`, { reply_markup: { inline_keyboard: buttons } });
    return true;
  }

  if (data.startsWith("inv:view:")) {
    await showProduct(chatId, data.slice("inv:view:".length));
    return true;
  }

  if (data.startsWith("inv:receive:")) {
    const pid = data.slice("inv:receive:".length);
    const p = await fetchProduct(pid);
    if (!p || p.archived) {
      await sendMessage(chatId, "Product not found.", { reply_markup: inventoryMenu() });
      return true;
    }
    await saveSession(user.telegram_id, { user_id: user.id, authenticated: true, state: "inv:receive:qty", data: { pid } });
    await sendMessage(chatId, `${productDetails(p)}\n\n📥 Send quantity received as <code>packs bottles</code>.\nExample: <code>10 packs 6 bottles</code> or <code>10 6</code>.`, { reply_markup: BACK });
    return true;
  }

  if (data.startsWith("inv:replace:")) {
    const pid = data.slice("inv:replace:".length);
    const p = await fetchProduct(pid);
    if (!p || p.archived) {
      await sendMessage(chatId, "Product not found.", { reply_markup: inventoryMenu() });
      return true;
    }
    await saveSession(user.telegram_id, { user_id: user.id, authenticated: true, state: "inv:replace:qty", data: { pid } });
    await sendMessage(chatId, `${productDetails(p)}\n\n🔁 Send damaged/replaced quantity to remove as <code>packs bottles</code>.\nExample: <code>1 pack 3 bottles</code> or <code>1 3</code>.`, { reply_markup: BACK });
    return true;
  }

  if (data.startsWith("inv:edit:")) {
    const parts = data.split(":");
    const field = parts[2];
    const pid = parts[3];
    const p = await fetchProduct(pid);
    if (!p || p.archived) {
      await sendMessage(chatId, "Product not found.", { reply_markup: inventoryMenu() });
      return true;
    }
    const prompts: Record<string, string> = {
      name: "Send the new product name.",
      pack: "Send bottles per pack/carton (e.g. 12 or 24).",
      prices: "Send prices as: <code>pack selling, bottle selling, pack cost, bottle cost</code>\nExample: <code>6000, 300, 4800, 200</code>",
      stock: "Send new stock as <code>packs bottles</code>. Example: <code>20 packs 5 bottles</code> or <code>20 5</code>.",
      min: "Send minimum alert level in total bottles.",
    };
    await saveSession(user.telegram_id, { user_id: user.id, authenticated: true, state: `inv:edit:${field}`, data: { pid } });
    await sendMessage(chatId, `${productDetails(p)}\n\n✏️ ${prompts[field] ?? "Send the new value."}`, { reply_markup: BACK });
    return true;
  }

  if (data.startsWith("inv:delete:")) {
    const pid = data.slice("inv:delete:".length);
    const p = await fetchProduct(pid);
    if (!p || p.archived) {
      await sendMessage(chatId, "Product not found or already deleted.", { reply_markup: inventoryMenu() });
      return true;
    }
    await sendMessage(chatId, `⚠️ Delete <b>${escapeHtml(p.name)}</b> from active inventory? Sales history will remain.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Yes, delete", callback_data: `inv:delete_confirm:${pid}` }],
          [{ text: "Cancel", callback_data: `inv:view:${pid}` }],
        ],
      },
    });
    return true;
  }

  if (data.startsWith("inv:delete_confirm:")) {
    const pid = data.slice("inv:delete_confirm:".length);
    const p = await fetchProduct(pid);
    if (!p || p.archived) {
      await sendMessage(chatId, "Product not found or already deleted.", { reply_markup: inventoryMenu() });
      return true;
    }
    await db.from("products").update({ archived: true, stock_packs: 0, stock_bottles: 0 }).eq("id", pid);
    await db.from("stock_movements").insert({ product_id: pid, change: -Number(p.current_stock ?? 0), reason: "delete", reference: "archived", user_id: user.id });
    await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: "product_delete", meta: { product_id: pid } });
    await sendMessage(chatId, `🗑 Deleted <b>${escapeHtml(p.name)}</b> from active inventory.`, { reply_markup: inventoryMenu() });
    return true;
  }

  return false;
}

export async function handleInventoryMessage(text: string, chatId: number, user: BotUser): Promise<boolean> {
  const session = await loadSession(user.telegram_id);
  const state = session?.state ?? "";
  if (!state.startsWith("inv:")) return false;
  const db = getServiceClient();
  const sData = (session?.data ?? {}) as Record<string, any>;

  if (state === "inv:add:name") {
    if (text.trim().length < 2) {
      await sendMessage(chatId, "Name too short. Try again.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:pack_size", data: { ...sData, name: text.trim() } });
    await sendMessage(chatId, `Got it: <b>${escapeHtml(text.trim())}</b>\n\nSend bottles per pack/carton (e.g. <code>12</code> or <code>24</code>).`);
    return true;
  }
  if (state === "inv:add:pack_size") {
    const v = parseQty(text);
    if (!v || v < 1) {
      await sendMessage(chatId, "Invalid pack size. Send bottles per pack, e.g. 12 or 24.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:pack_price", data: { ...sData, pack_size: Math.floor(v) } });
    await sendMessage(chatId, "Send the <b>selling price per pack/carton</b>.");
    return true;
  }
  if (state === "inv:add:pack_price") {
    const v = parseQty(text);
    if (v === null) {
      await sendMessage(chatId, "Invalid number. Send pack selling price.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:bottle_price", data: { ...sData, pack_selling_price: v } });
    await sendMessage(chatId, "Send the <b>selling price per bottle</b>.");
    return true;
  }
  if (state === "inv:add:bottle_price") {
    const v = parseQty(text);
    if (v === null) {
      await sendMessage(chatId, "Invalid number. Send bottle selling price.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:pack_cost", data: { ...sData, bottle_selling_price: v } });
    await sendMessage(chatId, "Send the <b>cost price per pack/carton</b>.");
    return true;
  }
  if (state === "inv:add:pack_cost") {
    const v = parseQty(text);
    if (v === null) {
      await sendMessage(chatId, "Invalid number. Send pack cost price.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:bottle_cost", data: { ...sData, pack_cost_price: v } });
    await sendMessage(chatId, "Send the <b>cost price per bottle</b>.");
    return true;
  }
  if (state === "inv:add:bottle_cost") {
    const v = parseQty(text);
    if (v === null) {
      await sendMessage(chatId, "Invalid number. Send bottle cost price.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:stock", data: { ...sData, bottle_cost_price: v } });
    await sendMessage(chatId, "Send opening stock as <code>packs bottles</code>. Example: <code>20 packs 6 bottles</code> or <code>20 6</code>.");
    return true;
  }
  if (state === "inv:add:stock") {
    const parsed = parsePacksBottles(text);
    if (!parsed) {
      await sendMessage(chatId, "Invalid stock. Send as packs and bottles, e.g. <code>20 6</code>.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "inv:add:min", data: { ...sData, stock_packs: parsed.packs, stock_bottles: parsed.bottles } });
    await sendMessage(chatId, "Send the <b>minimum stock alert level</b> in total bottles (or <code>0</code> to skip). ");
    return true;
  }
  if (state === "inv:add:min") {
    const minStock = parseQty(text);
    if (minStock === null) {
      await sendMessage(chatId, "Invalid number. Send the minimum stock level in bottles.");
      return true;
    }
    const payload = sData;
    const sku = await genSku(payload.name);
    const { data: created, error } = await db
      .from("products")
      .insert({
        name: payload.name,
        sku,
        pack_size: payload.pack_size,
        pack_selling_price: payload.pack_selling_price,
        bottle_selling_price: payload.bottle_selling_price,
        pack_cost_price: payload.pack_cost_price,
        bottle_cost_price: payload.bottle_cost_price,
        selling_price: payload.bottle_selling_price,
        cost_price: payload.bottle_cost_price,
        stock_packs: payload.stock_packs,
        stock_bottles: payload.stock_bottles,
        min_stock: minStock,
        unit: "bottle",
      })
      .select("*")
      .single();
    await saveSession(user.telegram_id, { state: null, data: {} });
    if (error || !created) {
      await sendMessage(chatId, `❌ Failed to save product: ${escapeHtml(error?.message ?? "unknown error")}`, { reply_markup: inventoryMenu() });
      return true;
    }
    if (Number(created.current_stock) > 0) {
      await db.from("stock_movements").insert({ product_id: created.id, change: Number(created.current_stock), reason: "opening", user_id: user.id });
    }
    await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: "product_create", meta: { product_id: created.id } });
    await sendMessage(chatId, `✅ <b>Product added</b>\n\n${productDetails(created)}`, { reply_markup: productMenu(created.id) });
    return true;
  }

  if (state.startsWith("inv:search:")) {
    const mode = String(sData.mode ?? "view");
    const q = text.trim();
    const { data: rows } = await db
      .from("products")
      .select("id,name,sku,barcode,current_stock,pack_size,stock_packs,stock_bottles,pack_selling_price,bottle_selling_price")
      .eq("archived", false)
      .or(`name.ilike.%${q}%,sku.ilike.%${q}%,barcode.eq.${q}`)
      .limit(10);
    await saveSession(user.telegram_id, { state: null, data: {} });
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, `No products match “${escapeHtml(q)}”.`, { reply_markup: inventoryMenu() });
      return true;
    }
    const lines = rows.map((p: any) => `• <b>${escapeHtml(p.name)}</b> [${escapeHtml(p.sku ?? "")}]\n   ${escapeHtml(stockLabel(p))} • Pack ₦${fmtMoney(p.pack_selling_price)} • Bottle ₦${fmtMoney(p.bottle_selling_price)}`);
    const prefix = mode === "receive" ? "inv:receive" : mode === "replace" ? "inv:replace" : "inv:view";
    const label = mode === "receive" ? "📥 Receive" : mode === "replace" ? "🔁 Replace" : "✏️ Edit";
    const buttons = rows.map((p: any) => [{ text: `${label}: ${p.name}`.slice(0, 60), callback_data: `${prefix}:${p.id}` }]);
    buttons.push([{ text: "⬅️ Back", callback_data: "menu:inventory" }]);
    await sendMessage(chatId, `🔎 <b>Results</b>\n\n${lines.join("\n")}`, { reply_markup: { inline_keyboard: buttons } });
    return true;
  }

  if (state === "inv:receive:qty" || state === "inv:replace:qty") {
    const parsed = parsePacksBottles(text);
    if (!parsed || (parsed.packs === 0 && parsed.bottles === 0)) {
      await sendMessage(chatId, "Invalid quantity. Send packs and bottles, e.g. <code>10 6</code>.");
      return true;
    }
    const pid = String(sData.pid);
    const prod = await fetchProduct(pid);
    if (!prod || prod.archived) {
      await sendMessage(chatId, "Product not found.", { reply_markup: inventoryMenu() });
      await saveSession(user.telegram_id, { state: null, data: {} });
      return true;
    }
    const sign = state === "inv:receive:qty" ? 1 : -1;
    const newPacks = Number(prod.stock_packs ?? 0) + sign * parsed.packs;
    const newBottles = Number(prod.stock_bottles ?? 0) + sign * parsed.bottles;
    if (newPacks < 0 || newBottles < 0) {
      await sendMessage(chatId, `Not enough stock. Current: ${escapeHtml(stockLabel(prod))}`);
      return true;
    }
    const totalChange = sign * (parsed.packs * Number(prod.pack_size ?? 1) + parsed.bottles);
    const reason = state === "inv:receive:qty" ? "receive" : "replace";
    const { data: updated, error } = await db
      .from("products")
      .update({ stock_packs: newPacks, stock_bottles: newBottles })
      .eq("id", pid)
      .select("*")
      .single();
    if (error || !updated) {
      await sendMessage(chatId, `❌ Stock update failed: ${escapeHtml(error?.message ?? "unknown")}`, { reply_markup: inventoryMenu() });
      await saveSession(user.telegram_id, { state: null, data: {} });
      return true;
    }
    await db.from("stock_movements").insert({ product_id: pid, change: totalChange, reason, user_id: user.id });
    await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: reason === "receive" ? "stock_receive" : "stock_replace", meta: { product_id: pid, ...parsed } });
    await saveSession(user.telegram_id, { state: null, data: {} });
    await sendMessage(chatId, `✅ ${reason === "receive" ? "Received" : "Replaced/removed"} ${fmtQty(parsed.packs)} pack(s) + ${fmtQty(parsed.bottles)} bottle(s).\n\n${productDetails(updated)}`, { reply_markup: productMenu(pid) });
    return true;
  }

  if (state.startsWith("inv:edit:")) {
    const field = state.slice("inv:edit:".length);
    const pid = String(sData.pid);
    const prod = await fetchProduct(pid);
    if (!prod || prod.archived) {
      await sendMessage(chatId, "Product not found.", { reply_markup: inventoryMenu() });
      await saveSession(user.telegram_id, { state: null, data: {} });
      return true;
    }
    const patch: Record<string, unknown> = {};
    if (field === "name") {
      if (text.trim().length < 2) {
        await sendMessage(chatId, "Name too short. Send a valid product name.");
        return true;
      }
      patch.name = text.trim();
    } else if (field === "pack") {
      const v = parseQty(text);
      if (!v || v < 1) {
        await sendMessage(chatId, "Invalid pack size. Send bottles per pack, e.g. 12 or 24.");
        return true;
      }
      patch.pack_size = Math.floor(v);
    } else if (field === "prices") {
      const nums = text.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (nums.length < 4) {
        await sendMessage(chatId, "Send four numbers: pack selling, bottle selling, pack cost, bottle cost.");
        return true;
      }
      patch.pack_selling_price = nums[0];
      patch.bottle_selling_price = nums[1];
      patch.pack_cost_price = nums[2];
      patch.bottle_cost_price = nums[3];
      patch.selling_price = nums[1];
      patch.cost_price = nums[3];
    } else if (field === "stock") {
      const parsed = parsePacksBottles(text);
      if (!parsed) {
        await sendMessage(chatId, "Invalid stock. Send as packs and bottles, e.g. <code>20 5</code>.");
        return true;
      }
      patch.stock_packs = parsed.packs;
      patch.stock_bottles = parsed.bottles;
      const newTotal = parsed.packs * Number(prod.pack_size ?? 1) + parsed.bottles;
      await db.from("stock_movements").insert({ product_id: pid, change: newTotal - Number(prod.current_stock ?? 0), reason: "adjustment", user_id: user.id });
    } else if (field === "min") {
      const v = parseQty(text);
      if (v === null) {
        await sendMessage(chatId, "Invalid number. Send minimum alert level in bottles.");
        return true;
      }
      patch.min_stock = v;
    } else {
      await saveSession(user.telegram_id, { state: null, data: {} });
      await sendMessage(chatId, "Unknown edit action.", { reply_markup: inventoryMenu() });
      return true;
    }

    const { data: updated, error } = await db.from("products").update(patch).eq("id", pid).select("*").single();
    await saveSession(user.telegram_id, { state: null, data: {} });
    if (error || !updated) {
      await sendMessage(chatId, `❌ Update failed: ${escapeHtml(error?.message ?? "unknown")}`, { reply_markup: inventoryMenu() });
      return true;
    }
    await logActivity({ user_id: user.id, telegram_id: user.telegram_id, action: "product_edit", meta: { product_id: pid, field } });
    await sendMessage(chatId, `✅ Product updated.\n\n${productDetails(updated)}`, { reply_markup: productMenu(pid) });
    return true;
  }

  return false;
}