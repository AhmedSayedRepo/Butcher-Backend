// v2 replan (Phase F — outgoing webhook). Fire-and-forget POST to a
// configurable WEBHOOK_URL on key events (order.created, product.low_stock,
// order.status_changed) — an opt-in side channel for automations (n8n,
// Zapier, Make, a Slack/email digest, etc.) that doesn't couple the core app
// to any of those services' uptime. See ADR-004 / Phase F in
// Butcher-Project-Plan-v2.md for why this stays a plain outgoing webhook
// rather than routing through a workflow tool.
//
// Deliberately swallows its own errors: a webhook receiver being down or
// slow must never fail the request that triggered it (creating an order,
// editing stock). `void` marks the intentionally-unawaited call at each
// call site so @typescript-eslint/no-floating-promises doesn't flag it.
// v3.1 follow-up: `order.created` and `order.status_changed` previously
// carried very different fields (status_changed had no customer/totalAmount
// at all), which is why a single generic email template rendered blank
// "Customer:"/"Total amount:"/"Product: ()" lines for status-change
// notifications — those fields simply didn't exist in that event's payload.
// Both order events now carry the same core order data (customer,
// totalAmount, orderNumber, items); only the fields specific to *why* the
// event fired differ between them.
// v3.1 follow-up 2: the array items were originally keyed `name`, which
// collides with the top-level `name` field used by `product.low_stock`
// events — renamed to `itemName` so it can't collide with a sibling field.
// That turned out not to be the real bug, though: Make.com's `map()`
// function throws `'{empty}' is not a valid key` whenever it isn't handed a
// genuine array (confirmed against Make's own community forum — this is a
// known Make behavior, not something fixable by renaming a field), and
// Make's `if()` does not short-circuit, so no in-formula guard clause can
// protect a `map()`/`join()` call from ever running. Every downstream tool
// that tries to flatten `items` into a string is at the mercy of that
// engine's array handling.
// v3.1 follow-up 3: stopped asking downstream low-code tools to flatten
// `items` at all. `itemsSummary` is a plain, backend-computed string
// (`"Beef 2kg, Chicken 1kg"`), built with ordinary, fully-tested JS
// `.map().join()` — the same shape as every other scalar field here
// (`customer`, `totalAmount`, ...), none of which have ever caused a
// downstream error. `items` (the array) is kept too, for any future
// consumer that wants the structured form.
import { getOrCreateSettings } from './shopSettings.js'
import { renderEmailShell, escapeHtml, isolate, type EmailRow } from './emailTemplate.js'

export type WebhookEvent =
  | { type: 'order.created', orderId: string, orderNumber: number | null, customer: string | null, totalAmount: string, items: Array<{ itemName: string, kg: string }>, itemsSummary: string }
  | { type: 'order.status_changed', orderId: string, orderNumber: number | null, customer: string | null, totalAmount: string, items: Array<{ itemName: string, kg: string }>, itemsSummary: string, status: string, previousStatus: string }
  | { type: 'product.low_stock', productId: string, name: string, stockKg: string, thresholdKg: string }

// v3.2 — the enrichment.
//
// The screenshot that prompted this showed an order-status email reading
// "Order #4 -> IN_PROGRESS". That email isn't built here — the automation on
// the far end of the webhook renders it — but everything wrong with it started
// here: the payload carried the raw enum `IN_PROGRESS` and no assembled
// subject or body, so the low-code tool had to improvise both, and improvised
// badly.
//
// So each order/stock event now leaves this function carrying three
// ready-to-use fields the automation can map straight through with no
// formula logic at all:
//   - `subject`  — the email subject line
//   - `bodyText` — a complete plain-text body, newline-joined
//   - `bodyHtml` — the same content in the app's branded email shell
// plus human-readable status labels. The original raw fields are all still
// present, so any existing automation keeps working unchanged.
//
// `bodyText` is built here, as a single string, on purpose. The long comment
// below documents why: Make/Integromat's `map()` throws on anything that
// isn't a genuine array, and its `if()` doesn't short-circuit, so no
// in-formula guard can make an array safe to flatten downstream. Handing over
// a finished string sidesteps that engine's array handling entirely — the
// same reasoning that made `itemsSummary` a backend-computed string.

// Mirrors the frontend's `orders_page.status_*` labels so an email and the
// board agree on wording. Unknown values fall through to the raw string
// rather than being dropped.
const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  CREATED: 'Created',
  IN_PROGRESS: 'In Progress',
  ON_THE_WAY: 'On the Way',
  IN_PREMISE: 'In Premise',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

function orderRef(orderNumber: number | null): string {
  return orderNumber === null ? '' : `#${orderNumber.toString()}`
}

function brandPrefix(shopName: string): string {
  return shopName === '' ? '' : `${shopName} · `
}

interface Enrichment {
  subject: string
  bodyText: string
  bodyHtml: string
  // Only order.status_changed carries these; optional so the one shape covers
  // every event.
  statusLabel?: string
  previousStatusLabel?: string
}

function customerLine(customer: string | null): string {
  return customer !== null && customer !== '' ? customer : 'Walk-in'
}

function enrichEvent(event: WebhookEvent, shopName: string, logoUrl: string | null): Enrichment {
  const prefix = brandPrefix(shopName)

  if (event.type === 'product.low_stock') {
    const subject = `${prefix}Low stock: ${event.name}`
    const rows: EmailRow[] = [
      { label: 'Product', value: event.name },
      { label: 'In stock', value: `${event.stockKg} kg` },
      { label: 'Alert threshold', value: `${event.thresholdKg} kg` }
    ]
    const bodyText = [
      'Low stock alert',
      `Product: ${event.name}`,
      `In stock: ${event.stockKg} kg`,
      `Alert threshold: ${event.thresholdKg} kg`
    ].join('\n')
    const bodyHtml = renderEmailShell({
      shopName, logoUrl,
      title: 'Low stock alert',
      // isolate(), not escapeHtml(): the product name is Arabic in this shop
      // and the sentence around it is English — without a bidi isolate the two
      // runs reorder into nonsense. isolate() escapes internally.
      introHtml: `<strong>${isolate(event.name)}</strong> has dropped to or below its alert threshold.`,
      rows
    })
    return { subject, bodyText, bodyHtml }
  }

  const ref = orderRef(event.orderNumber)
  // "Order #4" when numbered, plain "Order" for a draft that hasn't been
  // assigned a daily number yet — avoids the double space a bare `${ref}`
  // would leave.
  const orderTitle = ref === '' ? 'Order' : `Order ${ref}`
  const customer = customerLine(event.customer)
  const baseRows: EmailRow[] = [
    { label: 'Order', value: ref === '' ? '—' : ref },
    { label: 'Customer', value: customer },
    { label: 'Total', value: event.totalAmount },
    { label: 'Items', value: event.itemsSummary }
  ]

  if (event.type === 'order.status_changed') {
    const to = statusLabel(event.status)
    const from = statusLabel(event.previousStatus)
    const rows: EmailRow[] = [...baseRows, { label: 'Status', value: `${to} (was ${from})` }]
    const bodyText = [
      `${orderTitle} — ${to}`,
      `Customer: ${customer}`,
      `Total: ${event.totalAmount}`,
      `Items: ${event.itemsSummary}`,
      `Status: ${to} (was ${from})`
    ].join('\n')
    const bodyHtml = renderEmailShell({
      shopName, logoUrl,
      title: `${orderTitle} is now ${to}`,
      introHtml: `The status changed from <strong>${escapeHtml(from)}</strong> to <strong>${escapeHtml(to)}</strong>.`,
      rows
    })
    return {
      subject: `${prefix}${orderTitle} — ${to}`,
      bodyText,
      bodyHtml,
      statusLabel: to,
      previousStatusLabel: from
    }
  }

  const newTitle = ref === '' ? 'New order' : `New order ${ref}`
  const bodyText = [
    newTitle,
    `Customer: ${customer}`,
    `Total: ${event.totalAmount}`,
    `Items: ${event.itemsSummary}`
  ].join('\n')
  const bodyHtml = renderEmailShell({
    shopName, logoUrl,
    title: newTitle,
    introHtml: 'A new order was created.',
    rows: baseRows
  })
  return { subject: `${prefix}${newTitle}`, bodyText, bodyHtml }
}

// Best-effort shop branding for the enriched fields. Isolated in its own
// try/catch so a settings-read failure degrades to unbranded copy rather than
// dropping the webhook — the raw fields the automation may already depend on
// must go out regardless.
async function getBrand(): Promise<{ shopName: string, logoUrl: string | null }> {
  try {
    const settings = await getOrCreateSettings()
    return {
      // `shopName` has a non-empty schema default, so no fallback is needed —
      // the earlier `!== '' ? … : ''` was just the identity on a string.
      shopName: settings.shopName,
      logoUrl: settings.appLogoUrl ?? settings.receiptLogoUrl ?? null
    }
  } catch {
    return { shopName: '', logoUrl: null }
  }
}

export async function fireWebhook(event: WebhookEvent): Promise<void> {
  const { env } = process
  const { WEBHOOK_URL: url } = env
  // Resolved before touching the DB: when no webhook is configured (the common
  // case), enrichment and its settings read never run.
  if (url === undefined || url === '') return

  try {
    const { shopName, logoUrl } = await getBrand()
    const enrichment = enrichEvent(event, shopName, logoUrl)
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...event,
        ...enrichment,
        shopName,
        firedAt: new Date().toISOString()
      })
    })
  } catch {
    // Fire-and-forget by design — see file header. Nothing to do with a
    // failure here; the triggering request already succeeded.
  }
}

// True when an outgoing webhook (i.e. a Make/Zapier/n8n scenario) is wired up.
// email.ts uses this to decide whether to route a transactional email through
// that scenario instead of Brevo.
export function isWebhookConfigured(): boolean {
  const { env } = process
  const { WEBHOOK_URL: url } = env
  return url !== undefined && url !== ''
}

// v3.2 — the invite/reset emails through the same channel the order
// notifications already use.
//
// Why: Brevo can only authenticate mail sent from a domain (or address) it has
// verified, and DMARC then requires that domain to match the signer. A shop
// using a free `@gmail.com` address as its Brevo sender fails that alignment,
// and the invite lands in spam or is rejected outright — while the order
// emails, sent by Make *through the shop's actual Gmail account*, authenticate
// cleanly and arrive. So this hands the invite/reset email to that same proven
// path.
//
// The payload is deliberately flat, all-string, and null-free. Make's data
// mapper treats a webhook's first sample as the schema and throws on a field
// that's sometimes absent or non-scalar (the same array-handling landmine
// documented at the top of this file) — so `role` is `''` for a reset rather
// than omitted, and `replyTo` is `''` rather than null.
//
// `senderName` and `replyTo` come from the shop's own Settings, so a Make
// scenario can set Gmail's display name and reply-to from them: the From
// address is fixed to the connected Google account, but the shop's identity
// still rides along. Returns whether the scenario ACCEPTED the message (HTTP
// ok), not whether Gmail ultimately delivered it — the most that's knowable
// from this side.
export interface AuthEmailPayload {
  kind: 'invite' | 'password_reset'
  to: string
  subject: string
  bodyText: string
  bodyHtml: string
  senderName: string
  replyTo: string
  shopName: string
  link: string
  role: string
}

export async function sendAuthEmailViaWebhook(payload: AuthEmailPayload): Promise<boolean> {
  const { env } = process
  const { WEBHOOK_URL: url } = env
  if (url === undefined || url === '') return false

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: `auth.${payload.kind}`,
        ...payload,
        firedAt: new Date().toISOString()
      })
    })
    return response.ok
  } catch {
    return false
  }
}
