# My Cardamom Estate — Backend

Node.js + Express + MongoDB API for the My Cardamom Estate Flutter app.

## Stack

- Node.js 20+ (ESM modules)
- Express 4
- MongoDB via Mongoose 8
- JWT auth (phone OTP via WhatsApp Business API, SMS fallback)
- Razorpay for subscriptions
- Zod for validation

## Setup

```sh
cd backend
cp .env.example .env       # fill in values
npm install
npm run dev                # nodemon, reloads on file change
```

The server listens on `http://localhost:4000` by default.

## Folder layout

```
backend/
├── src/
│   ├── app.js              # Express app factory (no listen)
│   ├── server.js           # bootstrap — db + listen
│   ├── config/
│   │   ├── env.js          # validated environment vars
│   │   └── db.js           # Mongoose connection
│   ├── middleware/
│   │   └── error.js        # 404 + central error handler
│   ├── models/             # Mongoose schemas (per entity)
│   ├── routes/             # Express routers
│   ├── controllers/        # request handlers (thin)
│   ├── services/           # business logic (incl. wage engine)
│   └── utils/
│       └── money.js        # paise <-> rupees, Indian formatting
└── tests/
```

## Conventions

- **Money is paise.** All amounts stored and passed around as integer paise.
  Convert to rupees only at display boundaries via `src/utils/money.js`.
  This rule is non-negotiable — see the developer brief §7.6.
- **Server-only wage calc.** The Flutter app never recalculates wages from
  raw values; it always reads `payroll_weeks` rows produced by the server.
- **Ownership checks on every request.** Each user can only read/write rows
  scoped to a plantation they own. Implemented as middleware (replaces
  Supabase RLS from the brief).
- **All times are IST** (`Asia/Kolkata`) regardless of client timezone.

## Health check

```sh
curl http://localhost:4000/api/v1/health
```

## What's next

MVP modules to build out (in order):

1. Auth — `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/refresh`
2. Plantations + plots + workers CRUD
3. Wage periods (seed the 5 historical CGA circulars)
4. Attendance + `calculateWeeklyPayroll(workerId, weekStart)` service
5. Fertilizer schedule + inventory + stock purchases
6. Year-end settlement + gratuity tracker + bonus rules
7. Razorpay subscription webhooks
8. Push notifications

The wage engine spec (the most consequential feature) lives in the brief §7.
Canonical test case: 18-yr tenure worker, 2026-04-15, spraying flag →
**₹578.31 (57831 paise).** All wage tests must verify this exactly.
