// PDF generation + upload to private storage, returning a signed URL
// suitable for Telegram sendDocument.
//
// Keep this module dependency-free. Some PDF libraries pull CommonJS helpers
// that fail in the serverless runtime, causing errors like:
// "Cannot destructure property 'extends' of 'toESM(...).default'...".
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
const CONTENT_W = PAGE_W - MARGIN * 2;

function enc(s: string): string {
  return String(s ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/₦/g, "NGN ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapText(text: string, maxChars: number): string[] {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else if (word.length > maxChars) {
      if (line) lines.push(line);
      for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
      line = "";
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function renderPdf(doc: PdfDoc): Uint8Array {
  type Op = string;
  const pages: Op[][] = [];
  let ops: Op[] = [];
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    pages.push(ops);
    ops = [];
    y = PAGE_H - MARGIN;
  };
  const ensure = (needed: number) => {
    if (y - needed < MARGIN) newPage();
  };
  const text = (value: string, x: number, yy: number, size = 9, font = "F1") => {
    ops.push(`BT /${font} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${enc(value)}) Tj ET`);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, shade = "0.75") => {
    ops.push(`${shade} G 0.5 w ${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S 0 G`);
  };

  text(doc.title, MARGIN, y, 18, "F2");
  y -= 23;
  if (doc.subtitle) {
    text(doc.subtitle, MARGIN, y, 10, "F1");
    y -= 18;
  }
  line(MARGIN, y, PAGE_W - MARGIN, y);
  y -= 16;

  for (const section of doc.sections) {
    if (section.heading) {
      ensure(24);
      text(section.heading, MARGIN, y, 12, "F2");
      y -= 17;
    }
    const cols = section.rows[0]?.length ?? 1;
    const widths = section.columnWidths ?? Array(cols).fill(CONTENT_W / cols);
    for (let r = 0; r < section.rows.length; r++) {
      const row = section.rows[r] ?? [];
      const wrapped = row.map((cell, c) => wrapText(cell, Math.max(8, Math.floor((widths[c] ?? 80) / 5.2))));
      const height = Math.max(...wrapped.map((v) => v.length)) * 11 + 4;
      ensure(height + 4);
      if (r === 0) line(MARGIN, y + 4, PAGE_W - MARGIN, y + 4, "0.65");
      let x = MARGIN;
      for (let c = 0; c < row.length; c++) {
        const f = r === 0 ? "F2" : "F1";
        wrapped[c].slice(0, 4).forEach((part, i) => text(part, x, y - i * 11, 9, f));
        x += widths[c] ?? 80;
      }
      y -= height;
      if (r === 0) line(MARGIN, y + 4, PAGE_W - MARGIN, y + 4, "0.85");
    }
    y -= 8;
  }

  if (doc.footer) {
    ensure(24);
    line(MARGIN, y, PAGE_W - MARGIN, y, "0.85");
    y -= 13;
    text(doc.footer, MARGIN, y, 8, "F1");
  }
  pages.push(ops);

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add("<< /Type /Catalog /Pages 2 0 R >>");
  void catalogId;
  objects.push(""); // pages object placeholder, object 2
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const boldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageIds: number[] = [];

  for (const pageOps of pages) {
    const stream = pageOps.join("\n");
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
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

  const { data: sales, error: salesErr } = await db
    .from("sales")
    .select("id,invoice_no,total,created_at,user_id,payments(method)")
    .gte("created_at", opts.sinceIso)
    .lte("created_at", until)
    .order("created_at", { ascending: false });
  if (salesErr) throw new Error(`Sales query failed: ${salesErr.message}`);
  const rows = sales ?? [];
  const methodOf = (x: any) => (Array.isArray(x.payments) && x.payments[0]?.method) || "cash";

  const ids = rows.map((r: any) => r.id);
  let cogs = 0;
  const itemMap = new Map<string, { name: string; qty: number; revenue: number }>();
  if (ids.length > 0) {
    const { data: items } = await db
      .from("sale_items")
      .select("product_id,quantity,cost_price,line_total,sale_unit,products(name)")
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

  const bytes = renderPdf({
    title: `${settings.business_name} - Sales Report`,
    subtitle: `${opts.label} | Generated ${new Date().toLocaleString("en-NG")}`,
    sections: [
      {
        heading: "Summary",
        columnWidths: [220, 180],
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
          ["Invoice", "Date", "Method", "Total"],
          ...rows.slice(0, 80).map((s: any) => [
            s.invoice_no,
            new Date(s.created_at).toLocaleString("en-NG"),
            methodOf(s),
            `NGN ${fmt(s.total)}`,
          ]),
        ],
      },
    ],
    footer: `${settings.business_name} | ${settings.business_address ?? ""} | ${settings.business_phone ?? ""}`,
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

  const { data: sales, error: salesErr } = await db
    .from("sales")
    .select("id,total,user_id,bot_users(full_name),payments(method)")
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString());
  if (salesErr) throw new Error(`Daily sales query failed: ${salesErr.message}`);
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
  const credit = rows.filter((x: any) => (Array.isArray(x.payments) && x.payments[0]?.method) === "credit").reduce((s: number, x: any) => s + Number(x.total), 0);
  const profit = gross - cogs - expTotal;

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
    .select("name,current_stock,min_stock,stock_packs,stock_bottles,pack_size")
    .eq("archived", false)
    .order("current_stock", { ascending: true })
    .limit(100);
  const low = (lowStock ?? []).filter((p: any) => Number(p.current_stock) <= Number(p.min_stock ?? 0));

  const { data: debtors } = await db
    .from("customers")
    .select("name,outstanding_balance")
    .gt("outstanding_balance", 0)
    .order("outstanding_balance", { ascending: false })
    .limit(10);

  const top = [...productMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const dateLabel = start.toLocaleDateString("en-NG", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const bytes = renderPdf({
    title: `${settings.business_name} - Daily Summary`,
    subtitle: dateLabel,
    sections: [
      {
        heading: "Today at a Glance",
        columnWidths: [220, 180],
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
            : [["Staff", "Sales", "Total"], ...[...repMap.values()].map((r) => [r.name, String(r.count), `NGN ${fmt(r.total)}`])],
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
        columnWidths: [260, 120, 80],
        rows:
          low.length === 0
            ? [["Product", "Stock", "Min"], ["(none)", "-", "-"]]
            : [
                ["Product", "Stock", "Min"],
                ...low.slice(0, 30).map((p: any) => [p.name, `${p.stock_packs ?? 0} packs + ${p.stock_bottles ?? 0} bottles`, String(p.min_stock)]),
              ],
      },
      {
        heading: "Top Debtors",
        columnWidths: [320, 160],
        rows:
          !debtors || debtors.length === 0
            ? [["Customer", "Balance"], ["(none)", "-"]]
            : [["Customer", "Balance"], ...debtors.map((c: any) => [c.name, `NGN ${fmt(c.outstanding_balance)}`])],
      },
    ],
    footer: `${settings.business_name} | ${settings.business_address ?? ""} | ${settings.business_phone ?? ""}`,
  });

  const filename = `daily-summary-${start.toISOString().slice(0, 10)}.pdf`;
  const url = await uploadAndSign(bytes, filename);
  return { url, filename };
}