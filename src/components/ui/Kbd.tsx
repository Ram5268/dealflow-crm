import { cn } from '@/lib/ui/cn'

/** Inline keyboard shortcut chip, e.g. ⌘K. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded px-1',
        'border border-line bg-bg font-sans text-[10px] font-medium text-subtle',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
