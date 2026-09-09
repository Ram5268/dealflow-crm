import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, HttpError } from '@/lib/shared/http'
import { putObject } from '@/lib/core-data/importer/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 100 * 1024 * 1024 // 100MB

// POST /api/imports (multipart/form-data): file + sourceLabel
export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const form = await req.formData()
  const file = form.get('file')
  const sourceLabel = String(form.get('sourceLabel') ?? '').trim()
  if (!(file instanceof File)) throw new HttpError(400, 'file is required (multipart)')
  if (!sourceLabel) throw new HttpError(400, 'sourceLabel is required')
  if (file.size > MAX_BYTES) throw new HttpError(413, 'file exceeds 100MB')

  const user = await prisma.user.findFirstOrThrow({ where: { organizationId } })
  const buffer = Buffer.from(await file.arrayBuffer())

  // Sweep stale import blobs before creating a new batch. sourceBlob is nulled
  // on the next import upload rather than at batch.status='completed' because
  // commitImport is documented idempotent and pg-boss can retry a commit long
  // after the first attempt succeeds. Nulling at completion would break retry
  // convergence. The 24h window is longer than any realistic pg-boss retry
  // horizon and negligible at import volume (~1 MB x <24h per batch).
  await prisma.importBatch.updateMany({
    where: { sourceBlob: { not: null }, createdAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } },
    data: { sourceBlob: null },
  })

  const batch = await prisma.importBatch.create({
    data: {
      organizationId,
      userId: user.id,
      sourceLabel,
      filename: file.name,
      storageKey: 'pending',
      status: 'pending',
    },
  })
  const storageKey = `imports/${organizationId}/${batch.id}/${file.name}`
  await putObject(storageKey, buffer)
  await prisma.importBatch.update({ where: { id: batch.id }, data: { storageKey } })

  return json({ importBatchId: batch.id, status: 'pending' }, correlationId, { status: 201 })
})
