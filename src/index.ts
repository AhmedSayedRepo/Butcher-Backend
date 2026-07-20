import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import helmet from 'helmet'
import { prisma } from './lib/db.js'
import products from './routes/products.js'
import orders from './routes/orders.js'
import parseOrder from './routes/parseOrder.js'
import authRouter from './routes/auth.js'
import usersRouter from './routes/users.js'
import dismantleTemplatesRouter from './routes/dismantleTemplates.js'
import dismantleEventsRouter from './routes/dismantleEvents.js'
import { asyncHandler } from './lib/asyncHandler.js'
import { HTTP_STATUS } from './lib/httpStatus.js'
import { getErrorMessage } from './lib/errors.js'

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
app.use(express.json({ limit: '1mb' }))
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
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') ?? true,
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
app.use('/api/parse-order', parseOrder)
app.use('/api/users', usersRouter)
app.use('/api/dismantle-templates', dismantleTemplatesRouter)
app.use('/api/dismantle-events', dismantleEventsRouter)

// Centralized error handler: asyncHandler forwards unexpected failures here
// via `next(err)` instead of leaving them as unhandled promise rejections.
// Express identifies error-handling middleware by its 4-argument signature
// — the unused params must stay positional even though only err/res are read.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: getErrorMessage(err) })
})

const port = Number(process.env.PORT ?? DEFAULT_PORT)
app.listen(port, () => {
  process.stdout.write(`Server listening on :${port}\n`)
})
