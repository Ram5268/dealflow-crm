import { PrismaClient } from '@prisma/client'

// Prisma client singleton — survives Next.js dev hot-reload without leaking
// connections. In production a single instance is created per worker.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
