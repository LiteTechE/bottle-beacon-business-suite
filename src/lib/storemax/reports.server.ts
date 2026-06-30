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

// ---------- Period boundaries ----------
type Period = "today" | "week" | "month" | "year";

function periodRange(p: Period): { since: Date; label: string } {
  const now = new Date();
  if (p === "today") {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return { since: d, label: "Today" };
  }
  if (p === "week") {
    // Start of this week (Mon)
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    const day = (d.getDay() + 6) % 7; // Mon=0
    d.setDate(d.getDate() - day);
    return { since: d, label: "This Week" };
  }
  if (p === "month") {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { since: d, label: "This Month" };
  }
  const d = new Date(now.getFullYear(), 0, 1);
  return { since: d, label: "This Year" };
}

export function reportsMenu(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "📅 Today", callback_data: "rpt:today" }, { text: "🗓 This Week", callback_data: "rpt:week" }],
      [{ text: "📆 This Month", callback_data: "rpt:month" }, { text: "📈 This Year", callback_data: "rpt:year" }],
      [{ text: "🏆 Top Products (30d)", callback_data: "rpt:top" }],
      [{ text: "🧑‍💼 Staff Performance", callback_data: "rpt:staff" }],
      [{ text: "📄 Daily Summary PDF", callback_data: "rpt:pdf:daily" }],
      [{ text: "📄 PDF: Today", callback_data: "rpt:pdf:today" }, { text: "📄 PDF: Week", callback_data: "rpt:pdf:week" }],
      [{ text: "📄 PDF: Month", callback_data: "rpt:pdf:month" }, { text: "📄 PDF: Year", callback_data: "rpt:pdf:year" }],
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

async function staffPerformance(chatId: number) {
  const db = getServiceClient();
  const { since } = periodRange("month");
  const { data: sales } = await db
    .from("sales")
    .select("user_id,total,payment_status")
    .gte("created_at", since.toISOString());
  const rows = sales ?? [];
  if (rows.length === 0) {
    await sendMessage(chatId, "No sales this month.", { reply_markup: reportsMenu() });
    return;
  }
  const map = new Map<string, { count: number; gross: number; credit: number }>();
  for (const r of rows) {
    const k = String((r as any).user_id);
    const e = map.get(k) ?? { count: 0, gross: 0, credit: 0 };
    e.count++;
    e.gross += Number((r as any).total);
    if ((r as any).payment_status === "credit") e.credit += Number((r as any).total);
    map.set(k, e);
  }
  const userIds = [...map.keys()];
  const { data: users } = await db.from("bot_users").select("id,full_name,role").in("id", userIds);
  const names = new Map((users ?? []).map((u: any) => [u.id, u.full_name as string]));
  const entries = [...map.entries()].sort((a, b) => b[1].gross - a[1].gross);
  const lines = entries.map(
    ([uid, v], i) =>
      `${i + 1}. <b>${escapeHtml(names.get(uid) ?? "Unknown")}</b>\n   ${v.count} sales • ₦${fmtMoney(v.gross)} (credit ₦${fmtMoney(v.credit)})`,
  );
  await sendMessage(
    chatId,
    `🧑‍💼 <b>Staff Performance — This Month</b>\n\n${lines.join("\n\n")}`,
    { reply_markup: reportsMenu() },
  );
}

export async function handleReportsCallback(data: string, chatId: number, user: BotUser): Promise<boolean> {
  if (!data.startsWith("rpt:") && !data.startsWith("myperf:")) return false;

  // Sales-rep personal performance — sales_rep allowed
  if (data.startsWith("myperf:")) {
    const period = data.slice("myperf:".length) as Period;
    await personalPerformance(chatId, user, period);
    return true;
  }

  if (user.role !== "owner") {
    await sendMessage(chatId, "⛔ Owner only.", { reply_markup: BACK });
    return true;
  }

  if (data === "rpt:today" || data === "rpt:week" || data === "rpt:month" || data === "rpt:year") {
    const { since, label } = periodRange(data.slice(4) as Period);
    await periodSummary(chatId, since.toISOString(), label);
    return true;
  }
  if (data === "rpt:top") { await topProducts(chatId); return true; }
  if (data === "rpt:staff") { await staffPerformance(chatId); return true; }

  if (data.startsWith("rpt:pdf:")) {
    const kind = data.slice("rpt:pdf:".length);
    await sendMessage(chatId, "📄 Generating PDF…");
    try {
      if (kind === "daily") {
        const { url, filename } = await buildDailySummaryPdf();
        await sendDocument(chatId, url, { caption: `📅 <b>Daily Summary</b>\n${filename}`, reply_markup: reportsMenu() });
      } else {
        const { since, label } = periodRange(kind as Period);
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

function perfMenu(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "📅 Today", callback_data: "myperf:today" }, { text: "🗓 Week", callback_data: "myperf:week" }],
      [{ text: "📆 Month", callback_data: "myperf:month" }, { text: "📈 Year", callback_data: "myperf:year" }],
      [{ text: "⬅️ Back to Menu", callback_data: "menu:main" }],
    ],
  };
}

async function personalPerformance(chatId: number, user: BotUser, period: Period) {
  const db = getServiceClient();
  const { since, label } = periodRange(period);
  const { data: rows } = await db
    .from("sales")
    .select("invoice_no,total,payment_status,created_at")
    .eq("user_id", user.id)
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(50);
  const list = rows ?? [];
  const total = list.reduce((s: number, x: any) => s + Number(x.total), 0);
  const credit = list.filter((x: any) => x.payment_status === "credit").reduce((s: number, x: any) => s + Number(x.total), 0);
  const header = `📋 <b>My Performance — ${label}</b>\n\nTransactions: <b>${list.length}</b>\nGross: <b>₦${fmtMoney(total)}</b>\nOn Credit: ₦${fmtMoney(credit)}`;
  if (list.length === 0) {
    await sendMessage(chatId, header + "\n\nNo sales yet.", { reply_markup: perfMenu() });
    return;
  }
  const preview = list.slice(0, 10).map(
    (s: any) => `• <code>${escapeHtml(s.invoice_no)}</code> — ₦${fmtMoney(s.total)} (${s.payment_status})`,
  );
  await sendMessage(
    chatId,
    `${header}\n\n<b>Recent:</b>\n${preview.join("\n")}`,
    { reply_markup: perfMenu() },
  );
}

export async function mySalesToday(chatId: number, user: BotUser) {
  await personalPerformance(chatId, user, "today");
}

export async function openMyPerformance(chatId: number, user: BotUser) {
  await personalPerformance(chatId, user, "today");
}
