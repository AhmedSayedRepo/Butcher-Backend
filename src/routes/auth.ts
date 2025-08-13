import { Router } from 'express'
import { prisma } from '../lib/db'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { requireEnv } from '../middleware/auth'

const router = Router()

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'email and password required' })

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return res.status(401).json({ error: 'Invalid credentials' })

  const ok = await bcrypt.compare(password, user.password)
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' })

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, requireEnv('JWT_SECRET'), { expiresIn: '7d' })
  res.json({ token })
})

export default router
