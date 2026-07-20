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

  console.log('Seed completed. Admin:', email)
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
  cuts: Array<{ cutName: string, expectedYieldPct: number, isOffal?: boolean }>
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
        cuts: { create: t.cuts.map((c) => ({ cutName: c.cutName, expectedYieldPct: c.expectedYieldPct, isOffal: c.isOffal ?? false })) }
      }
    })
  }
}

main()
  .then(async () => { await prisma.$disconnect() })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
