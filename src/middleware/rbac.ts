import type { Response, NextFunction } from 'express'
import { prisma } from '../lib/db.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import type { AuthRequest } from './auth.js'
import { roleRank, effectiveCaps } from '../lib/caps.js'
import type { Cap, Role } from '../lib/caps.js'
import { apiError, ERROR_CODES } from '../lib/errorCodes.js'

// Deliberately re-fetches role/caps from the DB on every call rather than
// trusting the JWT's `role` claim already on `req.user`: the JWT can be
// valid for up to 7 days (see routes/auth.ts's COOKIE_MAX_AGE_DAYS), so a
// role/caps change wouldn't take effect until the token is reissued —
// matching qa-studio's own documented behavior for its plain role check
// ("takes effect the next time that user signs in"). That lag is
// acceptable for most of the app, but not for gates that specifically
// protect *changing who has admin access* — so those two functions below
// re-check the current DB state on every request instead.
async function loadCurrentUser(userId: string): Promise<{ role: string, caps: unknown } | null> {
  return await prisma.user.findUnique({ where: { id: userId }, select: { role: true, caps: true } })
}

export function requireRole(minRole: Role) {
  return function requireRoleMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
    if (req.user === undefined) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json(apiError(ERROR_CODES.UNAUTHORIZED, 'Unauthorized'))
      return
    }
    // This is already object destructuring; @typescript-eslint/prefer-destructuring
    // still flags it here (empirically confirmed against two consecutive real
    // `npm run lint` runs, not a config guess) — a known false-positive class for
    // this rule when the source is a narrowed optional property off an Express
    // Request subtype rather than a plain identifier. See the rule's own docs:
    // "you must disable the base rule as it can report incorrect errors."
    // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- already destructured; documented false-positive on narrowed optional Express Request properties
    const { id } = req.user
    loadCurrentUser(id)
      .then((current) => {
        if (current === null) {
          res.status(HTTP_STATUS.FORBIDDEN).json(apiError(ERROR_CODES.ROLE_REQUIRED, `Requires ${minRole} role or higher`, { role: minRole }))
          return
        }
        const { role } = current
        if (roleRank(role) < roleRank(minRole)) {
          res.status(HTTP_STATUS.FORBIDDEN).json(apiError(ERROR_CODES.ROLE_REQUIRED, `Requires ${minRole} role or higher`, { role: minRole }))
          return
        }
        next()
      })
      .catch(next)
  }
}

export function requireCap(cap: Cap) {
  return function requireCapMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
    if (req.user === undefined) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json(apiError(ERROR_CODES.UNAUTHORIZED, 'Unauthorized'))
      return
    }
    // This is already object destructuring; @typescript-eslint/prefer-destructuring
    // still flags it here (empirically confirmed against two consecutive real
    // `npm run lint` runs, not a config guess) — a known false-positive class for
    // this rule when the source is a narrowed optional property off an Express
    // Request subtype rather than a plain identifier. See the rule's own docs:
    // "you must disable the base rule as it can report incorrect errors."
    // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- already destructured; documented false-positive on narrowed optional Express Request properties
    const { id } = req.user
    loadCurrentUser(id)
      .then((current) => {
        if (current === null) {
          res.status(HTTP_STATUS.FORBIDDEN).json(apiError(ERROR_CODES.CAP_REQUIRED, `Requires capability: ${cap}`, { cap }))
          return
        }
        const { role, caps } = current
        if (!effectiveCaps(role, caps).includes(cap)) {
          res.status(HTTP_STATUS.FORBIDDEN).json(apiError(ERROR_CODES.CAP_REQUIRED, `Requires capability: ${cap}`, { cap }))
          return
        }
        next()
      })
      .catch(next)
  }
}
