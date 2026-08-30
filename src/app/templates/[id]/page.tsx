import { notFound } from 'next/navigation'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getTemplate } from '@/lib/comms/templates/crud'
import { TemplateEditor } from '../TemplateEditor'

export const dynamic = 'force-dynamic'

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const organizationId = await getCurrentOrgId()
  const { id } = await params
  const t = await getTemplate(organizationId, id)
  if (!t) notFound()

  return (
    <TemplateEditor
      template={{
        id: t.id,
        name: t.name,
        channel: t.channel,
        subject: t.subject,
        bodyText: t.bodyText,
        mergeFields: t.mergeFields,
        lastUsedAt: null,
        createdAt: t.createdAt.toISOString(),
      }}
    />
  )
}
