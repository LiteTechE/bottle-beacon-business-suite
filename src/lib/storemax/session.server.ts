import { getServiceClient } from "./db.server";

export interface BotSession {
  telegram_id: number;
  user_id: string | null;
  authenticated: boolean;
  state: string | null;
  data: Record<string, unknown>;
  expires_at: string | null;
}

const SESSION_TTL_MINUTES = 60;

export async function loadSession(telegramId: number): Promise<BotSession | null> {
  const db = getServiceClient();
  const { data } = await db.from("bot_sessions").select("*").eq("telegram_id", telegramId).maybeSingle();
  if (!data) return null;
  // Expire stale sessions.
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    await db.from("bot_sessions").update({ authenticated: false, state: null, data: {} }).eq("telegram_id", telegramId);
    return { ...data, authenticated: false, state: null, data: {} } as BotSession;
  }
  return data as BotSession;
}

export async function saveSession(
  telegramId: number,
  patch: Partial<Omit<BotSession, "telegram_id">>,
): Promise<void> {
  const db = getServiceClient();
  const expires = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000).toISOString();
  const payload: Record<string, unknown> = { telegram_id: telegramId, expires_at: expires, ...patch };
  await db.from("bot_sessions").upsert(payload, { onConflict: "telegram_id" });
}

export async function clearSession(telegramId: number): Promise<void> {
  const db = getServiceClient();
  await db
    .from("bot_sessions")
    .upsert(
      { telegram_id: telegramId, authenticated: false, state: null, data: {}, user_id: null },
      { onConflict: "telegram_id" },
    );
}
