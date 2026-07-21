import 'dotenv/config'
import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import helmet from 'helmet'
import { prisma } from './lib/db.js'
import { apiError, ERROR_CODES } from './lib/errorCodes.js'
import { buildOriginChecker } from './lib/corsOrigin.js'
import products from './routes/products.js'
import orders from './routes/orders.js'
import orderReceiptScan from './routes/orderReceiptScan.js'
import orderDrafts from './routes/orderDrafts.js'
import parseOrder from './routes/parseOrder.js'
import authRouter from './routes/auth.js'
import usersRouter from './routes/users.js'
import organizationsRouter from './routes/organizations.js'
import dismantleTemplatesRouter from './routes/dismantleTemplates.js'
import dismantleEventsRouter from './routes/dismantleEvents.js'
import whatsappWebhookRouter from './routes/whatsappWebhook.js'
import customersRouter from './routes/customers.js'
import cashTransactionsRouter from './routes/cashTransactions.js'
import shopSettingsRouter from './routes/shopSettings.js'
import { asyncHandler } from './lib/asyncHandler.js'
import { HTTP_STATUS } from './lib/httpStatus.js'
import { getErrorMessage } from './lib/errors.js'

// v3.1 follow-up 12: Node 17+ changed dns.lookup()'s default result order
// from "always IPv4 first" (verbatim: false) to "whatever the resolver
// returned" (verbatim: true) — usually IPv6 first on a dual-stack DNS
// answer. That's harmless on a host with real IPv6 egress, but Render
// (like many PaaS/container platforms) only routes outbound traffic over
// IPv4, so any outbound connection to a dual-stack host — Gmail's SMTP
// servers, the WhatsApp/webhook APIs, etc. — fails immediately with
// ENETUNREACH on the IPv6 address before ever trying IPv4. This is the
// confirmed cause of admin-invite emails silently failing to send (log:
// "sendEmail failed: connect ENETUNREACH 2607:f8b0:...") — not bad
// credentials. Restoring IPv4-first resolution here, once, at boot, fixes
// this for every outbound connection the process makes, not just email.
dns.setDefaultResultOrder('ipv4first')

const DEFAULT_PORT = 8080

const app = express()

// Read once at boot. release.bat/push.ps1 write this file and rely on
// /health echoing it back so a release can be verified as actually live,
// not just "git push succeeded" (see ../release.bat header comment).
const VERSION = (() => {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'VERSION'), 'utf8').trim()
  } catch {
    return 'unknown'
  }
})()

app.use(helmet())
// Phase 5 hardening: no request logging existed at all before this — the
// only visibility into traffic was whatever a route handler happened to log
// itself. `morgan`'s default stream is `process.stdout.write` already (not
// `console.log`), which is why the `no-console` rule elsewhere in this
// codebase doesn't apply here — no extra stream plumbing needed.
app.use(morgan('combined'))
// Phase I.2 (WhatsApp order intake): `verify` stashes the exact raw request
// bytes on the request object before body-parser turns them into `req.body`.
// The WhatsApp inbound webhook needs those raw bytes (not the re-serialized
// JSON, which can differ in whitespace/key order) to check Meta's
// `X-Hub-Signature-256` HMAC — see lib/whatsapp.ts. `Object.assign` is used
// rather than a direct property write per this codebase's existing
// no-param-reassign convention (see middleware/auth.ts).
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    Object.assign(req, { rawBody: buf })
  }
}))
app.use(cookieParser())
// Tech debt (ADR-002), now resolved: auth moved from a bearer token the
// frontend stored in localStorage to an httpOnly cookie (see
// middleware/auth.ts). Cookies require `credentials: true` here, and — per
// the Fetch/CORS spec — an `origin` of '*' is rejected by browsers whenever
// credentials are involved, so the old `?? '*'` fallback would silently break
// login in any deployment that forgot to set CORS_ORIGIN. `true` makes the
// `cors` package reflect the request's own Origin header instead, which is
// safe for a single-tenant internal tool and still requires an explicit,
// same-shape Origin from the browser (not a literal wildcard).
// Multi-tenancy phase 3: `CORS_ORIGIN` (exact hosts) still works and is what
// the current single-host deployment uses; `CORS_WILDCARD_DOMAIN` adds
// `https://<shop>.<domain>` without needing an entry per customer. See
// lib/corsOrigin.ts for why that's an anchored pattern rather than a
// `.endsWith()` check.
app.use(cors({
  origin: buildOriginChecker(),
  credentials: true
}))

app.get('/health', asyncHandler(async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ ok: true, version: VERSION })
  } catch (e) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ ok: false, version: VERSION, error: getErrorMessage(e) })
  }
}))

app.use('/auth', authRouter)
app.use('/api/products', products)
app.use('/api/orders', orders)
// v3.1 follow-up 6: split out of routes/orders.ts to stay under max-lines —
// same '/api/orders' prefix, Express supports multiple routers on one path.
app.use('/api/orders', orderReceiptScan)
// v3.1 follow-up 7: editable/deletable drafts — same prefix again.
app.use('/api/orders', orderDrafts)
app.use('/api/parse-order', parseOrder)
app.use('/api/users', usersRouter)
app.use('/api/organizations', organizationsRouter)
app.use('/api/dismantle-templates', dismantleTemplatesRouter)
app.use('/api/dismantle-events', dismantleEventsRouter)
// v3 replan: Phase H (CRM), Phase K (cash management), Phase J (shop-wide
// alert settings) — see Butcher-Project-Plan-v3.md and ADRs.md ADR-008/013.
app.use('/api/customers', customersRouter)
app.use('/api/cash-transactions', cashTransactionsRouter)
app.use('/api/shop-settings', shopSettingsRouter)
// Phase I.2: public (no `auth` middleware) — Meta itself is the caller, and
// the GET handshake / POST signature check inside this router are what
// stand in for auth here (see routes/whatsappWebhook.ts).
app.use('/webhooks/whatsapp', whatsappWebhookRouter)

// Centralized error handler: asyncHandler forwards unexpected failures here
// via `next(err)` instead of leaving them as unhandled promise rejections.
// Express identifies error-handling middleware by its 4-argument signature
// — the unused params must stay positional even though only err/res are read.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(apiError(ERROR_CODES.SERVER_ERROR, getErrorMessage(err)))
})

const port = Number(process.env.PORT ?? DEFAULT_PORT)
app.listen(port, () => {
  process.stdout.write(`Server listening on :${port}\n`)
})
