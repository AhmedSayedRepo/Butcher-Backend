import crypto from 'node:crypto'

// Phase I.2 (WhatsApp customer order intake) — talks directly to Meta's
// WhatsApp Business Cloud API rather than routing through a workflow tool
// like Make (see ADR-004 in Butcher-Project-Plan-v2.md): the core
// order-intake flow shouldn't depend on a third-party service's uptime or
// free-tier limits. Make stays in the picture only for the outgoing
// side-channel notifications set up in Phase F (lib/webhook.ts).

const SHA256_PREFIX = 'sha256='

// Verifies the `X-Hub-Signature-256` header Meta signs every webhook
// delivery with, using WHATSAPP_APP_SECRET as the HMAC key over the exact
// raw request body bytes (not the re-serialized JSON, which can differ in
// whitespace/key order and would break the signature). Without this check,
// anyone who discovers the webhook URL could POST fabricated orders — this
// endpoint has no auth middleware since Meta itself is the caller, so this
// signature check is the only thing standing in for it.
export function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const { env } = process
  const { WHATSAPP_APP_SECRET: appSecret } = env
  if (appSecret === undefined || appSecret === '') return false
  // Deliberately not `!signatureHeader?.startsWith(...)` (what
  // prefer-optional-chain would suggest): that form's `?.` result is
  // `boolean | undefined`, which strict-boolean-expressions then rejects,
  // AND it stops TypeScript narrowing `signatureHeader` to `string` for the
  // `.slice()` call below (narrowing works off the `=== undefined` check on
  // the variable itself, not off a comparison of the optional-chain's
  // result) — the two rules are effectively in conflict for this exact
  // pattern, so this keeps the type-safe form and opts out of the stylistic
  // one.
  // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- see comment above: the optional-chain form breaks narrowing for signatureHeader.slice() below and trips strict-boolean-expressions
  if (signatureHeader === undefined || !signatureHeader.startsWith(SHA256_PREFIX)) return false

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')
  const provided = signatureHeader.slice(SHA256_PREFIX.length)

  const expectedBuf = Buffer.from(expected, 'hex')
  const providedBuf = Buffer.from(provided, 'hex')
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false, so that case has to be handled before calling it.
  if (expectedBuf.length !== providedBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, providedBuf)
}

const WHATSAPP_API_VERSION = 'v21.0'

// Optional: sends a plain-text WhatsApp reply confirming receipt. Only
// fires if WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID are both
// configured — same "opt-in, fire-and-forget, swallow errors" shape as
// lib/webhook.ts, so a missing/expired token never fails the inbound
// message handling that triggered it. This means WhatsApp order intake can
// go live and start creating drafts before reply-sending is fully wired
// up (e.g. while still on a temporary Meta test number/token).
export async function sendWhatsAppReply(toPhone: string, body: string): Promise<void> {
  const { env } = process
  const { WHATSAPP_ACCESS_TOKEN: token, WHATSAPP_PHONE_NUMBER_ID: phoneNumberId } = env
  if (token === undefined || token === '' || phoneNumberId === undefined || phoneNumberId === '') return

  try {
    await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body }
      })
    })
  } catch {
    // Fire-and-forget by design — see file header.
  }
}
