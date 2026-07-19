import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { HTTP_STATUS } from '../lib/httpStatus'

const BEARER_PREFIX = 'Bearer '

export interface AuthRequest extends Request {
  user?: { id: string, email: string, role: string }
}

interface AuthTokenPayload {
  id: string
  email: string
  role: string
}

function isAuthTokenPayload(payload: unknown): payload is AuthTokenPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'id' in payload &&
    'email' in payload &&
    'role' in payload &&
    typeof payload.id === 'string' &&
    typeof payload.email === 'string' &&
    typeof payload.role === 'string'
  )
}

export function requireEnv(name: string): string {
  const { env } = process
  const { [name]: v } = env
  if (v === undefined || v === '') throw new Error(`Missing env var: ${name}`)
  return v
}

export function auth(req: AuthRequest, res: Response, next: NextFunction): void {
  const { headers } = req
  const { authorization } = headers
  const header = authorization ?? ''
  const token = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : null
  if (token === null) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }

  try {
    const decoded: unknown = jwt.verify(token, requireEnv('JWT_SECRET'))
    if (!isAuthTokenPayload(decoded)) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid token' })
      return
    }
    Object.assign(req, { user: { id: decoded.id, email: decoded.email, role: decoded.role } })
    next()
  } catch {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid token' })
  }
}
