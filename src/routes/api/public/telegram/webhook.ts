import { createFileRoute } from "@tanstack/react-router";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const telegramKey = process.env.TELEGRAM_API_KEY;
        if (!telegramKey) {
          return new Response("Server not configured", { status: 500 });
        }

        const { deriveWebhookSecret } = await import("@/lib/storemax/telegram.server");
        const expected = await deriveWebhookSecret();
        const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!timingSafeEqual(provided, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let update: unknown;
        try {
          update = await request.json();
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }

        try {
          const { handleUpdate } = await import("@/lib/storemax/bot.server");
          await handleUpdate(update as never);
        } catch (err) {
          console.error("[storemax] update handler failed", err);
          // Always 200 so Telegram doesn't retry-storm.
        }

        return Response.json({ ok: true });
      },
    },
  },
});
