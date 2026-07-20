import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const email = process.env.ADMIN_EMAIL || 'admin@butcher.app'
  const password = process.env.ADMIN_PASSWORD || 'admin123'
  const hash = await bcrypt.hash(password, 10)

  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      password: hash,
      role: 'admin'
    },
  })

  const count = await prisma.product.count()
  if (count === 0) {
    await prisma.product.createMany({
      data: [
        { name: 'Beef', unit: 'kg', pricePerKg: 15.00, stockKg: 100.000 },
        { name: 'Lamb', unit: 'kg', pricePerKg: 17.50, stockKg: 80.000 },
        { name: 'Chicken', unit: 'kg', pricePerKg: 8.90, stockKg: 150.000 },
      ]
    })
  }

  await seedDismantleTemplates()
  await seedWhatsAppSystemUser()
  await seedShopSettings()

  console.log('Seed completed. Admin:', email)
}

// v3 replan (Phase J — pending-order alerting): ShopSettings is a
// single-row config table (shop-wide policy, not per-user), so seeding just
// ensures exactly one row exists with sane defaults — same "lazily create
// the singleton" shape the GET /api/shop-settings route also implements for
// databases that skip the seed script entirely.
async function seedShopSettings(): Promise<void> {
  const existing = await prisma.shopSettings.count()
  if (existing > 0) return
  await prisma.shopSettings.create({ data: {} })
}

// v3 replan (Phase I.2 — WhatsApp order intake): Order.userId is a required
// FK, but a WhatsApp-originated draft has no logged-in staff member driving
// it. Rather than making Order.userId nullable (a wider schema change
// touching every existing order), a single seeded "system" user is
// attributed instead — same idea as a service account. Its password is a
// random, never-communicated value: this account is never meant to log in
// through /auth/login, only to exist as a valid userId to point the FK at.
// role stays "cashier" (the least-privileged role) rather than "admin", in
// case something ever did try to authenticate as it.
async function seedWhatsAppSystemUser(): Promise<void> {
  const email = process.env.WHATSAPP_SYSTEM_USER_EMAIL || 'whatsapp-bot@system.internal'
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing !== null) return

  const unusablePassword = await bcrypt.hash(crypto.randomUUID(), 10)
  await prisma.user.create({
    data: {
      email,
      password: unusablePassword,
      role: 'cashier'
    }
  })
}

// v2 replan, Phase B.5 — carcass dismantling templates (calf/sheep/goat).
// Mirrors the same 12 templates applied directly to the live Supabase DB via
// the Supabase MCP `execute_sql` tool (see ROADMAP.md) — kept here too so a
// fresh local `npm run seed` (e.g. against a new dev database) starts with
// the same reference data instead of an empty table.
interface TemplateSeed {
  name: string
  animalType: string
  description: string
  cuts: Array<{ cutName: string, expectedYieldPct: number, isOffal?: boolean, isByproduct?: boolean }>
}

const DISMANTLE_TEMPLATES: TemplateSeed[] = [
  {
    name: 'Standard 5-Primal (USDA)',
    animalType: 'calf',
    description: 'Textbook USDA veal primal breakdown. Offal figure is a general indicative estimate, less standardized publicly than the primal percentages.',
    cuts: [
      { cutName: 'Shoulder', expectedYieldPct: 21.00 },
      { cutName: 'Foreshank & Breast', expectedYieldPct: 16.00 },
      { cutName: 'Rib (Hotel Rack)', expectedYieldPct: 9.00 },
      { cutName: 'Loin', expectedYieldPct: 10.00 },
      { cutName: 'Leg', expectedYieldPct: 44.00 },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true }
    ]
  },
  {
    name: 'Foresaddle / Hindsaddle Split',
    animalType: 'calf',
    description: 'Coarse wholesale first-split of a whole carcass, before finer fabrication.',
    cuts: [
      { cutName: 'Foresaddle', expectedYieldPct: 46.00 },
      { cutName: 'Hindsaddle', expectedYieldPct: 54.00 },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true }
    ]
  },
  {
    name: 'Retail Sub-Primal',
    animalType: 'calf',
    description: 'Same primals as the Standard template, named for the retail cuts each yields. Percentages are still at primal granularity; real per-cut sub-splits are not independently sourced.',
    cuts: [
      { cutName: 'Shoulder (chops / roast / stew meat)', expectedYieldPct: 21.00 },
      { cutName: 'Foreshank & Breast (riblets / shank)', expectedYieldPct: 16.00 },
      { cutName: 'Rib (chops / rack roast)', expectedYieldPct: 9.00 },
      { cutName: 'Loin (chops / tenderloin)', expectedYieldPct: 10.00 },
      { cutName: 'Leg (cutlets/scallopini / roast / osso buco shank)', expectedYieldPct: 44.00 },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true }
    ]
  },
  {
    name: 'Nose-to-Tail (minimal waste)',
    animalType: 'calf',
    description: 'Retail cuts plus itemized offal (liver/kidneys/sweetbreads), bones, and trim tracked as real outputs instead of written off as waste.',
    cuts: [
      { cutName: 'Shoulder (chops / roast / stew meat)', expectedYieldPct: 21.00 },
      { cutName: 'Foreshank & Breast (riblets / shank)', expectedYieldPct: 16.00 },
      { cutName: 'Rib (chops / rack roast)', expectedYieldPct: 9.00 },
      { cutName: 'Loin (chops / tenderloin)', expectedYieldPct: 10.00 },
      { cutName: 'Leg (cutlets/scallopini / roast / osso buco shank)', expectedYieldPct: 44.00 },
      { cutName: 'Liver', expectedYieldPct: 1.50, isOffal: true },
      { cutName: 'Kidneys', expectedYieldPct: 0.50, isOffal: true },
      { cutName: 'Sweetbreads', expectedYieldPct: 1.00, isOffal: true },
      { cutName: 'Bones (for stock)', expectedYieldPct: 1.00 },
      { cutName: 'Trim (for ground veal)', expectedYieldPct: 3.00 }
    ]
  },
  {
    name: 'Standard Primal (Lamb)',
    animalType: 'sheep',
    description: 'Textbook lamb primal breakdown, compiled from general lamb yield guides.',
    cuts: [
      { cutName: 'Shoulder', expectedYieldPct: 14.00 },
      { cutName: 'Rack/Rib', expectedYieldPct: 13.00 },
      { cutName: 'Breast & Foreshank', expectedYieldPct: 6.00 },
      { cutName: 'Loin', expectedYieldPct: 9.00 },
      { cutName: 'Leg', expectedYieldPct: 34.00 },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true }
    ]
  },
  {
    name: 'Foresaddle / Hindsaddle Split',
    animalType: 'sheep',
    description: 'Coarse wholesale first-split, same idea as the calf template.',
    cuts: [
      { cutName: 'Foresaddle', expectedYieldPct: 39.00 },
      { cutName: 'Hindsaddle', expectedYieldPct: 61.00 },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true }
    ]
  },
  {
    name: 'Retail Sub-Primal (Lamb)',
    animalType: 'sheep',
    description: 'Same primals as the Standard template, named for the retail cuts each yields.',
    cuts: [
      { cutName: 'Shoulder (chops / roast)', expectedYieldPct: 14.00 },
      { cutName: 'Rack (rib chops / rack roast / crown roast)', expectedYieldPct: 13.00 },
      { cutName: 'Breast & Foreshank (riblets / breast rolls)', expectedYieldPct: 6.00 },
      { cutName: 'Loin (chops / saddle)', expectedYieldPct: 9.00 },
      { cutName: 'Leg (roast / steaks / butterflied)', expectedYieldPct: 34.00 },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true }
    ]
  },
  {
    name: 'Nose-to-Tail (Lamb)',
    animalType: 'sheep',
    description: 'Retail cuts plus itemized offal (liver/kidneys/heart — kidneys are a genuinely prized cut in lamb, not a throwaway), neck, shank, and trim.',
    cuts: [
      { cutName: 'Shoulder (chops / roast)', expectedYieldPct: 14.00 },
      { cutName: 'Rack (rib chops / rack roast / crown roast)', expectedYieldPct: 13.00 },
      { cutName: 'Breast & Foreshank (riblets / breast rolls)', expectedYieldPct: 6.00 },
      { cutName: 'Loin (chops / saddle)', expectedYieldPct: 9.00 },
      { cutName: 'Leg (roast / steaks / butterflied)', expectedYieldPct: 34.00 },
      { cutName: 'Liver', expectedYieldPct: 1.50, isOffal: true },
      { cutName: 'Kidneys', expectedYieldPct: 1.00, isOffal: true },
      { cutName: 'Heart', expectedYieldPct: 0.50, isOffal: true },
      { cutName: 'Neck (osso-buco style)', expectedYieldPct: 2.00 },
      { cutName: 'Shank', expectedYieldPct: 1.50 },
      { cutName: 'Trim (for ground lamb/merguez)', expectedYieldPct: 3.00 }
    ]
  },
  {
    name: 'Standard Primal (Goat)',
    animalType: 'goat',
    description: 'Textbook goat/kid primal breakdown. Loin/breast/neck/flank grouped as one remainder line at this granularity.',
    cuts: [
      { cutName: 'Shoulder', expectedYieldPct: 21.00 },
      { cutName: 'Rack/Rib', expectedYieldPct: 26.00 },
      { cutName: 'Leg', expectedYieldPct: 32.00 },
      { cutName: 'Loin, Breast, Neck & Flank (grouped)', expectedYieldPct: 21.00 },
      { cutName: 'Offal', expectedYieldPct: 5.00, isOffal: true }
    ]
  },
  {
    name: 'Forequarter / Hindquarter Split',
    animalType: 'goat',
    description: 'Named "quarter" (the conventional goat-butchery term) not "saddle". Note: goat forequarter is the HEAVIER half, opposite of calf/beef.',
    cuts: [
      { cutName: 'Forequarter (shoulder, neck, foreshank, rack, breast)', expectedYieldPct: 57.00 },
      { cutName: 'Hindquarter (loin, leg, hind shank, flank)', expectedYieldPct: 43.00 },
      { cutName: 'Offal', expectedYieldPct: 5.00, isOffal: true }
    ]
  },
  {
    name: 'Retail Sub-Primal (Goat)',
    animalType: 'goat',
    description: "Same primals as the Standard template, named for the retail cuts each yields. Likely the highest-volume template in practice given this app's Arabic-speaking market.",
    cuts: [
      { cutName: 'Shoulder (curry-cut pieces / roast)', expectedYieldPct: 21.00 },
      { cutName: 'Rack (goat chops / rack)', expectedYieldPct: 26.00 },
      { cutName: 'Leg (roast / steaks / curry cutting)', expectedYieldPct: 32.00 },
      { cutName: 'Loin, Breast, Neck & Flank (grouped)', expectedYieldPct: 21.00 },
      { cutName: 'Offal', expectedYieldPct: 5.00, isOffal: true }
    ]
  },
  {
    name: 'Nose-to-Tail (Goat)',
    animalType: 'goat',
    description: 'Retail cuts plus itemized offal (liver/heart/kidneys/tripe) and bones (goat bone soup is a real, common dish) and trim.',
    cuts: [
      { cutName: 'Shoulder (curry-cut pieces / roast)', expectedYieldPct: 21.00 },
      { cutName: 'Rack (goat chops / rack)', expectedYieldPct: 26.00 },
      { cutName: 'Leg (roast / steaks / curry cutting)', expectedYieldPct: 32.00 },
      { cutName: 'Loin, Breast, Neck & Flank (grouped)', expectedYieldPct: 21.00 },
      { cutName: 'Liver', expectedYieldPct: 3.50, isOffal: true },
      { cutName: 'Heart', expectedYieldPct: 1.00, isOffal: true },
      { cutName: 'Kidneys', expectedYieldPct: 0.50, isOffal: true },
      { cutName: 'Tripe', expectedYieldPct: 1.50, isOffal: true },
      { cutName: 'Bones (goat bone soup)', expectedYieldPct: 1.50 },
      { cutName: 'Trim (for ground goat)', expectedYieldPct: 2.00 }
    ]
  },
  // v3.1 follow-up 7: cow templates, mirroring the sheep/goat naming
  // convention (calf's own names predate this and stayed as-is). Same
  // "general indicative estimate" caveat as every other template here —
  // percentages are approximate USDA-style beef primal yields of the
  // dressed carcass.
  {
    name: 'Standard Primal (Beef)',
    animalType: 'cow',
    description: 'Textbook beef primal breakdown of the dressed carcass, compiled from general USDA yield guides. Offal figure is a general indicative estimate.',
    cuts: [
      { cutName: 'Chuck', expectedYieldPct: 26.00 },
      { cutName: 'Rib', expectedYieldPct: 10.00 },
      { cutName: 'Short Loin & Sirloin', expectedYieldPct: 14.00 },
      { cutName: 'Round', expectedYieldPct: 22.00 },
      { cutName: 'Plate, Brisket & Flank (grouped)', expectedYieldPct: 19.00 },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true }
    ]
  },
  {
    name: 'Forequarter / Hindquarter Split',
    animalType: 'cow',
    description: 'Coarse wholesale first-split of a whole beef carcass, before finer fabrication. Same template name already used for goat.',
    cuts: [
      { cutName: 'Forequarter (chuck, rib, plate, brisket)', expectedYieldPct: 51.00 },
      { cutName: 'Hindquarter (loin, sirloin, flank, round)', expectedYieldPct: 40.00 },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true }
    ]
  },
  {
    name: 'Retail Sub-Primal (Beef)',
    animalType: 'cow',
    description: 'Same primals as the Standard template, named for the retail cuts each yields.',
    cuts: [
      { cutName: 'Chuck (roast / steaks / ground)', expectedYieldPct: 26.00 },
      { cutName: 'Rib (ribeye / prime rib)', expectedYieldPct: 10.00 },
      { cutName: 'Short Loin & Sirloin (strip / T-bone / sirloin steak)', expectedYieldPct: 14.00 },
      { cutName: 'Round (roast / steaks / ground)', expectedYieldPct: 22.00 },
      { cutName: 'Plate, Brisket & Flank (grouped)', expectedYieldPct: 19.00 },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true }
    ]
  },
  {
    name: 'Nose-to-Tail (Beef)',
    animalType: 'cow',
    description: 'Retail cuts plus itemized offal (liver/kidneys/heart), oxtail, bones, and trim tracked as real outputs instead of written off as waste.',
    cuts: [
      { cutName: 'Chuck (roast / steaks / ground)', expectedYieldPct: 26.00 },
      { cutName: 'Rib (ribeye / prime rib)', expectedYieldPct: 10.00 },
      { cutName: 'Short Loin & Sirloin (strip / T-bone / sirloin steak)', expectedYieldPct: 14.00 },
      { cutName: 'Round (roast / steaks / ground)', expectedYieldPct: 22.00 },
      { cutName: 'Plate, Brisket & Flank (grouped)', expectedYieldPct: 15.00 },
      { cutName: 'Liver', expectedYieldPct: 1.50, isOffal: true },
      { cutName: 'Kidneys', expectedYieldPct: 0.50, isOffal: true },
      { cutName: 'Heart', expectedYieldPct: 0.50, isOffal: true },
      { cutName: 'Oxtail', expectedYieldPct: 1.00 },
      { cutName: 'Bones (for stock)', expectedYieldPct: 2.00 },
      { cutName: 'Trim (for ground beef)', expectedYieldPct: 3.00 }
    ]
  },
  // v3.1 follow-up 7: "why don't the templates consider hide/pelt/blood?" —
  // the templates above model the dressed-carcass breakdown (standard
  // published butchery yield data assumes hide/blood already removed by the
  // supplier). These four cover the other real case: the animal arrives
  // whole and this shop does the skinning/bleeding itself. Deliberately not
  // merged into one giant template — the "Dressed Carcass" line here is
  // meant to be re-weighed and run through a *second* dismantle event
  // against one of the species' regular carcass templates above, same way a
  // real two-stage breakdown actually happens on the floor. Percentages are
  // rough live-to-dressed yield estimates; actual dressing % varies
  // significantly by breed/age/fasting status.
  {
    name: 'Whole Animal (On-Site Slaughter)',
    animalType: 'cow',
    description: 'Use only when the animal arrived whole (hide/blood not yet removed). Record the "Dressed Carcass" output weight as the inputWeightKg of a follow-up event against a regular beef carcass template.',
    cuts: [
      { cutName: 'Dressed Carcass (for further breakdown)', expectedYieldPct: 60.00 },
      { cutName: 'Hide/Pelt', expectedYieldPct: 7.00, isByproduct: true },
      { cutName: 'Blood', expectedYieldPct: 3.50, isByproduct: true },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true },
      { cutName: 'Head, Feet & Other Byproducts', expectedYieldPct: 25.50, isByproduct: true }
    ]
  },
  {
    name: 'Whole Animal (On-Site Slaughter)',
    animalType: 'calf',
    description: 'Use only when the animal arrived whole (hide/blood not yet removed). Record the "Dressed Carcass" output weight as the inputWeightKg of a follow-up event against a regular calf carcass template.',
    cuts: [
      { cutName: 'Dressed Carcass (for further breakdown)', expectedYieldPct: 58.00 },
      { cutName: 'Hide/Pelt', expectedYieldPct: 8.00, isByproduct: true },
      { cutName: 'Blood', expectedYieldPct: 3.50, isByproduct: true },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true },
      { cutName: 'Head, Feet & Other Byproducts', expectedYieldPct: 26.50, isByproduct: true }
    ]
  },
  {
    name: 'Whole Animal (On-Site Slaughter)',
    animalType: 'sheep',
    description: 'Use only when the animal arrived whole (hide/blood not yet removed). Record the "Dressed Carcass" output weight as the inputWeightKg of a follow-up event against a regular lamb carcass template.',
    cuts: [
      { cutName: 'Dressed Carcass (for further breakdown)', expectedYieldPct: 50.00 },
      { cutName: 'Hide/Pelt', expectedYieldPct: 10.00, isByproduct: true },
      { cutName: 'Blood', expectedYieldPct: 3.50, isByproduct: true },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true },
      { cutName: 'Head, Feet & Other Byproducts', expectedYieldPct: 32.50, isByproduct: true }
    ]
  },
  {
    name: 'Whole Animal (On-Site Slaughter)',
    animalType: 'goat',
    description: 'Use only when the animal arrived whole (hide/blood not yet removed). Record the "Dressed Carcass" output weight as the inputWeightKg of a follow-up event against a regular goat carcass template.',
    cuts: [
      { cutName: 'Dressed Carcass (for further breakdown)', expectedYieldPct: 47.00 },
      { cutName: 'Hide/Pelt', expectedYieldPct: 9.00, isByproduct: true },
      { cutName: 'Blood', expectedYieldPct: 3.50, isByproduct: true },
      { cutName: 'Offal', expectedYieldPct: 4.00, isOffal: true },
      { cutName: 'Head, Feet & Other Byproducts', expectedYieldPct: 36.50, isByproduct: true }
    ]
  }
]

async function seedDismantleTemplates(): Promise<void> {
  const existing = await prisma.dismantleTemplate.count()
  if (existing > 0) return
  for (const t of DISMANTLE_TEMPLATES) {
    await prisma.dismantleTemplate.create({
      data: {
        name: t.name,
        animalType: t.animalType,
        description: t.description,
        cuts: { create: t.cuts.map((c) => ({ cutName: c.cutName, expectedYieldPct: c.expectedYieldPct, isOffal: c.isOffal ?? false, isByproduct: c.isByproduct ?? false })) }
      }
    })
  }
}

main()
  .then(async () => { await prisma.$disconnect() })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
