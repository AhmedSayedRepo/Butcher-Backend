import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/db'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { requireEnv } from '../middleware/auth'
import { asyncHandler } from '../lib/asyncHandler'
import { HTTP_STATUS } from '../lib/httpStatus'

const router = Router()

const MIN_FIELD_LENGTH = 1

const LoginSchema = z.object({
  email: z.string().min(MIN_FIELD_LENGTH),
  password: z.string().min(MIN_FIELD_LENGTH)
})

router.post('/login', asyncHandler(async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'email and password required' })
    return
  }
  const { data } = parsed
  const { email, password } = data

  const user = await prisma.user.findUnique({ where: { email } })
  if (user === null) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid credentials' })
    return
  }

  const ok = await bcrypt.compare(password, user.password)
  if (!ok) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid credentials' })
    return
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, requireEnv('JWT_SECRET'), { expiresIn: '7d' })
  res.json({ token })
}))

export default router
