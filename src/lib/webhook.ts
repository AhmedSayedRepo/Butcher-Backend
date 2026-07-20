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
// events. Downstream tools (Make.com) that treat a webhook payload as one
// flat variable scope resolve a bare `name` reference to the top-level
// field rather than the array element's field, breaking any per-item
// mapping (e.g. Make's `map(items; name)`) for every order event. Keyed
// `itemName` instead so it can never collide with a sibling field.
export type WebhookEvent =
  | { type: 'order.created', orderId: string, orderNumber: number | null, customer: string | null, totalAmount: string, items: Array<{ itemName: string, kg: string }> }
  | { type: 'order.status_changed', orderId: string, orderNumber: number | null, customer: string | null, totalAmount: string, items: Array<{ itemName: string, kg: string }>, status: string, previousStatus: string }
  | { type: 'product.low_stock', productId: string, name: string, stockKg: string, thresholdKg: string }

export async function fireWebhook(event: WebhookEvent): Promise<void> {
  const { env } = process
  const { WEBHOOK_URL: url } = env
  if (url === undefined || url === '') return

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...event, firedAt: new Date().toISOString() })
    })
  } catch {
    // Fire-and-forget by design — see file header. Nothing to do with a
    // failure here; the triggering request already succeeded.
  }
}
