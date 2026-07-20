// v3.1 follow-up 3: builds the human-readable item list ("Beef 2kg, Chicken
// 1kg") in plain JS instead of asking a downstream low-code tool (Make.com)
// to flatten the `items` array itself — see the comment on `WebhookEvent`
// in lib/webhook.ts for why that was the actual, repeatedly-recurring bug.
// Extracted out of routes/orders.ts (v3.1 follow-up 6) so routes/
// orderReceiptScan.ts can share it without duplicating the function.
export function itemsSummary(entries: Array<{ itemName: string, kg: string }>): string {
  return entries.map((it) => `${it.itemName} ${it.kg}kg`).join(', ')
}
