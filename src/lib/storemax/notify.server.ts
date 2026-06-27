import { getServiceClient } from "./db.server";
import { sendMessage } from "./telegram.server";

type NotificationKind =
  | "sale"
  | "low_stock"
  | "large_sale"
  | "refund"
  | "failed_login"
  | "daily_summary"
  | "system";

export async function getOwnerTelegramId(): Promise<number | null> {
  const db = getServiceClient();
  const { data } = await db.from("settings").select("value").eq("key", "owner_telegram_id").maybeSingle();
  const raw = data?.value;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

export async function notifyOwner(kind: NotificationKind, title: string, body?: string, meta: Record<string, unknown> = {}) {
  const db = getServiceClient();
  // Always persist the notification.
  const { data: row } = await db
    .from("notifications")
    .insert({ kind, title, body: body ?? null, meta })
    .select("id")
    .single();

  const ownerId = await getOwnerTelegramId();
  if (!ownerId) return row?.id;

  const text = `<b>${escapeHtml(title)}</b>${body ? `\n${escapeHtml(body)}` : ""}`;
  try {
    await sendMessage(ownerId, text);
    if (row?.id) await db.from("notifications").update({ delivered: true }).eq("id", row.id);
  } catch (err) {
    console.error("[storemax] owner notify failed", err);
  }
  return row?.id;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
