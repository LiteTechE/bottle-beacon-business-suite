import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "STOREMAX POS — Telegram-powered Point of Sale" },
      {
        name: "description",
        content:
          "Enterprise Telegram-based POS and inventory management for STOREMAX LIMITED. Wine, spirits, soft drinks and beverage distribution.",
      },
      { property: "og:title", content: "STOREMAX POS" },
      { property: "og:description", content: "Telegram-powered Point of Sale and Inventory Management." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-muted-foreground">STOREMAX LIMITED</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">STOREMAX POS</h1>
        <p className="mt-4 text-lg text-muted-foreground">
          A Telegram-native point-of-sale and inventory platform for wine, spirits, soft drinks, water and beverage
          distribution.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <Card title="Owner console" body="Live sales, inventory, staff, suppliers, expenses, reports and an AI assistant." />
          <Card title="Sales reps" body="PIN-protected login, fast checkout, receipts and personal sales history." />
          <Card title="Real-time alerts" body="Instant owner notifications for every sale, low stock and failed login attempt." />
          <Card title="Hardened backend" body="Role-based access, audit logs, encrypted PINs and a normalized Postgres schema." />
        </div>

        <div className="mt-10 rounded-lg border border-border bg-card p-6">
          <h2 className="text-base font-semibold">Status</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Foundation module live: database schema, Telegram webhook, PIN authentication, role-based menus and owner
            notifications. Sales and inventory modules ship next.
          </p>
        </div>
      </section>
    </main>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
