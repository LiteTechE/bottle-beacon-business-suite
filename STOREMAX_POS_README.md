# STOREMAX POS — Foundation Module

Telegram-native Point of Sale and Inventory Management for **STOREMAX LIMITED** (wine, spirits, soft drinks, water and beverage distribution).

This is the **foundation** module. Subsequent modules will add product CRUD, sales flow, payments/receipts, expenses, reports, AI assistant and backups.

## What's in this module

- **Database schema** (Lovable Cloud / Postgres): `bot_users`, `bot_sessions`, `categories`, `suppliers`, `customers`, `products`, `stock_movements`, `sales`, `sale_items`, `payments`, `expenses`, `activity_logs`, `notifications`, `settings`. All service-role only.
- **Telegram webhook** at `POST /api/public/telegram/webhook`, verified via `X-Telegram-Bot-Api-Secret-Token` (HMAC-style secret derived from the connector key).
- **PIN authentication** using PBKDF2-SHA256 with 120k iterations, per-user salt and timing-safe comparison.
- **Role-based access control**: first user becomes the **Owner**; subsequent users are **Sales Reps** awaiting owner approval.
- **Failed-login lockout** (5 attempts → 15-minute lock) with owner notification.
- **Audit log** of every message and authentication event.
- **Owner notifications** persisted to `notifications` and pushed to the owner's Telegram chat.
- **Inline-keyboard role-aware main menus** (Owner vs Sales Rep).

## Getting started

1. Open the bot you created in BotFather and send `/start`. The first user becomes the system **Owner**.
2. Set a 4–8 digit PIN when prompted.
3. From now on, every `/start` will require the PIN.
4. Additional users who message the bot are created as **Sales Reps** marked inactive — the owner will activate them in the upcoming Staff module.

## How the webhook is registered

The webhook is registered with Telegram via the Lovable connector gateway. The secret token is derived deterministically from `TELEGRAM_API_KEY` so the bot and webhook always agree.

## Files

```
src/lib/storemax/
  ├─ db.server.ts          # service-role Supabase client
  ├─ pin.server.ts         # PBKDF2 PIN hashing/verification
  ├─ session.server.ts     # FSM-style session store
  ├─ logger.server.ts      # activity log writer
  ├─ notify.server.ts      # owner notification helper
  ├─ telegram.server.ts    # Telegram API client (via connector gateway)
  └─ bot.server.ts         # update dispatcher (commands, callbacks, PIN flow)
src/routes/api/public/telegram/webhook.ts   # webhook endpoint
```

## What's next

- Products module (CRUD, search, archive, low-stock alerts)
- Inventory operations (receive, adjust, transfer, damage, returns)
- Sales flow (cart, discount, tax, multi-payment, receipt + QR)
- Customers & suppliers management
- Expenses + profit calculation
- Reports (daily/weekly/monthly/yearly, by payment method)
- AI assistant (natural-language Q&A over the business data)
- Backup / restore
