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
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const [{ data: salesToday }, { data: salesMonth }, { data: lowStock }, { data: debtors }, { data: topProductsRaw }, { data: expenses }] = await Promise.all([
    db.from("sales").select("total").gte("created_at", today.toISOString()),
    db.from("sales").select("total").gte("created_at", monthStart.toISOString()),
    db.from("products").select("name,current_stock,min_stock_level").lte("current_stock", 5).eq("archived", false).limit(20),
    db.from("customers").select("name,outstanding_balance").gt("outstanding_balance", 0).order("outstanding_balance", { ascending: false }).limit(10),
    db.from("sale_items").select("quantity,line_total,products(name)").limit(500),
    db.from("expenses").select("category,amount").gte("created_at", monthStart.toISOString()),
  ]);

  const todayGross = (salesToday ?? []).reduce((s: number, x: any) => s + Number(x.total), 0);
  const todayCount = (salesToday ?? []).length;
  const monthGross = (salesMonth ?? []).reduce((s: number, x: any) => s + Number(x.total), 0);

  const productMap = new Map<string, { qty: number; revenue: number }>();
  for (const it of topProductsRaw ?? []) {
    const key = (it as any).products?.name ?? "Unknown";
    const e = productMap.get(key) ?? { qty: 0, revenue: 0 };
    e.qty += Number((it as any).quantity);
    e.revenue += Number((it as any).line_total);
    productMap.set(key, e);
  }
  const top = [...productMap.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);

  const expByCat = new Map<string, number>();
  for (const e of expenses ?? []) {
    expByCat.set((e as any).category, (expByCat.get((e as any).category) ?? 0) + Number((e as any).amount));
  }

  return [
    `Business: STOREMAX LIMITED (Beverage Distribution, Nigeria, currency ₦)`,
    `Today: ${todayCount} sales, gross ₦${fmtMoney(todayGross)}`,
    `This month gross: ₦${fmtMoney(monthGross)}`,
    `Low stock (≤5): ${(lowStock ?? []).map((p: any) => `${p.name} (${p.current_stock})`).join(", ") || "none"}`,
    `Top debtors: ${(debtors ?? []).map((d: any) => `${d.name} ₦${fmtMoney(d.outstanding_balance)}`).join(", ") || "none"}`,
    `Top products (recent): ${top.map(([n, v]) => `${n} ${v.qty}u ₦${fmtMoney(v.revenue)}`).join(", ") || "none"}`,
    `Month expenses by category: ${[...expByCat.entries()].map(([c, v]) => `${c} ₦${fmtMoney(v)}`).join(", ") || "none"}`,
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
