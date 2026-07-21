// Multi-tenancy — unit checks for the pure tenancy logic.
//
// The companion to scripts/tenancy-leak-test.ts, split out because these need
// no database: slug rules, the subdomain check, the billing gate and the CORS
// matcher are all pure functions. That makes them the part of this feature
// that can be verified anywhere, instantly, including in a sandbox with no
// database access — which is exactly where they were written.
//
// The CORS cases are the ones worth keeping: the obvious implementations of
// that check (`endsWith`, `includes`) both accept an attacker-controlled
// origin, and with `credentials: true` that hands over the session cookie.
// Those two failure modes are asserted against directly below.
//
// RUN:  npm run test:tenancy:unit
//
// Outside src/, so — like prisma/seed.ts — it isn't part of the compiled build
// or of type-aware linting. See eslint.config.mjs for that reasoning.
/* eslint-disable no-console -- CLI script; console is the output device */
import { isValidSlug, subdomainMismatch, isBlockedByBilling, requestedSlug } from '../src/middleware/tenant.js'
import { buildOriginChecker } from '../src/lib/corsOrigin.js'
import { sessionHours, sessionExpiresIn, shouldRenew } from '../src/lib/session.js'
import { samePhone } from '../src/lib/phoneMatch.js'

let pass = 0, fail = 0
function t(name: string, got: unknown, want: unknown) {
  const ok = got === want
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${String(got)} want=${String(want)}`}`)
  ok ? pass++ : fail++
}

t('slug: valid', isValidSlug('alaqsa'), true)
t('slug: hyphenated', isValidSlug('al-madina-2'), true)
t('slug: too short', isValidSlug('ab'), false)
t('slug: uppercase rejected', isValidSlug('AlAqsa'), false)
t('slug: reserved www', isValidSlug('www'), false)
t('slug: reserved admin', isValidSlug('admin'), false)
t('slug: leading hyphen', isValidSlug('-shop'), false)
t('slug: trailing hyphen', isValidSlug('shop-'), false)
t('slug: dots rejected', isValidSlug('a.b'), false)
t('slug: 41 chars', isValidSlug('a'.repeat(41)), false)

t('header: absent', requestedSlug(undefined), null)
t('header: blank', requestedSlug('   '), null)
t('header: lowercased', requestedSlug('AlAqsa'), 'alaqsa')

// The mismatch check is inert until a wildcard domain is configured. These
// two blocks are the regression guard for the production outage: a bogus slug
// from a client bug must not be able to refuse every request on a deployment
// that isn't using subdomain routing at all.
delete process.env.CORS_WILDCARD_DOMAIN
t('mismatch: inert without a wildcard domain', subdomainMismatch('anything-bogus', 'alaqsa'), false)

process.env.CORS_WILDCARD_DOMAIN = 'butchercashier.com'
t('mismatch: no header passes', subdomainMismatch(null, 'alaqsa'), false)
t('mismatch: same passes', subdomainMismatch('alaqsa', 'alaqsa'), false)
t('mismatch: different blocked', subdomainMismatch('almadina', 'alaqsa'), true)
t('mismatch: super admin (null org) passes', subdomainMismatch('alaqsa', null), false)

t('billing: GET allowed when suspended', isBlockedByBilling('GET', 'suspended'), false)
t('billing: HEAD allowed when suspended', isBlockedByBilling('HEAD', 'suspended'), false)
t('billing: POST blocked when suspended', isBlockedByBilling('POST', 'suspended'), true)
t('billing: PATCH blocked when suspended', isBlockedByBilling('PATCH', 'suspended'), true)
t('billing: DELETE blocked when suspended', isBlockedByBilling('DELETE', 'suspended'), true)
t('billing: POST allowed when active', isBlockedByBilling('POST', 'active'), false)
t('billing: POST allowed when past_due', isBlockedByBilling('POST', 'past_due'), false)

process.env.CORS_WILDCARD_DOMAIN = 'butchercashier.com'
process.env.CORS_ORIGIN = 'https://butcher-frontend-eight.vercel.app'
const check = buildOriginChecker()
const allow = (o: string | undefined) => { let r = false; check(o, (_e, a) => { r = a === true }); return r }
t('cors: exact legacy host', allow('https://butcher-frontend-eight.vercel.app'), true)
t('cors: subdomain', allow('https://alaqsa.butchercashier.com'), true)
t('cors: apex rejected', allow('https://butchercashier.com'), false)
t('cors: suffix attack rejected', allow('https://butchercashier.com.attacker.com'), false)
t('cors: http rejected', allow('http://alaqsa.butchercashier.com'), false)
t('cors: nested label rejected', allow('https://a.b.butchercashier.com'), false)
t('cors: no origin allowed', allow(undefined), true)
t('cors: unrelated rejected', allow('https://evil.com'), false)


// ── Security audit 2026-07-21 ────────────────────────────────────────────────
// Injection payloads. The point is to assert the *behaviour* rather than to
// trust that "Prisma parameterises, so we're fine" — these are the strings an
// attacker actually sends, checked against the code that receives them.
console.log('')

// A slug becomes a subdomain. Anything that isn't a plain DNS label is refused
// outright, which incidentally makes every injection payload below impossible
// to store as a slug in the first place.
const slugAttacks = [
  "'; DROP TABLE \"Order\"; --",
  '<script>alert(1)</script>',
  '../../etc/passwd',
  'a b',
  'shop%00',
  '.',
  '*',
  'shop.evil.com',
  '${process.env.JWT_SECRET}'
]
for (const attack of slugAttacks) {
  t(`slug rejects ${JSON.stringify(attack).slice(0, 32)}`, isValidSlug(attack), false)
}

// The organization header is only ever compared, never concatenated into a
// query — so a payload in it is inert, and simply fails to match a real slug.
t('org header: payload stays a plain string', requestedSlug("' OR 1=1 --"), "' or 1=1 --")
t('org header: payload never matches a real org', subdomainMismatch("' OR 1=1 --", 'alaqsa'), true)


// ── Session lifetime (security audit follow-up) ──────────────────────────────
console.log('')

delete process.env.SESSION_HOURS
t('session: defaults to 12h', sessionHours(), 12)
process.env.SESSION_HOURS = '8'
t('session: env override honoured', sessionHours(), 8)
process.env.SESSION_HOURS = '0'
t('session: zero falls back to default', sessionHours(), 12)
process.env.SESSION_HOURS = 'abc'
t('session: garbage falls back to default', sessionHours(), 12)
process.env.SESSION_HOURS = '99999'
t('session: clamped to one week', sessionHours(), 168)
process.env.SESSION_HOURS = '0.25'
t('session: clamped up to 1h minimum', sessionHours(), 1)
delete process.env.SESSION_HOURS
t('session: expiresIn format', sessionExpiresIn(), '12h')

// Sliding renewal. `iat`/`exp` are seconds since epoch.
const nowSec = Math.floor(Date.now() / 1000)
const HOUR = 3600
t('renew: fresh token is not renewed',
  shouldRenew(nowSec, nowSec + 12 * HOUR), false)
t('renew: past halfway is renewed',
  shouldRenew(nowSec - 7 * HOUR, nowSec + 5 * HOUR), true)
t('renew: exactly at issue is not renewed',
  shouldRenew(nowSec, nowSec + HOUR), false)
t('renew: missing claims are not renewed',
  shouldRenew(undefined, undefined), false)
t('renew: nonsense lifetime is not renewed',
  shouldRenew(nowSec, nowSec - HOUR), false)


// ── Phone matching (v3.2 — link a WhatsApp order to a known customer) ────────
console.log('')

// The whole point: WhatsApp sends E.164 without a plus, shops type whatever
// they were told. These are all the same line.
const waNumber = '201018185200'
t('phone: matches national form with leading zero', samePhone(waNumber, '01018185200'), true)
t('phone: matches spaced form', samePhone(waNumber, '0101 818 5200'), true)
t('phone: matches +country form', samePhone(waNumber, '+20 101 818 5200'), true)
t('phone: matches dashed form', samePhone(waNumber, '010-1818-5200'), true)
t('phone: matches itself', samePhone(waNumber, waNumber), true)

t('phone: different number does not match', samePhone(waNumber, '01018185201'), false)
t('phone: too short to compare', samePhone(waNumber, '5200'), false)
t('phone: null never matches', samePhone(waNumber, null), false)
t('phone: empty never matches', samePhone(waNumber, ''), false)
t('phone: two nulls do not match', samePhone(null, null), false)
t('phone: letters stripped, still matches', samePhone(waNumber, 'tel: 0101-818-5200'), true)

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exitCode = 1
