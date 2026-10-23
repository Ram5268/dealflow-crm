import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import { Button, EmptyState } from '@/components/ui'

// Brief 50 PR 2: a link to a page that doesn't exist (or a lead that was
// removed) says so in plain English, inside the app, with a way back.
export default function NotFound() {
  return (
    <EmptyState
      icon={<FileQuestion />}
      title="We couldn't find that page"
      description="The link may be old or mistyped, or what it pointed to was removed."
      action={
        <Button variant="primary" asChild>
          <Link href="/leads">Go to Leads</Link>
        </Button>
      }
    />
  )
}
