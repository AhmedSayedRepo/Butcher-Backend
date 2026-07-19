import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { prisma } from './lib/db'
import products from './routes/products'
import orders from './routes/orders'
import parseOrder from './routes/parseOrder'
import authRouter from './routes/auth'
import { asyncHandler } from './lib/asyncHandler'
import { HTTP_STATUS } from './lib/httpStatus'
import { getErrorMessage } from './lib/errors'

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
app.use(express.json({ limit: '1mb' }))
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' }))

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
