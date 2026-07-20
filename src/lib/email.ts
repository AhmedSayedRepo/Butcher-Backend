import nodemailer from 'nodemailer'
import { getOrCreateSettings } from './shopSettings.js'
import { decryptSecret } from './encryption.js'

// v3 follow-up: transactional email for the admin-invite / password-reset
// auth flow. Same "opt-in, fire-and-forget where it can be" shape as
// lib/webhook.ts and lib/whatsapp.ts's sendWhatsAppReply, but with one
// difference: those two never need their result checked by the caller (a
// missed webhook/WhatsApp reply is a soft failure), while the invite
// flow's caller DOES want to know whether the email actually sent, so it
// can fall back to showing the admin the raw link to copy/share manually.
// So this returns a boolean rather than being purely fire-and-forget.
//
// v3.1 follow-up 4: originally sent via Resend's HTTP API, but Resend
// refuses to deliver anywhere except the account owner's own inbox until a
// custom domain is verified — and verifying a domain costs money the shop
// doesn't want to spend on this yet. Switched to plain Gmail SMTP via
// nodemailer instead: free, no domain needed, delivers to any recipient
// (subject to Gmail's own ~500/day sending cap, far more than a small
// shop's invite volume). Requires a Google Account with 2-Step
// Verification enabled and an "app password" generated for it — see
// .env.example for the exact steps.
//
// v3.1 follow-up 9 (ADR-016): the Gmail address/app password can now also
// be set from /settings (ShopSettings.smtpUser/smtpAppPasswordEncrypted)
// instead of only env vars, so an admin can rotate them without touching
// Render. DB values win when present; SMTP_USER/SMTP_APP_PASSWORD env vars
// remain the fallback for a deployment that hasn't configured this yet.
// Because credentials can now change at runtime (not just at process
// start), the transporter is no longer cached as a module-level singleton
// — it's rebuilt on every call instead. That's cheap: constructing a
// nodemailer transport is pure config, no network I/O (it only connects
// when `sendMail` is actually called), so this costs nothing real and
// guarantees a settings change takes effect on the very next email.
interface SmtpCredentials { user: string, pass: string }

async function getSmtpCredentials(): Promise<SmtpCredentials | null> {
  const { env } = process
  const { SMTP_USER: envUser, SMTP_APP_PASSWORD: envPass } = env
  const settings = await getOrCreateSettings()

  const user = (settings.smtpUser !== null && settings.smtpUser !== '') ? settings.smtpUser : envUser
  if (user === undefined || user === '') return null

  if (settings.smtpAppPasswordEncrypted !== null && settings.smtpAppPasswordEncrypted !== '') {
    try {
      return { user, pass: decryptSecret(settings.smtpAppPasswordEncrypted) }
    } catch {
      // Malformed ciphertext or SETTINGS_ENCRYPTION_KEY missing/changed —
      // fall through to the env var rather than hard-failing every email.
    }
  }
  if (envPass === undefined || envPass === '') return null
  return { user, pass: envPass }
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const credentials = await getSmtpCredentials()
  if (credentials === null) return false

  try {
    const { user, pass } = credentials
    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } })
    // v3.1 follow-up 5 (Settings page): the display name is admin-editable
    // from /settings (ShopSettings.mailSenderName). Gmail still requires
    // the envelope address itself to be the authenticated account (or a
    // verified "send as" alias) — silently rewrites or rejects anything
    // else — so only the name is configurable, never the address.
    const settings = await getOrCreateSettings()
    const displayFrom = `${settings.mailSenderName} <${user}>`
    await transport.sendMail({ from: displayFrom, to, subject, html })
    return true
  } catch {
    return false
  }
}

function wrapEmailBody(title: string, bodyHtml: string, buttonLabel: string, buttonUrl: string): string {
  // Deliberately plain/minimal HTML (no external stylesheet, no images) —
  // renders correctly in every mail client without a template engine.
  return `<!DOCTYPE html><html><body style="font-family: sans-serif; color: #1c1917; max-width: 480px; margin: 0 auto;">
<h2>${title}</h2>
<p>${bodyHtml}</p>
<p><a href="${buttonUrl}" style="display:inline-block; background:#b8392a; color:#fff; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:600;">${buttonLabel}</a></p>
<p style="color:#78716c; font-size:12px;">If the button doesn't work, copy this link: ${buttonUrl}</p>
</body></html>`
}

export async function sendInviteEmail(email: string, setPasswordUrl: string, role: string): Promise<boolean> {
  const html = wrapEmailBody(
    'You’ve been invited to Butcher Cashier',
    `An admin created an account for you (role: <strong>${role}</strong>). Set a password to activate it — this link expires in 7 days.`,
    'Set your password',
    setPasswordUrl
  )
  return await sendEmail(email, 'You’ve been invited to Butcher Cashier', html)
}

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<boolean> {
  const html = wrapEmailBody(
    'Reset your password',
    'Someone requested a password reset for this account. If it wasn’t you, ignore this email — this link expires in 1 hour.',
    'Reset password',
    resetUrl
  )
  return await sendEmail(email, 'Reset your Butcher Cashier password', html)
}
