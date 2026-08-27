import { prisma } from '@/lib/prisma'

// Returns the active organization id for the current request.
// Today: singleton org "dealflow-ryan" (single-seat MVP).
// Tomorrow: reads from auth/session/JWT when a second seat is onboarded.
//
// Cached at module level — first call hits the DB, subsequent calls within the
// same Node worker return the cached value. Worker restart re-queries once.
let cachedOrgId: string | null = null

export async function getCurrentOrgId(): Promise<string> {
  if (cachedOrgId) return cachedOrgId
  const org = await prisma.organization.findUnique({
    where: { slug: 'dealflow-ryan' },
    select: { id: true },
  })
  if (!org) {
    throw new Error(
      'Singleton organization "dealflow-ryan" not found. ' +
        'Seed the Organization row before serving requests.'
    )
  }
  cachedOrgId = org.id
  return cachedOrgId
}
