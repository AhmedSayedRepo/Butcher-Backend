import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

export interface AuthRequest extends Request {
  user?: { id: string, email: string, role: string }
}

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

export function auth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const payload = jwt.verify(token, requireEnv('JWT_SECRET')) as any
    req.user = { id: payload.id, email: payload.email, role: payload.role }
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid token' })
  }
}
