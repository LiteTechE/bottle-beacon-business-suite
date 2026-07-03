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

function fmtMoney(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function gatherContext(): Promise<string> {
  const db = getServiceClient();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0,0,0,0);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const yearStart = new Date(new Date().getFullYear(), 0, 1);

  const [
    { data: salesToday },
    { data: salesWeek },
    { data: salesMonth },
    { data: salesYear },
    { data: recentSales },
    { data: lowStock },
    { data: allProducts },
    { data: debtors },
    { data: topItems },
    { data: expenses },
    { data: recentMovements },
    { count: customerCount },
    { count: supplierCount },
    { data: staff },
  ] = await Promise.all([
    db.from("sales").select("total,user_id,bot_users(full_name),payments(method)").gte("created_at", today.toISOString()),
    db.from("sales").select("total").gte("created_at", weekStart.toISOString()),
    db.from("sales").select("total").gte("created_at", monthStart.toISOString()),
    db.from("sales").select("total").gte("created_at", yearStart.toISOString()),
    db.from("sales").select("invoice_no,total,created_at,customers(name),bot_users(full_name),payments(method)").order("created_at",{ascending:false}).limit(10),
    db.from("products").select("name,current_stock,min_stock,stock_packs,stock_bottles,pack_size").eq("archived", false).order("current_stock", { ascending: true }).limit(30),
    db.from("products").select("id,current_stock,bottle_cost_price").eq("archived", false),
    db.from("customers").select("name,outstanding_balance,phone").gt("outstanding_balance", 0).order("outstanding_balance", { ascending: false }).limit(10),
    db.from("sale_items").select("quantity,line_total,cost_price,products(name)").limit(1000),
    db.from("expenses").select("category,amount,description,created_at").gte("created_at", monthStart.toISOString()),
    db.from("stock_movements").select("change,reason,notes,created_at,products(name),bot_users(full_name)").order("created_at",{ascending:false}).limit(15),
    db.from("customers").select("*", { count: "exact", head: true }),
    db.from("suppliers").select("*", { count: "exact", head: true }),
    db.from("bot_users").select("full_name,role,is_active"),
  ]);

  const sum = (rows: any[] | null) => (rows ?? []).reduce((s, x) => s + Number(x.total), 0);
  const todayGross = sum(salesToday);
  const todayCount = (salesToday ?? []).length;
  const weekGross = sum(salesWeek);
  const monthGross = sum(salesMonth);
  const yearGross = sum(salesYear);

  const inventoryValue = (allProducts ?? []).reduce(
    (s: number, p: any) => s + Number(p.current_stock ?? 0) * Number(p.bottle_cost_price ?? 0), 0,
  );

  const productMap = new Map<string, { qty: number; revenue: number; cogs: number }>();
  for (const it of topItems ?? []) {
    const key = (it as any).products?.name ?? "Unknown";
    const e = productMap.get(key) ?? { qty: 0, revenue: 0, cogs: 0 };
    e.qty += Number((it as any).quantity);
    e.revenue += Number((it as any).line_total);
    e.cogs += Number((it as any).quantity) * Number((it as any).cost_price ?? 0);
    productMap.set(key, e);
  }
  const top = [...productMap.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 8);
  const totalRevenue = [...productMap.values()].reduce((s, v) => s + v.revenue, 0);
  const totalCogs = [...productMap.values()].reduce((s, v) => s + v.cogs, 0);

  const expByCat = new Map<string, number>();
  for (const e of expenses ?? []) {
    expByCat.set((e as any).category, (expByCat.get((e as any).category) ?? 0) + Number((e as any).amount));
  }
  const expTotal = [...expByCat.values()].reduce((s, v) => s + v, 0);

  // Sales-rep leaderboard today
  const repMap = new Map<string, number>();
  for (const s of salesToday ?? []) {
    const n = (s as any).bot_users?.full_name ?? "Unknown";
    repMap.set(n, (repMap.get(n) ?? 0) + Number((s as any).total));
  }
  const reps = [...repMap.entries()].sort((a,b)=>b[1]-a[1]);

  const activeStaff = (staff ?? []).filter((s: any) => s.is_active);
  const lowStockList = (lowStock ?? []).filter((p: any) => Number(p.current_stock) <= Number(p.min_stock ?? 0));

  return [
    `Business: STOREMAX LIMITED — Beverage Distribution (Nigeria, currency ₦)`,
    `Date: ${new Date().toISOString()}`,
    ``,
    `=== SALES ===`,
    `Today: ${todayCount} sales, gross ₦${fmtMoney(todayGross)}`,
    `This week: ₦${fmtMoney(weekGross)}`,
    `This month: ₦${fmtMoney(monthGross)}`,
    `This year: ₦${fmtMoney(yearGross)}`,
    `Est. gross profit (recent items): ₦${fmtMoney(totalRevenue - totalCogs)} on revenue ₦${fmtMoney(totalRevenue)}`,
    ``,
    `=== TODAY'S SALES REPS ===`,
    reps.length ? reps.map(([n,v]) => `- ${n}: ₦${fmtMoney(v)}`).join("\n") : "- none",
    ``,
    `=== RECENT TRANSACTIONS (last 10) ===`,
    (recentSales ?? []).map((s: any) => {
      const m = Array.isArray(s.payments) && s.payments[0]?.method || "cash";
      return `- ${s.invoice_no} • ₦${fmtMoney(s.total)} • ${m} • ${s.bot_users?.full_name ?? "?"}${s.customers?.name ? ` → ${s.customers.name}` : ""} • ${new Date(s.created_at).toLocaleString("en-NG")}`;
    }).join("\n") || "- none",
    ``,
    `=== INVENTORY ===`,
    `Total inventory value (cost): ₦${fmtMoney(inventoryValue)}`,
    `Active products: ${(allProducts ?? []).length}`,
    `Low stock (${lowStockList.length}): ${lowStockList.map((p: any) => `${p.name} [${p.stock_packs ?? 0}pk+${p.stock_bottles ?? 0}btl]`).join(", ") || "none"}`,
    ``,
    `=== RECENT STOCK MOVEMENTS (last 15) ===`,
    (recentMovements ?? []).map((m: any) => `- ${m.products?.name ?? "?"} ${Number(m.change)>0?"+":""}${m.change} (${m.reason})${m.notes?` — ${m.notes}`:""} by ${m.bot_users?.full_name ?? "system"}`).join("\n") || "- none",
    ``,
    `=== TOP PRODUCTS (by recent revenue) ===`,
    top.map(([n, v]) => `- ${n}: ${v.qty}u, revenue ₦${fmtMoney(v.revenue)}, profit ₦${fmtMoney(v.revenue - v.cogs)}`).join("\n") || "- none",
    ``,
    `=== CUSTOMERS ===`,
    `Total customers: ${customerCount ?? 0}`,
    `Top debtors: ${(debtors ?? []).map((d: any) => `${d.name} ₦${fmtMoney(d.outstanding_balance)}`).join(", ") || "none"}`,
    ``,
    `=== EXPENSES (this month) ===`,
    `Total: ₦${fmtMoney(expTotal)}`,
    [...expByCat.entries()].map(([c, v]) => `- ${c}: ₦${fmtMoney(v)}`).join("\n") || "- none",
    ``,
    `=== TEAM ===`,
    `Suppliers: ${supplierCount ?? 0}`,
    `Active staff (${activeStaff.length}): ${activeStaff.map((s: any) => `${s.full_name} [${s.role}]`).join(", ") || "none"}`,
    ``,
    `=== NET (this month) ===`,
    `Estimated net = gross ₦${fmtMoney(monthGross)} − expenses ₦${fmtMoney(expTotal)} = ₦${fmtMoney(monthGross - expTotal)} (before COGS)`,
  ].join("\n");
}

async function askAI(question: string, context: string): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    return "⚠️ AI is not configured (LOVABLE_API_KEY missing). Please contact support.";
  }
  const system = `You are STOREMAX POS Assistant — concise, helpful, professional. Answer based ONLY on the business snapshot below. Use ₦ for money. Keep answers under 200 words. If the snapshot doesn't contain the answer, say so plainly.\n\nBUSINESS SNAPSHOT:\n${context}`;

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: system },
        { role: "user", content: question },
      ],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return `⚠️ AI request failed (${res.status}). ${txt.slice(0, 200)}`;
  }
  const j = await res.json() as any;
  return j?.choices?.[0]?.message?.content?.trim() || "🤖 (no response)";
}

export async function openAI(chatId: number, user: BotUser) {
  await saveSession(user.telegram_id, {
    user_id: user.id,
    authenticated: true,
    state: "ai:awaiting_question",
    data: {},
  });
  await sendMessage(
    chatId,
    "🤖 <b>Ask Assistant</b>\n\nAsk anything about your business — sales, inventory, debtors, top products, expenses.\n\nExamples:\n• <i>How much did we sell today?</i>\n• <i>Which products are running low?</i>\n• <i>Who owes me the most?</i>\n\nSend your question now, or tap Back.",
    { reply_markup: BACK },
  );
}

export async function handleAICallback(data: string, _chatId: number, _user: BotUser): Promise<boolean> {
  if (!data.startsWith("ai:")) return false;
  return false;
}

export async function handleAIMessage(text: string, chatId: number, user: BotUser): Promise<boolean> {
  const session = await loadSession(user.telegram_id);
  if (session?.state !== "ai:awaiting_question") return false;

  await sendMessage(chatId, "🤖 <i>Thinking…</i>");
  try {
    const ctx = await gatherContext();
    const answer = await askAI(text, ctx);
    await logActivity({
      user_id: user.id,
      telegram_id: user.telegram_id,
      action: "ai_query",
      meta: { question: text.slice(0, 200) },
    });
    await sendMessage(chatId, `🤖 ${answer}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "❓ Ask another", callback_data: "menu:ai" }],
          [{ text: "⬅️ Back to Menu", callback_data: "menu:main" }],
        ],
      },
    });
  } catch (err) {
    await sendMessage(chatId, `⚠️ Error: ${(err as Error).message}`, { reply_markup: BACK });
  }
  await saveSession(user.telegram_id, { state: null, data: {} });
  return true;
}
