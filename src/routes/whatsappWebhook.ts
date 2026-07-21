import { Router } from 'express'
import type { Request } from 'express'
import { OrderStatus } from '@prisma/client'
import { prisma, prismaUnscoped } from '../lib/db.js'
import { runInTenantContext } from '../lib/tenantContext.js'
import { phoneKey, samePhone } from '../lib/phoneMatch.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { parseOrderMessage } from '../lib/parseOrderMessage.js'
import { verifyMetaSignature, sendWhatsAppReply } from '../lib/whatsapp.js'

const router = Router()

interface RawBodyRequest extends Request {
  rawBody?: Buffer
}

// Meta performs this GET handshake once, when a webhook subscription is
// first pointed at this URL (and again if the subscription is ever
// changed). hub.verify_token must match WHATSAPP_VERIFY_TOKEN exactly —
// Meta's mechanism for confirming we actually control this endpoint before
// it starts sending real traffic. No signature to check here since there's
// no body yet, only these query params.
router.get('/', (req, res) => {
  const { query } = req
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = query

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN && typeof challenge === 'string') {
    res.status(HTTP_STATUS.OK).send(challenge)
    return
  }
  res.sendStatus(HTTP_STATUS.FORBIDDEN)
})

interface MetaTextMessage {
  from: string
  type: string
  text?: { body: string }
}

interface MetaContact {
  wa_id: string
  profile?: { name?: string }
}

interface ExtractedMessages {
  messages: MetaTextMessage[]
  contacts: MetaContact[]
}

const EMPTY_EXTRACTED: ExtractedMessages = { messages: [], contacts: [] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Deliberately not a strict zod schema: Meta's webhook payload is a deeply
// nested, versioned structure with many optional/variant fields (delivery
// receipts, media messages, status updates all arrive on this same
// endpoint) — this only reads the handful of fields the order-intake flow
// actually needs. The two casts below are the one place this trusts Meta's
// documented shape rather than fully validating it at runtime; everything
// downstream (handleInboundOrderMessage) only reads plain string fields off
// the result, so a malformed value here is skipped, not something that can
// crash the request.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- see comment above */
function extractFromChange(change: unknown): ExtractedMessages {
  if (!isRecord(change)) return EMPTY_EXTRACTED
  const { value } = change
  if (!isRecord(value)) return EMPTY_EXTRACTED
  const { messages, contacts } = value
  return {
    messages: Array.isArray(messages) ? (messages as MetaTextMessage[]) : [],
    contacts: Array.isArray(contacts) ? (contacts as MetaContact[]) : []
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

// Split into extractFromChange/extractFromEntry/extractMessages purely to
// keep each function's own cyclomatic complexity under the lint threshold —
// one flat function walking entry[].changes[].value.{messages,contacts}
// exceeded it.
function extractFromEntry(entry: unknown): ExtractedMessages {
  if (!isRecord(entry)) return EMPTY_EXTRACTED
  const { changes } = entry
  if (!Array.isArray(changes)) return EMPTY_EXTRACTED

  const messages: MetaTextMessage[] = []
  const contacts: MetaContact[] = []
  for (const change of changes) {
    const extracted = extractFromChange(change)
    messages.push(...extracted.messages)
    contacts.push(...extracted.contacts)
  }
  return { messages, contacts }
}

function extractMessages(body: unknown): ExtractedMessages {
  if (!isRecord(body)) return EMPTY_EXTRACTED
  const { entry } = body
  if (!Array.isArray(entry)) return EMPTY_EXTRACTED

  const messages: MetaTextMessage[] = []
  const contacts: MetaContact[] = []
  for (const e of entry) {
    const extracted = extractFromEntry(e)
    messages.push(...extracted.messages)
    contacts.push(...extracted.contacts)
  }
  return { messages, contacts }
}

const NO_MATCH_REPLY = "Thanks for your message! Could you tell us the items and weight, e.g. \"2kg beef, 1kg chicken\"?"
const CONFIRMATION_REPLY = "Thanks! We've received your order and a team member will confirm it shortly."
const INITIAL_TOTAL = 0
const NO_MATCHES = 0

// The system user every WhatsApp-originated draft order is attributed to
// (Order.userId is a required FK — no logged-in staff member is driving
// this path). Seeded once in prisma/seed.ts; see that file for why this is
// a real seeded row rather than a nullable column.
// Multi-tenancy — a KNOWN LIMITATION, stated plainly rather than hidden.
//
// This webhook is unauthenticated (Meta signs it with an HMAC; there is no
// session), so there is no tenant context and the Prisma extension has nothing
// to inject. The organization therefore has to be resolved here, explicitly.
//
// Meta delivers every message for a WhatsApp Business number to ONE webhook
// URL, so with a single number there is exactly one shop this can belong to.
// It's taken from the system user's own row — that user is seeded per
// deployment and already identifies the shop.
//
// The real multi-tenant answer is a `whatsappPhoneNumberId` column on
// Organization, matched against `value.metadata.phone_number_id` in the
// payload, so several shops can share one webhook. That's deliberately NOT
// built yet: WhatsApp number verification is still outstanding on your side
// (see ROADMAP), so there is no second number to route, and building a routing
// table for a case that can't be tested would be guessing.
//
// Until then, inbound WhatsApp orders all land in the system user's own shop.
async function getSystemUser(): Promise<{ id: string, organizationId: string | null }> {
  const email = process.env.WHATSAPP_SYSTEM_USER_EMAIL ?? 'whatsapp-bot@system.internal'
  // Unscoped: no tenant context exists here, and this lookup is what
  // establishes which organization the message belongs to.
  const user = await prismaUnscoped.user.findUnique({
    where: { email },
    select: { id: true, organizationId: true }
  })
  if (user === null) {
    throw new Error(`WhatsApp system user not seeded: ${email}. Run "npm run seed" first.`)
  }
  return user
}

/**
 * The id of an existing customer whose phone matches this WhatsApp number, or
 * null. Never creates one — see the note at the call site.
 *
 * Compares in JS rather than in the query because stored numbers are
 * hand-typed with spaces, dashes and inconsistent country codes, so no
 * `contains`/`endsWith` clause matches reliably. Only `{ id, phone }` is
 * fetched, and this runs inside the tenant context so it only ever sees this
 * shop's customers — a few hundred rows for a butcher, which is well within
 * "just compare them".
 *
 * If a shop ever has tens of thousands of customers this wants a normalised
 * `phoneKey` column with an index. Noting the threshold rather than
 * pre-building for a scale that may never arrive.
 */
async function findCustomerByPhone(fromPhone: string): Promise<{ id: string, name: string } | null> {
  const key = phoneKey(fromPhone)
  if (key === null) return null

  const candidates = await prisma.customer.findMany({
    where: { phone: { not: null } },
    select: { id: true, name: true, phone: true }
  })
  const hit = candidates.find(c => samePhone(c.phone, fromPhone))
  return hit === undefined ? null : { id: hit.id, name: hit.name }
}

async function handleInboundOrderMessage(fromPhone: string, text: string, contactName: string | undefined): Promise<void> {
  const { id: userId, organizationId } = await getSystemUser()

  // Everything below runs inside the resolved organization's context, rather
  // than each create naming it. That matters for more than tidiness:
  // `parseOrderMessage` reads the product catalogue to match item names, and
  // unscoped it would match against EVERY shop's products — a cross-tenant
  // read that would put another shop's prices on this shop's draft order.
  //
  // Opening the context once covers the parse, the creates, and anything
  // added to this path later, which is exactly the property the extension
  // exists to provide.
  await runInTenantContext({ organizationId, isSuperAdmin: false }, async () => {
    await createDraftFromMessage({ fromPhone, text, contactName, userId })
  })
}

async function createDraftFromMessage({ fromPhone, text, contactName, userId }: {
  fromPhone: string
  text: string
  contactName: string | undefined
  userId: string
}): Promise<void> {
  const { items } = await parseOrderMessage(text)
  const matched = items.filter(
    (i): i is typeof i & { productId: string, pricePerKg: string } => i.productId !== null && i.pricePerKg !== null
  )
  const total = matched.reduce((sum, it) => sum + Number(it.pricePerKg) * it.requested_kg, INITIAL_TOTAL)

  // v3.2: what the customer asked for that we couldn't price. These used to
  // vanish into `customerMessage` — an order for "2kg beef and some liver"
  // became a tidy one-line draft with no sign the liver was dropped. Stored
  // separately so the card can say so instead of relying on staff re-reading
  // the raw message.
  const unmatched = items
    .filter(i => i.productId === null)
    .map(i => `${i.requested_kg}kg ${i.product_name}`)
  const unmatchedItems = unmatched.length === NO_MATCHES ? null : unmatched.join('\n')

  // v3.2: attach the order to a customer we already know, by phone.
  //
  // Deliberately only LINKS an existing customer — it never creates one. A
  // stranger messaging once shouldn't silently populate the customer list, and
  // whether someone is a customer is a judgement staff make, not a webhook.
  const known = await findCustomerByPhone(fromPhone)
  // Same draft-creation shape as POST /api/orders/draft (Phase C): no stock
  // decrement yet, stock gets re-checked when staff promote it from the
  // pending-orders dashboard. Unmatched items never become OrderItem rows
  // (there's no productId to point the FK at) — the raw text in
  // customerMessage is the fallback record for staff to interpret those.
  await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        // The name the shop knows them by wins over the WhatsApp profile
        // name — staff recognise "Umm Ahmed" from their own records, not
        // whatever the customer set on their phone.
        customer: known?.name ?? contactName ?? fromPhone,
        totalAmount: total,
        userId,
        status: OrderStatus.DRAFT,
        source: 'whatsapp',
        customerMessage: text,
        unmatchedItems,
        customerId: known?.id ?? null
      }
    })
    await tx.orderStatusEvent.create({
      // changedBy: null — no logged-in user drove this transition. Schema
      // comment on OrderStatusEvent.changedBy anticipated exactly this case.
      data: { orderId: created.id, status: OrderStatus.DRAFT, changedBy: null }
    })
    await Promise.all(matched.map(async (it) => {
      await tx.orderItem.create({
        data: {
          orderId: created.id,
          productId: it.productId,
          kg: it.requested_kg,
          price: Number(it.pricePerKg) * it.requested_kg
        }
      })
    }))
    return created
  })

  void sendWhatsAppReply(fromPhone, matched.length > NO_MATCHES ? CONFIRMATION_REPLY : NO_MATCH_REPLY)
}

router.post('/', asyncHandler<RawBodyRequest>(async (req, res) => {
  const signature = req.header('X-Hub-Signature-256')
  const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body))
  if (!verifyMetaSignature(raw, signature)) {
    res.sendStatus(HTTP_STATUS.FORBIDDEN)
    return
  }

  // Meta retries deliveries that don't get a fast 2xx, and expects one
  // regardless of whether this payload contained anything actionable (it
  // could be a status/read receipt, not a new message) — so the response is
  // sent immediately and inbound-message handling happens after.
  res.sendStatus(HTTP_STATUS.OK)

  const { messages, contacts } = extractMessages(req.body)
  const contactByWaId = new Map(contacts.map((c) => [c.wa_id, c]))

  // Each message creates its own independent order — no shared state
  // between iterations — so these can run concurrently rather than
  // sequentially (unlike the dismantle-event output loop, which has to stay
  // sequential; see routes/dismantleEvents.ts for why).
  await Promise.all(messages.map(async (msg) => {
    if (msg.type !== 'text' || msg.text === undefined) return
    await handleInboundOrderMessage(msg.from, msg.text.body, contactByWaId.get(msg.from)?.profile?.name)
  }))
}))

export default router
