# Butcher Backend (Express + TypeScript + Prisma) — Railway Ready

## Quick Start
```bash
# 1) Install
npm install

# 2) Create .env from example (locally)
cp .env.example .env

# 3) Run database migrations (requires DATABASE_URL)
npx prisma migrate dev --name init

# 4) Seed (creates default admin and sample products)
npm run seed

# 5) Dev
npm run dev
```

The server starts on `http://localhost:${PORT:-8080}`.

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. On Railway → New Project → Deploy from GitHub.
3. Add **Plugin → PostgreSQL**.
4. Copy the connection string and set `DATABASE_URL` in **Variables**.
5. Add `JWT_SECRET`, `CORS_ORIGIN` (e.g. your Vercel domain), `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
6. Trigger a deploy. Railway exposes a public URL. Use that as `NEXT_PUBLIC_API_URL` in Vercel.

## API
- `GET /health`
- `POST /auth/login` — { email, password } → { token }
- `GET /api/products`
- `POST /api/products` (auth) — create product
- `GET /api/orders` (auth)
- `POST /api/orders` (auth) — create order, decrements inventory
- `POST /api/parse-order` — parse free text like "2 kg beef, 1.5 kg lamb"

All JSON. Auth via `Authorization: Bearer <token>`.
