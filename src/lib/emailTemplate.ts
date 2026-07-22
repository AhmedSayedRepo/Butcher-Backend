// v3.2 — one branded HTML shell for every email and email-shaped notification
// this app produces.
//
// Two senders needed it. `email.ts` sends the invite and password-reset
// emails through Brevo; `webhook.ts` now hands the outgoing webhook a
// ready-made `bodyHtml` so the automation on the other end can drop it
// straight into an email without rebuilding the markup. Before this, the two
// diverged: the Brevo emails were an `<h2>` and a red button, and the webhook
// carried no HTML at all, so the order-notification email was whatever the
// low-code tool improvised from raw fields — which is how a status ended up
// reading `IN_PROGRESS` in a customer-facing message.
//
// Constraints that shape the markup, none of them negotiable in email:
//   - Inline styles only. Gmail, Outlook and the rest strip <style> blocks and
//     external sheets, so every rule lives on the element.
//   - Tables for layout, not fl/grid. It's 2026 in the browser and 2003 in the
//     mail client; a table with fixed cell widths is the one thing that lays
//     out the same in all of them.
//   - No images required. A logo is used if the shop set one, but the design
//     never depends on it — many clients block remote images by default, and
//     the email has to read correctly with every image suppressed.

const BRAND = '#b8392a'
const INK = '#1c1917'
const MUTED = '#78716c'
const HAIRLINE = '#e7e5e4'
const PANEL = '#f5f5f4'
const NONE = 0

// Values interpolated into the HTML come from user and admin input — a
// customer's name, the shop name, product names, a role string. None of it
// executes in an email client, but an unescaped `<` still breaks the layout,
// and escaping it is the correct default regardless. `[&<>"']` is a plain
// character class under the `v` flag (none of those are reserved
// double-punctuators), so no per-character escaping is needed here.
const HTML_SPECIALS = /[&<>"']/gv
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

export function escapeHtml(value: string): string {
  return value.replace(HTML_SPECIALS, ch => HTML_ESCAPES[ch] ?? ch)
}

export interface EmailRow { label: string, value: string }
export interface EmailButton { label: string, url: string }

export interface EmailShellOptions {
  shopName: string
  // The shop's app/receipt logo, if one is configured. Absent, blank, or a
  // data: URL are all handled: data URLs are inlined base64 that many clients
  // won't render and that bloat the message, so they're deliberately skipped
  // and the wordmark stands in.
  logoUrl?: string | null
  title: string
  // Lead paragraph(s). Pre-escaped/whitelisted HTML is expected here (the
  // callers pass their own small, controlled fragments), so this is NOT
  // escaped — keep interpolation of untrusted values out of it.
  introHtml?: string
  rows?: EmailRow[]
  button?: EmailButton
  footerNote?: string
}

function renderLogo(shopName: string, logoUrl?: string | null): string {
  const usable = typeof logoUrl === 'string' && logoUrl !== '' && !logoUrl.startsWith('data:')
  if (usable) {
    return `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(shopName)}" height="28" style="height:28px;max-height:28px;display:block;border:0;" />`
  }
  return `<span style="font-size:15px;font-weight:700;color:#ffffff;letter-spacing:0.01em;">${escapeHtml(shopName)}</span>`
}

// Row values carry user text — product names, customer names — and this shop
// is Arabic, while the email's own chrome is English. Mixing the two in one
// line hands the Unicode bidirectional algorithm an ambiguous run: with an LTR
// paragraph direction it reorders "لحم بقرى بتلو 2kg" so the quantity and the
// name visually swap, which reads as gibberish even though the string is
// perfectly correct.
//
// `<bdi>` (bidi isolate) is the fix: it walls the value off from the
// surrounding direction and picks its own base direction from its first strong
// character — Arabic name → RTL, English name → LTR — so each row lays itself
// out correctly with no per-language branching. `dir="auto"` and the explicit
// `unicode-bidi` are belt and braces for mail clients that keep the element but
// drop the user-agent stylesheet.
export function isolate(value: string): string {
  return `<bdi dir="auto" style="unicode-bidi:isolate;">${escapeHtml(value)}</bdi>`
}

function renderRows(rows: EmailRow[]): string {
  const cells = rows.map(row => `
        <tr>
          <td style="padding:7px 0;font-size:13px;color:${MUTED};white-space:nowrap;vertical-align:top;">${isolate(row.label)}</td>
          <td dir="auto" style="padding:7px 0 7px 16px;font-size:14px;color:${INK};font-weight:600;text-align:right;">${isolate(row.value)}</td>
        </tr>`).join('')
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border-top:1px solid ${HAIRLINE};border-bottom:1px solid ${HAIRLINE};">
        ${cells}
      </table>`
}

function renderButton(button: EmailButton): string {
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;">
        <tr>
          <td style="border-radius:8px;background:${BRAND};">
            <a href="${escapeHtml(button.url)}" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(button.label)}</a>
          </td>
        </tr>
      </table>`
}

// A complete, standalone HTML document. Centred card on a light background,
// a slim brand header carrying the shop's name (or logo), the title, the
// intro, optional detail rows, an optional call-to-action button, and a
// muted footer. Everything an email client needs and nothing it will strip.
export function renderEmailShell(options: EmailShellOptions): string {
  const { shopName, logoUrl, title, introHtml, rows, button, footerNote } = options
  const rowsHtml = rows !== undefined && rows.length > NONE ? renderRows(rows) : ''
  const introBlock = introHtml !== undefined && introHtml !== ''
    ? `<p style="margin:0 0 4px;font-size:15px;line-height:1.6;color:${INK};">${introHtml}</p>`
    : ''
  const buttonHtml = button === undefined ? '' : renderButton(button)
  const footer = footerNote !== undefined && footerNote !== ''
    ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:${MUTED};">${footerNote}</p>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:${PANEL};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PANEL};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:100%;background:#ffffff;border:1px solid ${HAIRLINE};border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background:${BRAND};padding:14px 24px;">${renderLogo(shopName, logoUrl)}</td>
          </tr>
          <tr>
            <td style="padding:26px 24px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:${INK};font-weight:700;">${escapeHtml(title)}</h1>
              ${introBlock}
              ${rowsHtml}
              ${buttonHtml}
              ${footer}
            </td>
          </tr>
        </table>
        <p style="margin:16px 0 0;font-size:11px;color:${MUTED};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(shopName)}</p>
      </td>
    </tr>
  </table>
</body>
</html>`
}
