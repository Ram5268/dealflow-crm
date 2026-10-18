'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { Button, EmptyState } from '@/components/ui'

/** The page couldn't load (the database didn't answer): say so plainly, with a way to try again. */
export function PipelineLoadError() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <EmptyState
      icon={<AlertTriangle />}
      title="The Pipeline couldn't load"
      description="The CRM's database didn't answer. Nothing was changed. Try again in a moment."
      action={
        <Button loading={pending} onClick={() => startTransition(() => router.refresh())}>
          Try again
        </Button>
      }
    />
  )
}
