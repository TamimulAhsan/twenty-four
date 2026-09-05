import { useState } from 'react'
import { usePermission } from '@twentyfour/rbac'
import { PageHeader, cn } from '@twentyfour/ui'
import { BusinessTab } from './settings/BusinessTab'
import { TaxTab } from './settings/TaxTab'
import { WordsTab } from './settings/WordsTab'
import { NotificationsTab } from './settings/NotificationsTab'

type Tab = 'business' | 'tax' | 'words' | 'notifications'

const TABS: Array<{ id: Tab; label: string; permission: 'settings.business' | 'settings.tax' }> = [
  { id: 'business', label: 'Business', permission: 'settings.business' },
  { id: 'tax', label: 'Tax', permission: 'settings.tax' },
  { id: 'words', label: 'Words', permission: 'settings.business' },
  { id: 'notifications', label: 'Notifications', permission: 'settings.business' },
]

export function SettingsPage() {
  const mayEditBusiness = usePermission('settings.business')
  const mayEditTax = usePermission('settings.tax')
  const [tab, setTab] = useState<Tab>('business')

  const visible = TABS.filter((entry) =>
    entry.permission === 'settings.tax' ? mayEditTax : mayEditBusiness,
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="How the business is set up. Most of this was filled in at intake and rarely changes."
      />

      <div role="tablist" aria-label="Settings sections" className="flex gap-1 border-b border-border">
        {visible.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            type="button"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={cn(
              'relative -mb-px h-10 px-3.5 text-base font-medium transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
              tab === entry.id
                ? 'text-text after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent'
                : 'text-text-muted hover:text-text',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'business' && <BusinessTab />}
      {tab === 'tax' && <TaxTab />}
      {tab === 'words' && <WordsTab />}
      {tab === 'notifications' && <NotificationsTab />}
    </div>
  )
}
