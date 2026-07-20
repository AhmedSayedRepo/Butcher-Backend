// v3 follow-up: transactional email for the admin-invite / password-reset
// auth flow. Uses Resend's plain HTTP API directly (a single `fetch` call,
// no SDK dependency) — same "opt-in, fire-and-forget where it can be"
// shape as lib/webhook.ts and lib/whatsapp.ts's sendWhatsAppReply, but with
// one difference: those two never need their result checked by the caller
// (a missed webhook/WhatsApp reply is a soft failure), while the invite
// flow's caller DOES want to know whether the email actually sent, so it
// can fall back to showing the admin the raw link to copy/share manually.
// So this returns a boolean rather than being purely fire-and-forget.

const RESEND_API_URL = 'https://api.resend.com/emails'

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const { env } = process
  const { RESEND_API_KEY: apiKey, FROM_EMAIL: from } = env
  if (apiKey === undefined || apiKey === '' || from === undefined || from === '') return false

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to, subject, html })
    })
    return res.ok
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
