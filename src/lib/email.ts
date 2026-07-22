import { getOrCreateSettings } from './shopSettings.js'
import { decryptSecret } from './encryption.js'
import { getErrorMessage } from './errors.js'
import { renderEmailShell, escapeHtml } from './emailTemplate.js'
import { isWebhookConfigured, sendAuthEmailViaWebhook } from './webhook.js'

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

// The shop's own name, logo, sender name and reply-to address now brand these,
// rather than a hardcoded "Butcher Cashier" — an invite from a shop called
// Kayan that says "Butcher Cashier" in the header reads like spam.
// `getBrandContext` is the one place that resolves them; both emails go through
// the shared shell in emailTemplate.ts so they can't drift apart again.
interface BrandContext {
  shopName: string
  logoUrl: string | null
  // The Settings "sender name" — used as Brevo's From display name, and passed
  // to Make so a scenario can set the same display name on the Gmail send.
  senderName: string
  // The Settings "sender email". On the Brevo path it's the verified From. On
  // the Make path the From is fixed to the connected Google account, so this
  // rides along as the reply-to instead, keeping replies pointed at the shop.
  // '' when unset — never null, so it stays a stable string field for Make.
  replyTo: string
}

async function getBrandContext(): Promise<BrandContext> {
  try {
    const settings = await getOrCreateSettings()
    const shopName = settings.shopName === '' ? 'Butcher Cashier' : settings.shopName
    // Prefer the app logo (full colour, screen-oriented) over the receipt
    // logo (a high-contrast mark meant for a thermal printer) for an email.
    const logoUrl = settings.appLogoUrl ?? settings.receiptLogoUrl ?? null
    return { shopName, logoUrl, senderName: settings.mailSenderName, replyTo: settings.brevoSenderEmail ?? '' }
  } catch {
    return { shopName: 'Butcher Cashier', logoUrl: null, senderName: 'Butcher Cashier', replyTo: '' }
  }
}

// Both transactional emails now dispatch the same way: prefer the Make (or
// other WEBHOOK_URL) scenario when one is configured, and fall back to Brevo
// otherwise. This is a preference, not a broadcast — never both, so no
// duplicate emails. Make wins when present because it's the path that
// authenticates (it sends through the shop's real Gmail), where Brevo-from-a-
// gmail-address does not.
//
// Returns true if EITHER channel accepted the message. That's "handed off to a
// working sender", not "delivered" — but the caller (the invite/reset route)
// always returns the raw link too, so this only decides the wording the UI
// shows, and treating an accepted hand-off as success is right for that.
interface TransactionalEmail {
  kind: 'invite' | 'password_reset'
  to: string
  subject: string
  html: string
  bodyText: string
  link: string
  role: string
  brand: BrandContext
}

async function dispatchTransactional(message: TransactionalEmail): Promise<boolean> {
  const { kind, to, subject, html, bodyText, link, role, brand } = message
  if (isWebhookConfigured()) {
    return await sendAuthEmailViaWebhook({
      kind, to, subject, bodyText, bodyHtml: html, link, role,
      senderName: brand.senderName,
      replyTo: brand.replyTo,
      shopName: brand.shopName
    })
  }
  return await sendEmail(to, subject, html)
}

export async function sendInviteEmail(email: string, setPasswordUrl: string, role: string): Promise<boolean> {
  const brand = await getBrandContext()
  const { shopName, logoUrl } = brand
  const subject = `You’ve been invited to ${shopName}`
  const html = renderEmailShell({
    shopName,
    logoUrl,
    title: `You’ve been invited to ${shopName}`,
    introHtml: `An account has been created for you with the <strong>${escapeHtml(role)}</strong> role. Set a password to activate it.`,
    button: { label: 'Set your password', url: setPasswordUrl },
    footerNote: `This link expires in 7 days. If the button doesn’t work, copy and paste this address into your browser:<br />${escapeHtml(setPasswordUrl)}`
  })
  const bodyText = `You've been invited to ${shopName}.\n\nAn account has been created for you with the ${role} role. Set your password to activate it:\n${setPasswordUrl}\n\nThis link expires in 7 days.`
  return await dispatchTransactional({ kind: 'invite', to: email, subject, html, bodyText, link: setPasswordUrl, role, brand })
}

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<boolean> {
  const brand = await getBrandContext()
  const { shopName, logoUrl } = brand
  const subject = `Reset your ${shopName} password`
  const html = renderEmailShell({
    shopName,
    logoUrl,
    title: 'Reset your password',
    introHtml: 'We received a request to reset the password for this account. Click below to choose a new one. If you didn’t ask for this, you can safely ignore this email — nothing will change.',
    button: { label: 'Reset password', url: resetUrl },
    footerNote: `This link expires in 1 hour. If the button doesn’t work, copy and paste this address into your browser:<br />${escapeHtml(resetUrl)}`
  })
  const bodyText = `Reset your ${shopName} password.\n\nWe received a request to reset the password for this account. Choose a new one:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't ask for this, ignore this email — nothing will change.`
  // role is '' — resets have no role, but the field stays present so Make sees
  // one stable payload shape across both auth email types.
  return await dispatchTransactional({ kind: 'password_reset', to: email, subject, html, bodyText, link: resetUrl, role: '', brand })
}
