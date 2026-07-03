import { getServiceClient } from "./db.server";
import { sendMessage, type ReplyMarkup } from "./telegram.server";

interface BotUser {
  id: string;
  telegram_id: number;
  role: "owner" | "sales_rep";
  full_name: string;
}

const PAGE_SIZE = 10;

const BACK: ReplyMarkup = {
  inline_keyboard: [[{ text: "⬅️ Back to Menu", callback_data: "menu:main" }]],
};

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtMoney(n: number | string | null | undefined): string {
  return Number(n ?? 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-NG", { dateStyle: "short", timeStyle: "short" });
}
function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ================= HUB =================

export function transactionsMenu(role: "owner" | "sales_rep"): ReplyMarkup {
  const rows: { text: string; callback_data: string }[][] = [
    [{ text: "📜 All Transactions", callback_data: "txn:list:0" }],
    [{ text: "🔴 Live Sales Feed", callback_data: "txn:live" }],
  ];
  if (role === "owner") {
    rows.push([{ text: "🧾 Inventory Audit Trail", callback_data: "txn:audit:0" }]);
  }
  rows.push([{ text: "⬅️ Back to Menu", callback_data: "menu:main" }]);
  return { inline_keyboard: rows };
}

export async function openTransactions(chatId: number, user: BotUser) {
  await sendMessage(
    chatId,
    "🧭 <b>Transactions & Activity</b>\n\nView every sale, live feed, and inventory audit trail.",
    { reply_markup: transactionsMenu(user.role) },
  );
}

// ================= ALL TRANSACTIONS =================

async function listTransactions(chatId: number, user: BotUser, page: number) {
  const db = getServiceClient();
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  let query = db
    .from("sales")
    .select("id,invoice_no,total,created_at,customer_id,user_id,customers(name),bot_users(full_name),payments(method)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);
  if (user.role !== "owner") query = query.eq("user_id", user.id);
  const { data, count } = await query;
  const rows = data ?? [];
  const total = count ?? 0;

  if (rows.length === 0) {
    await sendMessage(chatId, "📭 No transactions yet.", { reply_markup: transactionsMenu(user.role) });
    return;
  }

  const lines = rows.map((s: any) => {
    const method = (Array.isArray(s.payments) && s.payments[0]?.method) || "cash";
    const who = user.role === "owner" ? ` • ${escapeHtml(s.bot_users?.full_name ?? "—")}` : "";
    const cust = s.customers?.name ? ` • ${escapeHtml(s.customers.name)}` : "";
    return `• <code>${escapeHtml(s.invoice_no)}</code> ₦${fmtMoney(s.total)} <i>${method}</i>${cust}${who}\n   <i>${fmtDate(s.created_at)}</i> — /txn_${s.invoice_no}`;
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const nav: { text: string; callback_data: string }[] = [];
  if (page > 0) nav.push({ text: "⬅️ Prev", callback_data: `txn:list:${page - 1}` });
  if (page < totalPages - 1) nav.push({ text: "Next ➡️", callback_data: `txn:list:${page + 1}` });

  const detailRows = rows.slice(0, 8).map((s: any) => [
    { text: `🧾 ${s.invoice_no}`, callback_data: `txn:view:${s.id}` },
  ]);

  const kb: ReplyMarkup = {
    inline_keyboard: [
      ...detailRows,
      ...(nav.length ? [nav] : []),
      [{ text: "🔄 Refresh", callback_data: `txn:list:${page}` }],
      [{ text: "⬅️ Back", callback_data: "menu:txn" }],
    ],
  };

  await sendMessage(
    chatId,
    `📜 <b>All Transactions</b> — Page ${page + 1}/${totalPages} (${total} total)\n\n${lines.join("\n\n")}`,
    { reply_markup: kb },
  );
}

async function viewTransaction(chatId: number, user: BotUser, saleId: string) {
  const db = getServiceClient();
  const { data: sale } = await db
    .from("sales")
    .select("*,customers(name,phone),bot_users(full_name),payments(method,amount),sale_items(quantity,unit_price,line_total,sale_unit,pack_quantity,bottle_quantity,cost_price,products(name))")
    .eq("id", saleId)
    .maybeSingle();
  if (!sale) {
    await sendMessage(chatId, "❌ Transaction not found.", { reply_markup: transactionsMenu(user.role) });
    return;
  }
  if (user.role !== "owner" && sale.user_id !== user.id) {
    await sendMessage(chatId, "⛔ You can only view your own sales.", { reply_markup: transactionsMenu(user.role) });
    return;
  }
  const items = (sale.sale_items ?? []) as any[];
  const itemLines = items.map(
    (i) => `• ${escapeHtml(i.products?.name ?? "?")} — ${i.pack_quantity > 0 ? `${i.pack_quantity} pack ` : ""}${i.bottle_quantity > 0 ? `${i.bottle_quantity} btl` : ""} @ ₦${fmtMoney(i.unit_price)} = <b>₦${fmtMoney(i.line_total)}</b>`,
  );
  const cogs = items.reduce((s, i) => s + Number(i.quantity) * Number(i.cost_price ?? 0), 0);
  const profit = Number(sale.total) - cogs;
  const pay = (sale.payments ?? []) as any[];
  const method = pay[0]?.method ?? "cash";

  await sendMessage(
    chatId,
    `🧾 <b>Invoice ${escapeHtml(sale.invoice_no)}</b>\n\n` +
      `Date: ${fmtDate(sale.created_at)}\n` +
      `Sold by: <b>${escapeHtml(sale.bot_users?.full_name ?? "—")}</b>\n` +
      `Customer: ${escapeHtml(sale.customers?.name ?? "Walk-in")}\n` +
      `Payment: <b>${method}</b>\n\n` +
      `<b>Items:</b>\n${itemLines.join("\n")}\n\n` +
      `Subtotal: ₦${fmtMoney(sale.subtotal)}\n` +
      `Discount: ₦${fmtMoney(sale.discount)}\n` +
      `<b>Total: ₦${fmtMoney(sale.total)}</b>\n` +
      (user.role === "owner" ? `COGS: ₦${fmtMoney(cogs)}\n<b>Profit: ₦${fmtMoney(profit)}</b>` : ""),
    { reply_markup: transactionsMenu(user.role) },
  );
}

// ================= LIVE FEED =================

async function liveFeed(chatId: number, user: BotUser) {
  const db = getServiceClient();
  let query = db
    .from("sales")
    .select("id,invoice_no,total,created_at,customers(name),bot_users(full_name),payments(method)")
    .order("created_at", { ascending: false })
    .limit(20);
  if (user.role !== "owner") query = query.eq("user_id", user.id);
  const { data } = await query;
  const rows = data ?? [];

  if (rows.length === 0) {
    await sendMessage(chatId, "🔴 <b>Live Feed</b>\n\nNo sales yet today.", { reply_markup: transactionsMenu(user.role) });
    return;
  }
  const total = rows.reduce((s: number, x: any) => s + Number(x.total), 0);
  const lines = rows.map((s: any) => {
    const method = (Array.isArray(s.payments) && s.payments[0]?.method) || "cash";
    const who = user.role === "owner" ? ` • ${escapeHtml(s.bot_users?.full_name ?? "—")}` : "";
    return `🟢 <b>₦${fmtMoney(s.total)}</b> <i>${method}</i> — ${timeAgo(s.created_at)}${who}\n   <code>${escapeHtml(s.invoice_no)}</code>${s.customers?.name ? ` • ${escapeHtml(s.customers.name)}` : ""}`;
  });

  await sendMessage(
    chatId,
    `🔴 <b>Live Sales Feed</b> (last ${rows.length})\n` +
      `Running total: <b>₦${fmtMoney(total)}</b>\n\n${lines.join("\n\n")}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Refresh", callback_data: "txn:live" }],
          [{ text: "📜 All Transactions", callback_data: "txn:list:0" }],
          [{ text: "⬅️ Back", callback_data: "menu:txn" }],
        ],
      },
    },
  );
}

// ================= AUDIT TRAIL =================

const REASON_ICON: Record<string, string> = {
  receive: "📥",
  sale: "🛒",
  adjust: "⚖️",
  damage: "💥",
  return: "↩️",
  transfer_in: "➡️",
  transfer_out: "⬅️",
  opening: "🆕",
};

async function auditTrail(chatId: number, user: BotUser, page: number) {
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Owner only.", { reply_markup: BACK });
    return;
  }
  const db = getServiceClient();
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  const { data, count } = await db
    .from("stock_movements")
    .select("id,change,reason,reference,notes,created_at,products(name),bot_users(full_name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);
  const rows = data ?? [];
  const total = count ?? 0;

  if (rows.length === 0) {
    await sendMessage(chatId, "📭 No inventory movements yet.", { reply_markup: transactionsMenu(user.role) });
    return;
  }
  const lines = rows.map((m: any) => {
    const chg = Number(m.change);
    const sign = chg > 0 ? "+" : "";
    const icon = REASON_ICON[m.reason] ?? "•";
    return `${icon} <b>${escapeHtml(m.products?.name ?? "—")}</b> ${sign}${chg}\n   <i>${m.reason}</i>${m.reference ? ` • ${escapeHtml(m.reference)}` : ""} • ${escapeHtml(m.bot_users?.full_name ?? "system")}\n   <i>${fmtDate(m.created_at)}</i>${m.notes ? `\n   💬 ${escapeHtml(m.notes)}` : ""}`;
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const nav: { text: string; callback_data: string }[] = [];
  if (page > 0) nav.push({ text: "⬅️ Prev", callback_data: `txn:audit:${page - 1}` });
  if (page < totalPages - 1) nav.push({ text: "Next ➡️", callback_data: `txn:audit:${page + 1}` });

  await sendMessage(
    chatId,
    `🧾 <b>Inventory Audit Trail</b> — Page ${page + 1}/${totalPages} (${total} entries)\n\n${lines.join("\n\n")}`,
    {
      reply_markup: {
        inline_keyboard: [
          ...(nav.length ? [nav] : []),
          [{ text: "🔄 Refresh", callback_data: `txn:audit:${page}` }],
          [{ text: "⬅️ Back", callback_data: "menu:txn" }],
        ],
      },
    },
  );
}

// ================= CALLBACK ROUTER =================

export async function handleTransactionsCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (data === "menu:txn") {
    await openTransactions(chatId, user);
    return true;
  }
  if (!data.startsWith("txn:")) return false;

  if (data === "txn:live") {
    await liveFeed(chatId, user);
    return true;
  }
  if (data.startsWith("txn:list:")) {
    await listTransactions(chatId, user, Number(data.split(":")[2]) || 0);
    return true;
  }
  if (data.startsWith("txn:view:")) {
    await viewTransaction(chatId, user, data.slice("txn:view:".length));
    return true;
  }
  if (data.startsWith("txn:audit:")) {
    await auditTrail(chatId, user, Number(data.split(":")[2]) || 0);
    return true;
  }
  return false;
}

// ================= MESSAGE HANDLER (/txn_INV-xxxx quicklinks) =================

export async function handleTransactionsMessage(text: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!text.startsWith("/txn_")) return false;
  const invoice = text.slice("/txn_".length).trim();
  const db = getServiceClient();
  const { data: sale } = await db.from("sales").select("id").eq("invoice_no", invoice).maybeSingle();
  if (!sale) {
    await sendMessage(chatId, `❌ Transaction <code>${escapeHtml(invoice)}</code> not found.`);
    return true;
  }
  await viewTransaction(chatId, user, sale.id);
  return true;
}
