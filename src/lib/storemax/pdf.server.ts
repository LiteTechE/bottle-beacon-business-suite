// PDF generation + upload to Supabase Storage, returning a signed URL
// suitable for Telegram sendDocument.
import type { PDFFont, PDFPage } from "pdf-lib";
import { getServiceClient } from "./db.server";
import { getSettings } from "./settings.server";

interface Section {
  heading?: string;
  rows: string[][];
  columnWidths?: number[];
}

interface PdfDoc {
  title: string;
  subtitle?: string;
  sections: Section[];
  footer?: string;
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;

async function renderPdf(doc: PdfDoc): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensure = (needed: number) => {
    if (y - needed < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };
  const drawText = (
    p: PDFPage,
    text: string,
    x: number,
    yy: number,
    f: PDFFont,
    size: number,
    color = rgb(0.1, 0.1, 0.1),
  ) => {
    p.drawText(sanitize(text), { x, y: yy, size, font: f, color });
  };

  // Header
  drawText(page, doc.title, MARGIN, y, bold, 18);
  y -= 22;
  if (doc.subtitle) {
    drawText(page, doc.subtitle, MARGIN, y, font, 10, rgb(0.35, 0.35, 0.35));
    y -= 18;
  }
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });
  y -= 14;

  for (const section of doc.sections) {
    if (section.heading) {
      ensure(20);
      drawText(page, section.heading, MARGIN, y, bold, 12);
      y -= 16;
    }
    const cols = section.rows[0]?.length ?? 1;
    const widths = section.columnWidths ?? Array(cols).fill((PAGE_W - 2 * MARGIN) / cols);
    for (let r = 0; r < section.rows.length; r++) {
      ensure(16);
      const row = section.rows[r];
      let x = MARGIN;
      const rowFont = r === 0 ? bold : font;
      for (let c = 0; c < row.length; c++) {
        drawText(page, row[c] ?? "", x, y, rowFont, 9);
        x += widths[c] ?? 80;
      }
      y -= 13;
    }
    y -= 6;
  }

  if (doc.footer) {
    ensure(20);
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.5,
      color: rgb(0.8, 0.8, 0.8),
    });
    y -= 12;
    drawText(page, doc.footer, MARGIN, y, font, 8, rgb(0.4, 0.4, 0.4));
  }

  return await pdf.save();
}

function sanitize(s: string): string {
  // Helvetica is WinAnsi — strip non-encodable chars (₦, emoji, etc.)
  return s.replace(/[^\x20-\x7E]/g, (ch) => {
    if (ch === "₦") return "NGN ";
    return "";
  });
}

async function uploadAndSign(bytes: Uint8Array, name: string): Promise<string> {
  const db = getServiceClient();
  const path = `${new Date().toISOString().slice(0, 10)}/${name}`;
  const { error: upErr } = await db.storage.from("reports").upload(path, bytes, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (upErr) throw new Error(`PDF upload failed: ${upErr.message}`);
  const { data, error: sErr } = await db.storage.from("reports").createSignedUrl(path, 60 * 60 * 24);
  if (sErr || !data?.signedUrl) throw new Error(`Signed URL failed: ${sErr?.message}`);
  return data.signedUrl;
}

function fmt(n: number | string | null | undefined): string {
  return Number(n ?? 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface PeriodPdfOptions {
  sinceIso: string;
  untilIso?: string;
  label: string;
}

export async function buildSalesReportPdf(opts: PeriodPdfOptions): Promise<{ url: string; filename: string }> {
  const db = getServiceClient();
  const settings = await getSettings();
  const until = opts.untilIso ?? new Date().toISOString();

  const { data: sales } = await db
    .from("sales")
    .select("id,invoice_no,total,created_at,user_id,payments(method)")
    .gte("created_at", opts.sinceIso)
    .lte("created_at", until)
    .order("created_at", { ascending: false });
  const rows = sales ?? [];
  const methodOf = (x: any) => (Array.isArray(x.payments) && x.payments[0]?.method) || "cash";


  const ids = rows.map((r: any) => r.id);
  let cogs = 0;
  let itemMap = new Map<string, { name: string; qty: number; revenue: number }>();
  if (ids.length > 0) {
    const { data: items } = await db
      .from("sale_items")
      .select("product_id,quantity,cost_price,line_total,products(name)")
      .in("sale_id", ids);
    for (const it of items ?? []) {
      const i = it as any;
      cogs += Number(i.quantity) * Number(i.cost_price ?? 0);
      const key = String(i.product_id);
      const e = itemMap.get(key) ?? { name: i.products?.name ?? "Unknown", qty: 0, revenue: 0 };
      e.qty += Number(i.quantity);
      e.revenue += Number(i.line_total);
      itemMap.set(key, e);
    }
  }

  const { data: expenses } = await db
    .from("expenses")
    .select("category,amount,note,created_at")
    .gte("created_at", opts.sinceIso)
    .lte("created_at", until);

  const gross = rows.reduce((s: number, x: any) => s + Number(x.total), 0);
  const credit = rows.filter((x: any) => methodOf(x) === "credit").reduce((s: number, x: any) => s + Number(x.total), 0);
  const expTotal = (expenses ?? []).reduce((s: number, e: any) => s + Number(e.amount), 0);
  const profit = gross - cogs - expTotal;

  const top = [...itemMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  const bytes = await renderPdf({
    title: `${settings.business_name} — Sales Report`,
    subtitle: `${opts.label} • Generated ${new Date().toLocaleString("en-NG")}`,
    sections: [
      {
        heading: "Summary",
        columnWidths: [200, 200],
        rows: [
          ["Metric", "Value"],
          ["Transactions", String(rows.length)],
          ["Gross Sales", `NGN ${fmt(gross)}`],
          ["On Credit", `NGN ${fmt(credit)}`],
          ["Cost of Goods", `NGN ${fmt(cogs)}`],
          ["Expenses", `NGN ${fmt(expTotal)}`],
          ["Net Profit", `NGN ${fmt(profit)}`],
        ],
      },
      {
        heading: "Top Products",
        columnWidths: [260, 80, 120],
        rows:
          top.length === 0
            ? [["Product", "Qty", "Revenue"], ["(none)", "-", "-"]]
            : [["Product", "Qty", "Revenue"], ...top.map((p) => [p.name, String(p.qty), `NGN ${fmt(p.revenue)}`])],
      },
      {
        heading: `Transactions (${rows.length})`,
        columnWidths: [120, 140, 100, 120],
        rows: [
          ["Invoice", "Date", "Status", "Total"],
          ...rows.slice(0, 60).map((s: any) => [
            s.invoice_no,
            new Date(s.created_at).toLocaleString("en-NG"),
            methodOf(s),
            `NGN ${fmt(s.total)}`,
          ]),
        ],
      },
    ],
    footer: `${settings.business_name} • ${settings.business_address ?? ""} • ${settings.business_phone ?? ""}`,
  });

  const filename = `sales-${opts.label.replace(/\W+/g, "_")}-${Date.now()}.pdf`;
  const url = await uploadAndSign(bytes, filename);
  return { url, filename };
}

export async function buildDailySummaryPdf(dayIso?: string): Promise<{ url: string; filename: string }> {
  const db = getServiceClient();
  const settings = await getSettings();
  const start = new Date(dayIso ?? new Date());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const { data: sales } = await db
    .from("sales")
    .select("id,total,user_id,bot_users(full_name),payments(method)")
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString());
  const rows = (sales ?? []) as any[];

  const ids = rows.map((r) => r.id);
  let cogs = 0;
  const productMap = new Map<string, { name: string; qty: number; revenue: number }>();
  if (ids.length > 0) {
    const { data: items } = await db
      .from("sale_items")
      .select("product_id,quantity,cost_price,line_total,products(name)")
      .in("sale_id", ids);
    for (const it of items ?? []) {
      const i = it as any;
      cogs += Number(i.quantity) * Number(i.cost_price ?? 0);
      const k = String(i.product_id);
      const e = productMap.get(k) ?? { name: i.products?.name ?? "Unknown", qty: 0, revenue: 0 };
      e.qty += Number(i.quantity);
      e.revenue += Number(i.line_total);
      productMap.set(k, e);
    }
  }

  const { data: expenses } = await db
    .from("expenses")
    .select("category,amount")
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString());
  const expTotal = (expenses ?? []).reduce((s: number, e: any) => s + Number(e.amount), 0);

  const gross = rows.reduce((s, x) => s + Number(x.total), 0);
  const credit = rows.filter((x) => x.payment_status === "credit").reduce((s, x) => s + Number(x.total), 0);
  const profit = gross - cogs - expTotal;

  // Per-rep breakdown
  const repMap = new Map<string, { name: string; count: number; total: number }>();
  for (const s of rows) {
    const name = s.bot_users?.full_name ?? "Unknown";
    const e = repMap.get(s.user_id) ?? { name, count: 0, total: 0 };
    e.count += 1;
    e.total += Number(s.total);
    repMap.set(s.user_id, e);
  }

  const { data: lowStock } = await db
    .from("products")
    .select("name,stock,min_stock_level")
    .lte("stock", 100000); // fetch and filter below
  const low = (lowStock ?? []).filter((p: any) => Number(p.stock) <= Number(p.min_stock_level ?? 0));

  const { data: debtors } = await db
    .from("customers")
    .select("name,outstanding_balance")
    .gt("outstanding_balance", 0)
    .order("outstanding_balance", { ascending: false })
    .limit(10);

  const top = [...productMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const dateLabel = start.toLocaleDateString("en-NG", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const bytes = await renderPdf({
    title: `${settings.business_name} — Daily Summary`,
    subtitle: dateLabel,
    sections: [
      {
        heading: "Today at a Glance",
        columnWidths: [200, 200],
        rows: [
          ["Metric", "Value"],
          ["Transactions", String(rows.length)],
          ["Gross Sales", `NGN ${fmt(gross)}`],
          ["On Credit", `NGN ${fmt(credit)}`],
          ["Cost of Goods", `NGN ${fmt(cogs)}`],
          ["Expenses", `NGN ${fmt(expTotal)}`],
          ["Net Profit", `NGN ${fmt(profit)}`],
        ],
      },
      {
        heading: "Sales by Staff",
        columnWidths: [260, 80, 120],
        rows:
          repMap.size === 0
            ? [["Staff", "Sales", "Total"], ["(no sales)", "-", "-"]]
            : [
                ["Staff", "Sales", "Total"],
                ...[...repMap.values()].map((r) => [r.name, String(r.count), `NGN ${fmt(r.total)}`]),
              ],
      },
      {
        heading: "Top Products Today",
        columnWidths: [260, 80, 120],
        rows:
          top.length === 0
            ? [["Product", "Qty", "Revenue"], ["(none)", "-", "-"]]
            : [["Product", "Qty", "Revenue"], ...top.map((p) => [p.name, String(p.qty), `NGN ${fmt(p.revenue)}`])],
      },
      {
        heading: `Low Stock (${low.length})`,
        columnWidths: [320, 80, 80],
        rows:
          low.length === 0
            ? [["Product", "Stock", "Min"], ["(none)", "-", "-"]]
            : [
                ["Product", "Stock", "Min"],
                ...low.slice(0, 30).map((p: any) => [p.name, String(p.stock), String(p.min_stock_level)]),
              ],
      },
      {
        heading: `Top Debtors`,
        columnWidths: [320, 160],
        rows:
          !debtors || debtors.length === 0
            ? [["Customer", "Balance"], ["(none)", "-"]]
            : [
                ["Customer", "Balance"],
                ...debtors.map((c: any) => [c.name, `NGN ${fmt(c.outstanding_balance)}`]),
              ],
      },
    ],
    footer: `${settings.business_name} • ${settings.business_address ?? ""} • ${settings.business_phone ?? ""}`,
  });

  const filename = `daily-summary-${start.toISOString().slice(0, 10)}.pdf`;
  const url = await uploadAndSign(bytes, filename);
  return { url, filename };
}
