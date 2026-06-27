import { getServiceClient } from "./db.server";

export interface LogEntry {
  user_id?: string | null;
  telegram_id?: number | null;
  action: string;
  entity?: string;
  entity_id?: string;
  meta?: Record<string, unknown>;
}

export async function logActivity(entry: LogEntry): Promise<void> {
  try {
    const db = getServiceClient();
    await db.from("activity_logs").insert({
      user_id: entry.user_id ?? null,
      telegram_id: entry.telegram_id ?? null,
      action: entry.action,
      entity: entry.entity ?? null,
      entity_id: entry.entity_id ?? null,
      meta: entry.meta ?? {},
    });
  } catch (err) {
    // Logging must never throw into the bot flow.
    console.error("[storemax] activity log failed", err);
  }
}
