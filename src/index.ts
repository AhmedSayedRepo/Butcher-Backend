import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { prisma } from './lib/db'
import products from './routes/products'
import orders from './routes/orders'
import parseOrder from './routes/parseOrder'
import authRouter from './routes/auth'

const app = express()

app.use(helmet())
app.use(express.json({ limit: '1mb' }))
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*' }))

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
})

app.use('/auth', authRouter)
app.use('/api/products', products)
app.use('/api/orders', orders)
app.use('/api/parse-order', parseOrder)

const port = Number(process.env.PORT || 8080)
app.listen(port, () => {
  console.log(`Server listening on :${port}`)
})
