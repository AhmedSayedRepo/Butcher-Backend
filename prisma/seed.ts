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

  console.log('Seed completed. Admin:', email)
}

main()
  .then(async () => { await prisma.$disconnect() })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
