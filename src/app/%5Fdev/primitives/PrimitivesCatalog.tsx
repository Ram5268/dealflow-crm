'use client'

import { useState } from 'react'
import { Inbox, Phone, Star } from 'lucide-react'
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  DataTable,
  Drawer,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownRoot,
  DropdownSeparator,
  DropdownTrigger,
  EmptyState,
  IconButton,
  Input,
  Kbd,
  Modal,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  RadioGroup,
  Select,
  Sheet,
  Skeleton,
  Spinner,
  Switch,
  Textarea,
  Tooltip,
  useToast,
  type SortState,
} from '@/components/ui'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-line py-6 last:border-b-0">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  )
}

interface DemoRow {
  id: string
  name: string
  status: string
  score: number
}

const DEMO_ROWS: DemoRow[] = [
  { id: '1', name: '221B Baker Street', status: 'Coming soon', score: 92 },
  { id: '2', name: '12 Grimmauld Place', status: 'Active', score: 71 },
  { id: '3', name: '742 Evergreen Terrace', status: 'Off market', score: 44 },
]

export function PrimitivesCatalog() {
  const { toast } = useToast()
  const [modal, setModal] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [checked, setChecked] = useState<boolean | 'indeterminate'>(false)
  const [radio, setRadio] = useState('a')
  const [sw, setSw] = useState(false)
  const [sel, setSel] = useState<string>()
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })
  const [selected, setSelected] = useState<Set<string>>(new Set())

  return (
    <div className="mx-auto max-w-4xl px-6 py-4">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold text-fg">Primitives</h1>
        <p className="mt-1 text-sm text-muted">
          Dev-only catalog. Toggle the theme from the user menu to check both palettes.
        </p>
      </header>

      <Section title="Button">
        {(['primary', 'secondary', 'ghost', 'danger'] as const).map((v) => (
          <Button key={v} variant={v}>
            {v}
          </Button>
        ))}
        <Button variant="primary" size="sm">sm</Button>
        <Button variant="primary" size="md">md</Button>
        <Button variant="primary" size="lg">lg</Button>
        <Button variant="primary" loading>loading</Button>
        <Button variant="primary" disabled>disabled</Button>
      </Section>

      <Section title="IconButton / Tooltip / Kbd">
        <IconButton label="Call"><Phone size={15} /></IconButton>
        <IconButton label="Favourite" size="sm"><Star size={13} /></IconButton>
        <IconButton label="Disabled" disabled><Inbox size={15} /></IconButton>
        <Tooltip content="I am a tooltip"><span className="text-sm text-muted">hover me</span></Tooltip>
        <span className="flex items-center gap-1"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
      </Section>

      <Section title="Input / Textarea / Select">
        <div className="w-56"><Input label="Label" placeholder="Placeholder" hint="A helpful hint" /></div>
        <div className="w-56"><Input label="With error" defaultValue="bad" error="Something is wrong" /></div>
        <div className="w-56"><Input label="Disabled" placeholder="Nope" disabled /></div>
        <div className="w-56"><Textarea label="Textarea" placeholder="Multi-line…" /></div>
        <div className="w-56">
          <Select
            label="Select"
            value={sel}
            onValueChange={setSel}
            options={[
              { value: 'a', label: 'Option A' },
              { value: 'b', label: 'Option B' },
              { value: 'c', label: 'Disabled', disabled: true },
            ]}
          />
        </div>
      </Section>

      <Section title="Checkbox / Radio / Switch">
        <Checkbox checked={checked} onCheckedChange={setChecked} label="Checkbox" />
        <Checkbox checked="indeterminate" label="Indeterminate" />
        <Checkbox checked disabled label="Disabled" />
        <RadioGroup
          value={radio}
          onValueChange={setRadio}
          options={[
            { value: 'a', label: 'Choice A' },
            { value: 'b', label: 'Choice B' },
          ]}
        />
        <Switch checked={sw} onCheckedChange={setSw} label="Switch" />
      </Section>

      <Section title="Badge / Avatar / Skeleton / Spinner">
        {(['neutral', 'accent', 'success', 'warning', 'danger'] as const).map((t) => (
          <Badge key={t} tone={t}>{t}</Badge>
        ))}
        <Avatar name="Ryan Martin" />
        <Avatar name="Ryan Martin" size={32} />
        <div className="flex w-40 flex-col gap-1">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <Spinner />
      </Section>

      <Section title="Overlays">
        <Button onClick={() => setModal(true)}>Open Modal</Button>
        <Button onClick={() => setSheet(true)}>Open Sheet</Button>
        <Button onClick={() => setDrawer(true)}>Open Drawer</Button>
        <PopoverRoot>
          <PopoverTrigger asChild><Button>Popover</Button></PopoverTrigger>
          <PopoverContent><p className="w-48 text-sm text-fg">Popover content.</p></PopoverContent>
        </PopoverRoot>
        <DropdownRoot>
          <DropdownTrigger asChild><Button>Dropdown</Button></DropdownTrigger>
          <DropdownContent>
            <DropdownLabel>Group</DropdownLabel>
            <DropdownItem shortcut={<Kbd>E</Kbd>}>Edit</DropdownItem>
            <DropdownItem disabled>Disabled</DropdownItem>
            <DropdownSeparator />
            <DropdownItem danger>Delete</DropdownItem>
          </DropdownContent>
        </DropdownRoot>
        <Button onClick={() => toast({ title: 'Saved', description: 'Toast with a description.' })}>
          Toast
        </Button>
        <Button variant="danger" onClick={() => toast({ title: 'Failed', tone: 'danger' })}>
          Danger toast
        </Button>
      </Section>

      <Section title="Table">
        <div className="w-full">
          <DataTable
            columns={[
              { key: 'name', header: 'Property', sortable: true, cell: (r: DemoRow) => r.name },
              { key: 'status', header: 'Status', cell: (r: DemoRow) => <Badge>{r.status}</Badge> },
              { key: 'score', header: 'Score', sortable: true, align: 'right', cell: (r: DemoRow) => r.score },
            ]}
            rows={DEMO_ROWS}
            getRowId={(r) => r.id}
            sort={sort}
            onSortChange={setSort}
            selectedIds={selected}
            onSelectedChange={setSelected}
            onRowActivate={(r) => toast({ title: `Opened ${r.name}` })}
          />
        </div>
      </Section>

      <Section title="EmptyState">
        <div className="w-full rounded-lg border border-line bg-elevated">
          <EmptyState
            icon={<Inbox />}
            title="Nothing here yet"
            description="When something shows up, it will appear in this list."
            action={<Button variant="primary">Primary action</Button>}
          />
        </div>
      </Section>

      <Modal
        open={modal}
        onOpenChange={setModal}
        title="Modal title"
        description="Supporting description."
        footer={
          <>
            <Button onClick={() => setModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setModal(false)}>Confirm</Button>
          </>
        }
      >
        <p className="text-sm text-muted">Body content. Esc closes.</p>
      </Modal>

      <Sheet open={sheet} onOpenChange={setSheet} title="Sheet title">
        <p className="text-sm text-muted">Right-side sheet with a backdrop.</p>
      </Sheet>

      <Drawer
        open={drawer}
        onOpenChange={setDrawer}
        title="Drawer title"
        footer={<Button variant="primary" onClick={() => setDrawer(false)}>Send</Button>}
      >
        <p className="text-sm text-muted">
          Non-modal: the page behind stays scrollable and clickable.
        </p>
      </Drawer>
    </div>
  )
}
