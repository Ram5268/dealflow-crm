import { EmptyState } from '@/components/ui'

// Placeholder so the shell navigates everywhere from M1 onward. Real surface
// ships in M3.
export default function InboxPage() {
  return (
    <EmptyState
      title="Inbox is coming"
      description="Unified email, SMS and voicemail threads land here."
    />
  )
}
