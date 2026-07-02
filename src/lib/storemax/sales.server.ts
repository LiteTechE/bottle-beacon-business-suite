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

interface CartItem {
  product_id: string;
  name: string;
  sku: string | null;
  sale_unit: "pack" | "bottle";
  qty: number;
  unit_price: number;
  cost_price: number;
  line_total: number;
  pack_size: number;
}

const BACK: ReplyMarkup = { inline_keyboard: [[{ text: "⬅️ Back to Menu", callback_data: "menu:main" }]] };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtMoney(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cartSummary(cart: CartItem[]): string {
  if (cart.length === 0) return "<i>(cart empty)</i>";
  const lines = cart.map((c, i) => `${i + 1}. ${escapeHtml(c.name)} × ${c.qty} ${c.sale_unit}(s) = ₦${fmtMoney(c.line_total)}`);
  const total = cart.reduce((s, c) => s + c.line_total, 0);
  return `${lines.join("\n")}\n\n<b>Subtotal:</b> ₦${fmtMoney(total)}`;
}

function fmtQty(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toLocaleString("en-NG", { maximumFractionDigits: 2 });
}

function stockLabel(p: any): string {
  const packSize = Number(p.pack_size ?? 1);
  const packs = Number(p.stock_packs ?? 0);
  const bottles = Number(p.stock_bottles ?? p.current_stock ?? 0);
  const total = Number(p.current_stock ?? packs * packSize + bottles);
  return `${fmtQty(packs)} pack(s) + ${fmtQty(bottles)} bottle(s) (${fmtQty(total)} bottles total, ${packSize}/pack)`;
}

function calculateBottleSaleStock(p: any, qty: number): { stock_packs: number; stock_bottles: number } | null {
  const packSize = Number(p.pack_size ?? 1);
  const packs = Number(p.stock_packs ?? 0);
  const bottles = Number(p.stock_bottles ?? p.current_stock ?? 0);
  const total = packs * packSize + bottles;
  if (qty > total) return null;
  if (qty <= bottles) return { stock_packs: packs, stock_bottles: bottles - qty };
  const neededFromPacks = qty - bottles;
  const packsToOpen = Math.ceil(neededFromPacks / packSize);
  return {
    stock_packs: packs - packsToOpen,
    stock_bottles: bottles + packsToOpen * packSize - qty,
  };
}

function getCart(s: any): CartItem[] {
  const c = s?.data?.cart;
  return Array.isArray(c) ? (c as CartItem[]) : [];
}

async function nextInvoiceNo(): Promise<string> {
  const db = getServiceClient();
  const today = new Date();
  const ymd = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, "0")}${String(today.getUTCDate()).padStart(2, "0")}`;
  const startOfDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
  const { count } = await db
    .from("sales")
    .select("*", { count: "exact", head: true })
    .gte("created_at", startOfDay);
  const seq = String((count ?? 0) + 1).padStart(4, "0");
  return `INV-${ymd}-${seq}`;
}

export async function openSale(chatId: number, user: BotUser) {
  await saveSession(user.telegram_id, {
    user_id: user.id,
    authenticated: true,
    state: "sale:search",
    data: { cart: [] },
  });
  await sendMessage(
    chatId,
    "🛒 <b>New Sale</b>\n\nSend a product <b>name</b>, <b>SKU</b>, or <b>barcode</b> to add it to the cart.",
    { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Sale", callback_data: "sale:cancel" }]] } },
  );
}

export async function handleSaleCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!data.startsWith("sale:")) return false;
  const db = getServiceClient();
  const session = await loadSession(user.telegram_id);
  const sData = (session?.data ?? {}) as Record<string, any>;
  const cart = getCart(session);

  if (data === "sale:cancel") {
    await saveSession(user.telegram_id, { state: null, data: {} });
    await sendMessage(chatId, "❌ Sale cancelled.", { reply_markup: BACK });
    return true;
  }

  if (data.startsWith("sale:pick:")) {
    const pid = data.slice("sale:pick:".length);
    const { data: prod } = await db
      .from("products")
      .select("id,name,sku,current_stock,stock_packs,stock_bottles,pack_size,pack_selling_price,bottle_selling_price,pack_cost_price,bottle_cost_price,selling_price,cost_price")
      .eq("id", pid)
      .maybeSingle();
    if (!prod) {
      await sendMessage(chatId, "Product not found.");
      return true;
    }
    await saveSession(user.telegram_id, {
      state: "sale:unit",
      data: { ...sData, pending: prod },
    });
    await sendMessage(
      chatId,
      `<b>${escapeHtml(prod.name)}</b>\nStock: ${escapeHtml(stockLabel(prod))}\nPack: ₦${fmtMoney((prod as any).pack_selling_price)} • Bottle: ₦${fmtMoney((prod as any).bottle_selling_price ?? (prod as any).selling_price)}\n\nChoose how you are selling it:`,
      { reply_markup: { inline_keyboard: [
        [{ text: "📦 Sell Packs", callback_data: "sale:unit:pack" }, { text: "🍾 Sell Bottles", callback_data: "sale:unit:bottle" }],
        [{ text: "❌ Cancel Sale", callback_data: "sale:cancel" }],
      ] } },
    );
    return true;
  }

  if (data === "sale:unit:pack" || data === "sale:unit:bottle") {
    const saleUnit = data.endsWith(":pack") ? "pack" : "bottle";
    const pending = sData.pending;
    if (!pending) {
      await saveSession(user.telegram_id, { state: "sale:search", data: { ...sData, pending: null } });
      await sendMessage(chatId, "Send a product name, SKU, or barcode.");
      return true;
    }
    const available = saleUnit === "pack" ? Number(pending.stock_packs ?? 0) : Number(pending.current_stock ?? 0);
    const price = saleUnit === "pack" ? Number(pending.pack_selling_price ?? 0) : Number(pending.bottle_selling_price ?? pending.selling_price ?? 0);
    await saveSession(user.telegram_id, { state: "sale:qty", data: { ...sData, sale_unit: saleUnit } });
    await sendMessage(chatId, `<b>${escapeHtml(pending.name)}</b>\nSelling: <b>${saleUnit}(s)</b> at ₦${fmtMoney(price)} each\nAvailable: ${fmtQty(available)} ${saleUnit}(s)\n\nSend quantity to sell.`);
    return true;
  }

  if (data === "sale:more") {
    await saveSession(user.telegram_id, { state: "sale:search", data: sData });
    await sendMessage(chatId, "Send another product name, SKU, or barcode.");
    return true;
  }

  if (data === "sale:checkout") {
    if (cart.length === 0) {
      await sendMessage(chatId, "Cart is empty. Add a product first.");
      return true;
    }
    await saveSession(user.telegram_id, { state: "sale:customer", data: sData });
    await sendMessage(
      chatId,
      `${cartSummary(cart)}\n\n👤 <b>Customer</b>?\n\nSend the customer name and phone (e.g. <code>John 08012345678</code>) or tap Walk-in.`,
      { reply_markup: { inline_keyboard: [
        [{ text: "🚶 Walk-in customer", callback_data: "sale:walkin" }],
        [{ text: "❌ Cancel Sale", callback_data: "sale:cancel" }],
      ] } },
    );
    return true;
  }

  if (data === "sale:walkin") {
    await saveSession(user.telegram_id, { state: "sale:payment", data: { ...sData, customer_id: null, customer_label: "Walk-in" } });
    await askPayment(chatId, cart, "Walk-in");
    return true;
  }

  if (data.startsWith("sale:pay:")) {
    const method = data.slice("sale:pay:".length) as "cash" | "transfer" | "pos" | "credit";
    return finalizeSale(chatId, user, method, cart, sData);
  }

  return false;
}

async function askPayment(chatId: number, cart: CartItem[], customerLabel: string) {
  const total = cart.reduce((s, c) => s + c.line_total, 0);
  await sendMessage(
    chatId,
    `<b>Customer:</b> ${escapeHtml(customerLabel)}\n${cartSummary(cart)}\n\n💳 Select <b>payment method</b>:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💵 Cash", callback_data: "sale:pay:cash" }, { text: "🏦 Transfer", callback_data: "sale:pay:transfer" }],
          [{ text: "💳 POS Card", callback_data: "sale:pay:pos" }, { text: "📝 Credit", callback_data: "sale:pay:credit" }],
          [{ text: "❌ Cancel Sale", callback_data: "sale:cancel" }],
        ],
      },
    },
  );
  void total;
}

export async function handleSaleMessage(text: string, chatId: number, user: BotUser): Promise<boolean> {
  const session = await loadSession(user.telegram_id);
  const state = session?.state ?? "";
  if (!state.startsWith("sale:")) return false;
  const db = getServiceClient();
  const sData = (session?.data ?? {}) as Record<string, any>;
  const cart = getCart(session);

  if (state === "sale:search") {
    const q = text.trim();
    const { data: rows } = await db
      .from("products")
      .select("id,name,sku,current_stock,stock_packs,stock_bottles,pack_size,pack_selling_price,bottle_selling_price,pack_cost_price,bottle_cost_price,selling_price,cost_price")
      .eq("archived", false)
      .gt("current_stock", 0)
      .or(`name.ilike.%${q}%,sku.ilike.%${q}%,barcode.eq.${q}`)
      .limit(6);
    if (!rows || rows.length === 0) {
      await sendMessage(chatId, `No in-stock product matches “${escapeHtml(q)}”. Try again.`);
      return true;
    }
    const lines = rows.map(
      (p: any) =>
        `• <b>${escapeHtml(p.name)}</b> — Pack ₦${fmtMoney(p.pack_selling_price)} • Bottle ₦${fmtMoney(p.bottle_selling_price ?? p.selling_price)}\n   Stock: ${escapeHtml(stockLabel(p))}`,
    );
    const buttons = rows.map((p: any) => [{ text: `${p.name} — ₦${fmtMoney(p.selling_price)}`.slice(0, 60), callback_data: `sale:pick:${p.id}` }]);
    buttons.push([{ text: "❌ Cancel Sale", callback_data: "sale:cancel" }]);
    await sendMessage(chatId, `🔎 Pick a product:\n\n${lines.join("\n")}`, { reply_markup: { inline_keyboard: buttons } });
    return true;
  }

  if (state === "sale:qty") {
    const qty = Number(text);
    const pending = sData.pending;
    const saleUnit = (sData.sale_unit === "pack" ? "pack" : "bottle") as "pack" | "bottle";
    if (!pending) {
      await saveSession(user.telegram_id, { state: "sale:search", data: { ...sData, pending: null } });
      await sendMessage(chatId, "Send a product name, SKU, or barcode.");
      return true;
    }
    if (!isFinite(qty) || qty <= 0) {
      await sendMessage(chatId, "Invalid quantity. Send a positive number.");
      return true;
    }
    const available = saleUnit === "pack" ? Number(pending.stock_packs ?? 0) : Number(pending.current_stock ?? 0);
    if (qty > available) {
      await sendMessage(chatId, `Only ${fmtQty(available)} ${saleUnit}(s) in stock. Send a smaller quantity.`);
      return true;
    }
    const unit = saleUnit === "pack" ? Number(pending.pack_selling_price ?? 0) : Number(pending.bottle_selling_price ?? pending.selling_price ?? 0);
    const cost = saleUnit === "pack" ? Number(pending.pack_cost_price ?? 0) : Number(pending.bottle_cost_price ?? pending.cost_price ?? 0);
    const item: CartItem = {
      product_id: pending.id,
      name: pending.name,
      sku: pending.sku ?? null,
      sale_unit: saleUnit,
      qty,
      unit_price: unit,
      cost_price: cost,
      line_total: +(unit * qty).toFixed(2),
      pack_size: Number(pending.pack_size ?? 1),
    };
    const newCart = [...cart, item];
    await saveSession(user.telegram_id, {
      state: "sale:more",
      data: { ...sData, pending: null, sale_unit: null, cart: newCart },
    });
    await sendMessage(
      chatId,
      `✅ Added: <b>${escapeHtml(item.name)}</b> × ${qty} ${saleUnit}(s) = ₦${fmtMoney(item.line_total)}\n\n${cartSummary(newCart)}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Add Another", callback_data: "sale:more" }, { text: "✅ Checkout", callback_data: "sale:checkout" }],
            [{ text: "❌ Cancel Sale", callback_data: "sale:cancel" }],
          ],
        },
      },
    );
    return true;
  }

  if (state === "sale:customer") {
    // Parse "Name 0801..." or just "Name"
    const trimmed = text.trim();
    const phoneMatch = trimmed.match(/(\+?\d[\d\s-]{6,})$/);
    const phone = phoneMatch ? phoneMatch[1].replace(/\s|-/g, "") : null;
    const name = (phone ? trimmed.replace(phoneMatch![1], "").trim() : trimmed).slice(0, 100) || "Customer";
    // upsert by phone if given, else by name
    let customerId: string | null = null;
    if (phone) {
      const { data: existing } = await db.from("customers").select("id").eq("phone", phone).maybeSingle();
      if (existing) customerId = existing.id;
    }
    if (!customerId) {
      const { data: ins } = await db
        .from("customers")
        .insert({ name, phone })
        .select("id")
        .single();
      customerId = ins?.id ?? null;
    }
    await saveSession(user.telegram_id, {
      state: "sale:payment",
      data: { ...sData, customer_id: customerId, customer_label: phone ? `${name} (${phone})` : name },
    });
    await askPayment(chatId, cart, phone ? `${name} (${phone})` : name);
    return true;
  }

  return false;
}

async function finalizeSale(
  chatId: number,
  user: BotUser,
  method: "cash" | "transfer" | "pos" | "credit",
  cart: CartItem[],
  sData: Record<string, any>,
): Promise<boolean> {
  if (cart.length === 0) {
    await sendMessage(chatId, "Cart is empty.", { reply_markup: BACK });
    return true;
  }
  const db = getServiceClient();
  const subtotal = +cart.reduce((s, c) => s + c.line_total, 0).toFixed(2);
  const invoice = await nextInvoiceNo();
  const customerId: string | null = sData.customer_id ?? null;

  const productIds = [...new Set(cart.map((c) => c.product_id))];
  const { data: liveProducts } = await db
    .from("products")
    .select("id,name,current_stock,stock_packs,stock_bottles,pack_size,archived")
    .in("id", productIds);
  const live = new Map((liveProducts ?? []).map((p: any) => [String(p.id), { ...p }]));
  for (const c of cart) {
    const prod = live.get(c.product_id) as any;
    if (!prod || prod.archived) {
      await sendMessage(chatId, `❌ ${escapeHtml(c.name)} is no longer available. Please start the sale again.`, { reply_markup: BACK });
      await saveSession(user.telegram_id, { state: null, data: {} });
      return true;
    }
    const next = c.sale_unit === "pack"
      ? { stock_packs: Number(prod.stock_packs ?? 0) - c.qty, stock_bottles: Number(prod.stock_bottles ?? 0) }
      : calculateBottleSaleStock(prod, c.qty);
    if (!next || next.stock_packs < 0 || next.stock_bottles < 0) {
      await sendMessage(chatId, `❌ Not enough stock for <b>${escapeHtml(c.name)}</b>. Current: ${escapeHtml(stockLabel(prod))}. Please start the sale again.`, { reply_markup: BACK });
      await saveSession(user.telegram_id, { state: null, data: {} });
      return true;
    }
    prod.stock_packs = next.stock_packs;
    prod.stock_bottles = next.stock_bottles;
    prod.current_stock = next.stock_packs * Number(prod.pack_size ?? 1) + next.stock_bottles;
  }

  const { data: sale, error: saleErr } = await db
    .from("sales")
    .insert({
      invoice_no: invoice,
      user_id: user.id,
      customer_id: customerId,
      subtotal,
      discount: 0,
      tax: 0,
      total: subtotal,
      status: "completed",
    })
    .select("id,invoice_no,total,created_at")
    .single();

  if (saleErr || !sale) {
    await sendMessage(chatId, `❌ Failed to record sale: ${escapeHtml(saleErr?.message ?? "unknown")}`, { reply_markup: BACK });
    await saveSession(user.telegram_id, { state: null, data: {} });
    return true;
  }

  // Insert line items, payment, stock movements, decrement stock
  const items = cart.map((c) => ({
    sale_id: sale.id,
    product_id: c.product_id,
    quantity: c.qty,
    unit_price: c.unit_price,
    cost_price: c.cost_price,
    line_total: c.line_total,
    sale_unit: c.sale_unit,
    pack_quantity: c.sale_unit === "pack" ? c.qty : 0,
    bottle_quantity: c.sale_unit === "bottle" ? c.qty : c.qty * c.pack_size,
  }));
  await db.from("sale_items").insert(items);

  await db.from("payments").insert({
    sale_id: sale.id,
    method,
    amount: subtotal,
  });

  for (const c of cart) {
    const physicalChange = c.sale_unit === "pack" ? -(c.qty * c.pack_size) : -c.qty;
    await db.from("stock_movements").insert({
      product_id: c.product_id,
      change: physicalChange,
      reason: "sale",
      reference: invoice,
      user_id: user.id,
    });
    const { data: prod } = await db.from("products").select("current_stock,min_stock,name,stock_packs,stock_bottles,pack_size").eq("id", c.product_id).single();
    if (prod) {
      const next = c.sale_unit === "pack"
        ? { stock_packs: Number((prod as any).stock_packs ?? 0) - c.qty, stock_bottles: Number((prod as any).stock_bottles ?? 0) }
        : calculateBottleSaleStock(prod, c.qty);
      if (!next || next.stock_packs < 0 || next.stock_bottles < 0) {
        await notifyOwner("low_stock", "Stock update warning", `${prod.name} did not have enough ${c.sale_unit} stock while closing ${invoice}.`, { product_id: c.product_id });
        continue;
      }
      const { data: updated } = await db.from("products").update(next).eq("id", c.product_id).select("current_stock,min_stock,name").single();
      const newStock = Number((updated as any)?.current_stock ?? 0);
      if (newStock <= Number((updated as any)?.min_stock ?? prod.min_stock)) {
        await notifyOwner("low_stock", "Low stock alert", `${prod.name} is at ${fmtQty(newStock)} bottle(s) total (min ${prod.min_stock}).`, {
          product_id: c.product_id,
        });
      }
    }
  }

  // If credit, add to customer outstanding balance
  if (method === "credit" && customerId) {
    const { data: cust } = await db.from("customers").select("outstanding_balance").eq("id", customerId).single();
    const newBal = Number(cust?.outstanding_balance ?? 0) + subtotal;
    await db.from("customers").update({ outstanding_balance: newBal }).eq("id", customerId);
  }

  await logActivity({
    user_id: user.id,
    telegram_id: user.telegram_id,
    action: "sale_create",
    meta: { sale_id: sale.id, invoice, total: subtotal, method },
  });

  const receipt = formatReceipt(invoice, cart, subtotal, method, sData.customer_label ?? "Walk-in", user.full_name);
  await saveSession(user.telegram_id, { state: null, data: {} });
  await sendMessage(chatId, receipt, { reply_markup: BACK });

  await notifyOwner(
    "sale",
    `Sale ${invoice}`,
    `${user.full_name} sold ${cart.length} item(s) — ₦${fmtMoney(subtotal)} via ${method}.`,
    { sale_id: sale.id, total: subtotal },
  );
  return true;
}

function formatReceipt(invoice: string, cart: CartItem[], total: number, method: string, customer: string, cashier: string): string {
  const lines = cart
    .map((c) => `  ${escapeHtml(c.name)}\n  ${c.qty} ${c.sale_unit}(s) × ₦${fmtMoney(c.unit_price)} = ₦${fmtMoney(c.line_total)}`)
    .join("\n");
  return (
    `🧾 <b>STOREMAX LIMITED</b>\n` +
    `<b>Invoice:</b> <code>${escapeHtml(invoice)}</code>\n` +
    `<b>Date:</b> ${new Date().toLocaleString()}\n` +
    `<b>Customer:</b> ${escapeHtml(customer)}\n` +
    `<b>Cashier:</b> ${escapeHtml(cashier)}\n` +
    `———————————————\n${lines}\n` +
    `———————————————\n` +
    `<b>TOTAL:</b> ₦${fmtMoney(total)}\n` +
    `<b>Paid by:</b> ${escapeHtml(method.toUpperCase())}\n\n` +
    `✅ Sale completed. Thank you!`
  );
}
