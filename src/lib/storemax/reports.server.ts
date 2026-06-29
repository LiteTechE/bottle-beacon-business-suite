import { getServiceClient } from "./db.server";
import { sendMessage, sendDocument, type ReplyMarkup } from "./telegram.server";
import { buildSalesReportPdf, buildDailySummaryPdf } from "./pdf.server";

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

export function reportsMenu(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "📅 Today", callback_data: "rpt:today" }, { text: "🗓 This Week", callback_data: "rpt:week" }],
      [{ text: "📆 This Month", callback_data: "rpt:month" }],
      [{ text: "🏆 Top Products (30d)", callback_data: "rpt:top" }],
      [{ text: "📈 Profit & Loss (30d)", callback_data: "rpt:pl" }],
      [{ text: "📄 Daily Summary PDF", callback_data: "rpt:pdf:daily" }],
      [{ text: "📄 PDF: Today", callback_data: "rpt:pdf:today" }, { text: "📄 PDF: Week", callback_data: "rpt:pdf:week" }],
      [{ text: "📄 PDF: Month", callback_data: "rpt:pdf:month" }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ],
  };
}

export async function openReports(chatId: number, user: BotUser) {
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Reports are restricted to the owner.", { reply_markup: BACK });
    return;
  }
  await sendMessage(chatId, "📊 <b>Reports</b>\n\nPick a report:", { reply_markup: reportsMenu() });
}

async function periodSummary(chatId: number, sinceIso: string, label: string) {
  const db = getServiceClient();
  const { data: sales } = await db
    .from("sales")
    .select("id,total,payment_status,created_at,user_id")
    .gte("created_at", sinceIso);
  const rows = sales ?? [];
  const count = rows.length;
  const gross = rows.reduce((s: number, x: any) => s + Number(x.total), 0);
  const credit = rows.filter((x: any) => x.payment_status === "credit").reduce((s: number, x: any) => s + Number(x.total), 0);

  // Cost of goods sold via sale_items
  const ids = rows.map((r: any) => r.id);
  let cogs = 0;
  if (ids.length > 0) {
    const { data: items } = await db
      .from("sale_items")
      .select("quantity,cost_price")
      .in("sale_id", ids);
    cogs = (items ?? []).reduce((s: number, i: any) => s + Number(i.quantity) * Number(i.cost_price ?? 0), 0);
  }

  const { data: expenses } = await db
    .from("expenses")
    .select("amount")
    .gte("created_at", sinceIso);
  const expTotal = (expenses ?? []).reduce((s: number, e: any) => s + Number(e.amount), 0);
  const profit = gross - cogs - expTotal;

  await sendMessage(
    chatId,
    `📊 <b>Sales Report — ${label}</b>\n\n` +
      `Transactions: <b>${count}</b>\n` +
      `Gross Sales: <b>₦${fmtMoney(gross)}</b>\n` +
      `On Credit: ₦${fmtMoney(credit)}\n` +
      `COGS: ₦${fmtMoney(cogs)}\n` +
      `Expenses: ₦${fmtMoney(expTotal)}\n` +
      `<b>Net Profit: ₦${fmtMoney(profit)}</b>`,
    { reply_markup: reportsMenu() },
  );
}

async function topProducts(chatId: number) {
  const db = getServiceClient();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: sales } = await db.from("sales").select("id").gte("created_at", since);
  const ids = (sales ?? []).map((s: any) => s.id);
  if (ids.length === 0) {
    await sendMessage(chatId, "No sales in the last 30 days.", { reply_markup: reportsMenu() });
    return;
  }
  const { data: items } = await db
    .from("sale_items")
    .select("product_id,quantity,line_total,products(name)")
    .in("sale_id", ids);
  const map = new Map<string, { name: string; qty: number; revenue: number }>();
  for (const it of items ?? []) {
    const key = String((it as any).product_id);
    const name = (it as any).products?.name ?? "Unknown";
    const entry = map.get(key) ?? { name, qty: 0, revenue: 0 };
    entry.qty += Number((it as any).quantity);
    entry.revenue += Number((it as any).line_total);
    map.set(key, entry);
  }
  const top = [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const lines = top.map(
    (p, i) => `${i + 1}. <b>${escapeHtml(p.name)}</b> — ${p.qty} sold • ₦${fmtMoney(p.revenue)}`,
  );
  await sendMessage(
    chatId,
    `🏆 <b>Top Products — Last 30 Days</b>\n\n${lines.join("\n")}`,
    { reply_markup: reportsMenu() },
  );
}

async function profitAndLoss(chatId: number) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  await periodSummary(chatId, since, "Last 30 Days");
}

export async function handleReportsCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!data.startsWith("rpt:")) return false;
  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Owner only.", { reply_markup: BACK });
    return true;
  }

  if (data === "rpt:today") {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    await periodSummary(chatId, d.toISOString(), "Today");
    return true;
  }
  if (data === "rpt:week") {
    const d = new Date(Date.now() - 7 * 86400_000);
    await periodSummary(chatId, d.toISOString(), "Last 7 Days");
    return true;
  }
  if (data === "rpt:month") {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
    await periodSummary(chatId, d.toISOString(), "This Month");
    return true;
  }
  if (data === "rpt:top") {
    await topProducts(chatId);
    return true;
  }
  if (data === "rpt:pl") {
    await profitAndLoss(chatId);
    return true;
  }
  if (data.startsWith("rpt:pdf:")) {
    const kind = data.slice("rpt:pdf:".length);
    await sendMessage(chatId, "📄 Generating PDF…");
    try {
      if (kind === "daily") {
        const { url, filename } = await buildDailySummaryPdf();
        await sendDocument(chatId, url, { caption: `📅 <b>Daily Summary</b>\n${filename}`, reply_markup: reportsMenu() });
      } else {
        let since: Date; let label: string;
        if (kind === "today") { since = new Date(); since.setHours(0, 0, 0, 0); label = "Today"; }
        else if (kind === "week") { since = new Date(Date.now() - 7 * 86400_000); label = "Last 7 Days"; }
        else { since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0); label = "This Month"; }
        const { url, filename } = await buildSalesReportPdf({ sinceIso: since.toISOString(), label });
        await sendDocument(chatId, url, { caption: `📊 <b>Sales Report — ${label}</b>\n${filename}`, reply_markup: reportsMenu() });
      }
    } catch (err: any) {
      await sendMessage(chatId, `❌ PDF failed: ${escapeHtml(err.message ?? String(err))}`, { reply_markup: reportsMenu() });
    }
    return true;
  }
  return false;
}

export async function mySalesToday(chatId: number, user: BotUser) {
  const db = getServiceClient();
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const { data: rows } = await db
    .from("sales")
    .select("invoice_no,total,payment_status,created_at")
    .eq("user_id", user.id)
    .gte("created_at", d.toISOString())
    .order("created_at", { ascending: false });
  if (!rows || rows.length === 0) {
    await sendMessage(chatId, "📋 No sales recorded today.", { reply_markup: BACK });
    return;
  }
  const total = rows.reduce((s: number, x: any) => s + Number(x.total), 0);
  const lines = rows.map(
    (s: any) => `• <code>${escapeHtml(s.invoice_no)}</code> — ₦${fmtMoney(s.total)} (${s.payment_status})`,
  );
  await sendMessage(
    chatId,
    `📋 <b>My Sales Today (${rows.length})</b>\n\n${lines.join("\n")}\n\n<b>Total: ₦${fmtMoney(total)}</b>`,
    { reply_markup: BACK },
  );
}
