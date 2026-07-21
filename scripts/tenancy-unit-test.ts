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

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exitCode = 1
