import crypto from 'node:crypto'
import { PasswordResetTokenPurpose } from '@prisma/client'
import type { PasswordResetToken, User } from '@prisma/client'
import { prisma } from './db.js'

// v3 follow-up: shared by the admin-invite ("set your password") and
// self-service "forgot password" flows — see the schema comment on
// PasswordResetToken for why one model/helper covers both.
const TOKEN_BYTES = 32
const INVITE_EXPIRY_DAYS = 7
const RESET_EXPIRY_HOURS = 1
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const MS_PER_HOUR = MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR

export async function createPasswordResetToken(userId: string, purpose: PasswordResetTokenPurpose): Promise<string> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex')
  const hours = purpose === PasswordResetTokenPurpose.INVITE ? INVITE_EXPIRY_DAYS * HOURS_PER_DAY : RESET_EXPIRY_HOURS
  const expiresAt = new Date(Date.now() + hours * MS_PER_HOUR)
  await prisma.passwordResetToken.create({ data: { userId, token, purpose, expiresAt } })
  return token
}

// Null for a token that doesn't exist, was already used, or has expired —
// all three cases are treated identically by callers ("this link isn't
// valid anymore"), so this collapses them into one check rather than
// leaking which specific reason it failed for (not that it's especially
// sensitive here, but there's no UI need to distinguish them either).
export async function findValidToken(token: string): Promise<(PasswordResetToken & { user: User }) | null> {
  const record = await prisma.passwordResetToken.findUnique({ where: { token }, include: { user: true } })
  if (record === null) return null
  if (record.usedAt !== null) return null
  if (record.expiresAt < new Date()) return null
  return record
}

// Called after a successful reset/invite completion: marks every other
// still-outstanding token for this user as used, so an old invite link
// (or a stale reset link from a previous "forgot password" click) can't
// still be redeemed after the password has already changed.
export async function invalidateOtherTokens(userId: string, exceptTokenId: string): Promise<void> {
  await prisma.passwordResetToken.updateMany({
    where: { userId, id: { not: exceptTokenId }, usedAt: null },
    data: { usedAt: new Date() }
  })
}
