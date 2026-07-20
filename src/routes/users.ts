import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireRole } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { ROLES, CAPS } from '../lib/caps.js'
import type { Role } from '../lib/caps.js'

const router = Router()

// v2 replan, Phase D — admin-only user management, modeled on qa-studio's
// role-plus-capability-toggle admin screen (see ADMIN_USERS_SETUP.md /
// users_screen.py in qa-studio, and ADR-005 in Butcher-Project-Plan-v2.md).
// Every route below is gated by requireRole('admin'), which re-checks the
// DB on each request rather than trusting the JWT's role claim — see the
// comment in middleware/rbac.ts for why that matters specifically here.
router.use(auth, requireRole('admin'))

router.get('/', asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, caps: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: 'asc' }
  })
  res.json(users)
}))

const UpdateUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  caps: z.array(z.enum(CAPS)).optional(),
  // Required to actually go through when an admin demotes THEIR OWN account
  // away from admin — see the self-demotion guard below. Omitted/false on
  // the first attempt returns a `confirmation_required` response instead of
  // applying the change, so the frontend can show a confirm dialog before
  // resubmitting with this set to true.
  confirm: z.boolean().optional()
})

// Pulled out of the route handler so the multi-condition boolean expression
// (and the branching it implies) doesn't count against the handler's own
// cyclomatic complexity — see the self-demotion guard comment above.
function isSelfDemotion(callerId: string, target: { id: string, role: string }, nextRole: Role | undefined): boolean {
  const isSelf = callerId === target.id
  const isDemotingFromAdmin = target.role === 'admin' && nextRole !== undefined && nextRole !== 'admin'
  return isSelf && isDemotingFromAdmin
}

router.patch('/:id', asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  // Already object destructuring in all three cases below; see the comment
  // in middleware/rbac.ts for why @typescript-eslint/prefer-destructuring
  // still flags these (confirmed false positive across repeated real lint
  // runs, not a config guess).
  // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- already destructured; documented false-positive on narrowed optional Express Request properties
  const { id: callerId } = req.user

  // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- already destructured; documented false-positive on narrowed optional Express Request properties
  const { id } = req.params
  const parsed = UpdateUserSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- already destructured; documented false-positive on narrowed optional Express Request properties
  const { role, caps, confirm } = parsed.data

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } })
  if (target === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'User not found' })
    return
  }

  if (isSelfDemotion(callerId, target, role) && confirm !== true) {
    res.status(HTTP_STATUS.CONFLICT).json({
      error: 'confirmation_required',
      message: 'This removes your own admin access. Resubmit with confirm: true to proceed.'
    })
    return
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(role === undefined ? {} : { role }),
      ...(caps === undefined ? {} : { caps })
    },
    select: { id: true, email: true, role: true, caps: true, createdAt: true, updatedAt: true }
  })
  res.json(updated)
}))

export default router
