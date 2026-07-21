// v2 replan, Phase D — RBAC. Two layers, modeled on qa-studio's
// role-plus-capability-toggle pattern (see Butcher-Project-Plan-v2.md,
// ADR-005): a coarse `role` preset that implies a default set of
// capabilities, plus an optional per-user `caps` array (stored as Json on
// User) for one-off overrides beyond what the role alone grants.

// v3.1 follow-up 10d: `viewer` added BELOW cashier. It exists because caps are
// purely additive — `effectiveCaps` unions the role's defaults with the user's
// own overrides, with no way to subtract. So a genuinely read-only account
// can't be made by unticking boxes on a cashier; it needs a role whose defaults
// are empty. Ordering matters: ROLE_RANK derives from position, so `viewer`
// must come first to rank lowest.
export const ROLES = ['viewer', 'cashier', 'manager', 'admin'] as const
export type Role = (typeof ROLES)[number]

export const CAPS = [
  'manage_users',
  'manage_inventory',
  'manage_orders',
  'dismantle_carcass',
  // v3 replan (Phase K — cash management, ADR-012): deliberately its own
  // capability rather than folded into `manage_orders` — handling money is a
  // materially different trust level than taking an order, so a cashier who
  // can ring up a sale shouldn't automatically be able to log arbitrary cash
  // in/out entries or view drawer reports.
  'manage_cash',
  // v3.1 follow-up 10d: creating an order is what actually moves stock and
  // writes a cash-ledger row, and until now it needed nothing but a login —
  // ticking zero capabilities still granted the till. It's a capability now.
  // Granted by default to cashier and above so no existing account loses the
  // ability to ring up a sale; the new `viewer` role is the one that lacks it.
  'create_orders'
] as const
export type Cap = (typeof CAPS)[number]

// Rank derives from position in ROLES rather than a literal { cashier: 0, ... }
// map, so there are no bare numeric literals here for eslint-config-love's
// no-magic-numbers rule to flag, and rank stays in sync with ROLES by
// construction (no second list to keep in sync by hand). Builds a fresh
// object per step (spread, not mutation) for no-param-reassign; the result
// is already structurally assignable to Record<Role, number> with no cast
// needed (an index-signature object satisfies a mapped type over a subset
// of string keys).
const ROLE_RANK: Record<Role, number> = ROLES.reduce<Record<string, number>>(
  (acc, role, index) => ({ ...acc, [role]: index }),
  {}
)

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

export function isCap(value: string): value is Cap {
  return (CAPS as readonly string[]).includes(value)
}

// Unranked/unknown role strings (shouldn't happen once Phase D ships, but
// existing rows predate this field's validation) rank as the lowest —
// fail closed, not open, on anything unrecognized.
export function roleRank(role: string): number {
  return isRole(role) ? ROLE_RANK[role] : ROLE_RANK.cashier
}

// Default caps implied by each role preset, before any per-user overrides.
// Per-user `caps` can only ADD to these — `effectiveCaps` is a union, there is
// no deny mechanism — which is why "read-only" is a role rather than a cashier
// with everything unticked.
export const ROLE_DEFAULT_CAPS: Record<Role, readonly Cap[]> = {
  // Read-only: can see the board, inventory and customers, can change nothing.
  viewer: [],
  cashier: ['create_orders'],
  manager: ['create_orders', 'manage_inventory', 'manage_orders', 'dismantle_carcass', 'manage_cash'],
  admin: ['create_orders', 'manage_users', 'manage_inventory', 'manage_orders', 'dismantle_carcass', 'manage_cash']
}

export function effectiveCaps(role: string, caps: unknown): Cap[] {
  const roleDefaults = isRole(role) ? ROLE_DEFAULT_CAPS[role] : []
  const extra = Array.isArray(caps) ? caps.filter((c): c is Cap => typeof c === 'string' && isCap(c)) : []
  return Array.from(new Set<Cap>([...roleDefaults, ...extra]))
}
