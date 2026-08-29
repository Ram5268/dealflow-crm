import { notFound } from 'next/navigation'
import { PrimitivesCatalog } from './PrimitivesCatalog'

// Dev-only visual QA surface for the design system (brief §6). This is the
// stand-in for Storybook — every variant of every primitive on one page.
export default function PrimitivesPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <PrimitivesCatalog />
}
