import { getOrCreateSettings } from './shopSettings.js'
import { decryptSecret } from './encryption.js'
import { getErrorMessage } from './errors.js'

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
// custom domain is verified. Switched to plain Gmail SMTP via nodemailer.
//
// v3.1 follow-up 9 (ADR-016): the Gmail address/app password became
// configurable from /settings (encrypted at rest) instead of only env vars.
//
// v3.1 follow-ups 10/11/12/14: a series of fixes chasing an admin-invite
// email that wouldn't send — bounded SMTP timeouts (was hanging the whole
// request for up to 2 minutes), catching+logging the real error (was
// silently swallowed), `dns.setDefaultResultOrder('ipv4first')` (didn't
// help — nodemailer resolves DNS itself, bypassing that setting), then
// resolving Gmail's IPv4 address ourselves and handing nodemailer the
// literal IP (fixed the ENETUNREACH, but not the send itself).
//
// ADR-017: all of that turned out to be chasing the wrong layer. Once the
// IPv6 issue was gone, every attempt still failed with a bare "Connection
// timeout" — confirmed via Render's own changelog
// (render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports)
// that free Render web services block ALL outbound traffic to SMTP ports
// (25, 465, 587) as an anti-spam measure. No application-level fix (DNS,
// timeouts, IPv4 pinning) can work around a platform firewall — SMTP from
// this deployment was never going to work without a paid Render plan.
// Switched to Brevo's HTTP transactional email API instead: it sends over
// plain HTTPS (port 443, never blocked), free tier covers 300 emails/day
// (far more than this shop's invite/reset volume), and — unlike Resend —
// doesn't require a verified custom domain to deliver to arbitrary
// recipients, only a single verified sender email address.
interface BrevoCredentials { senderEmail: string, apiKey: string }

async function getBrevoCredentials(): Promise<BrevoCredentials | null> {
  const { env } = process
  const { BREVO_SENDER_EMAIL: envSender, BREVO_API_KEY: envKey } = env
  const settings = await getOrCreateSettings()

  const senderEmail = (settings.brevoSenderEmail !== null && settings.brevoSenderEmail !== '') ? settings.brevoSenderEmail : envSender
  if (senderEmail === undefined || senderEmail === '') return null

  if (settings.brevoApiKeyEncrypted !== null && settings.brevoApiKeyEncrypted !== '') {
    try {
      return { senderEmail, apiKey: decryptSecret(settings.brevoApiKeyEncrypted) }
    } catch {
      // Malformed ciphertext or SETTINGS_ENCRYPTION_KEY missing/changed —
      // fall through to the env var rather than hard-failing every email.
    }
  }
  if (envKey === undefined || envKey === '') return null
  return { senderEmail, apiKey: envKey }
}

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email'
// Generous but bounded — an HTTPS call to Brevo should complete in well
// under a second normally; this only guards against Brevo itself being
// slow/down, same "fail fast and predictably" reasoning as the old SMTP
// timeouts, just far shorter since there's no multi-step SMTP handshake here.
const BREVO_REQUEST_TIMEOUT_MS = 10_000

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  // The whole function is one try/catch — `getBrevoCredentials()` awaits a
  // DB call and can throw on a genuine DB error, which must degrade to
  // "email didn't send, here's the link" (the caller's existing fallback)
  // rather than crash the whole invite/reset request.
  try {
    const credentials = await getBrevoCredentials()
    if (credentials === null) return false
    const { senderEmail, apiKey } = credentials

    // v3.1 follow-up 5 (Settings page): the display name is admin-editable
    // from /settings (ShopSettings.mailSenderName); the address itself is
    // always the verified Brevo sender.
    const settings = await getOrCreateSettings()

    const response = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        sender: { name: settings.mailSenderName, email: senderEmail },
        to: [{ email: to }],
        subject,
        htmlContent: html
      }),
      signal: AbortSignal.timeout(BREVO_REQUEST_TIMEOUT_MS)
    })

    if (!response.ok) {
      const bodyText = await response.text()
      throw new Error(`Brevo API responded ${response.status.toString()} ${response.statusText}: ${bodyText}`)
    }
    return true
  } catch (err) {
    // v3.1 follow-up 11: never swallow this silently — see the full
    // reasoning in the git history for that follow-up. `morgan`'s stream is
    // `process.stdout.write` already (see index.ts), so this uses the
    // matching `stderr` write rather than a bare `console.error` (blocked by
    // this repo's `no-console` rule elsewhere for the same reason).
    process.stderr.write(`sendEmail failed: ${getErrorMessage(err)}\n`)
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
