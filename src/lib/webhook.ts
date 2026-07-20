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
export type WebhookEvent =
  | { type: 'order.created', orderId: string, orderNumber: number | null, customer: string | null, totalAmount: string, items: Array<{ itemName: string, kg: string }>, itemsSummary: string }
  | { type: 'order.status_changed', orderId: string, orderNumber: number | null, customer: string | null, totalAmount: string, items: Array<{ itemName: string, kg: string }>, itemsSummary: string, status: string, previousStatus: string }
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
