import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { settings } from '@twentyfour/api'
import { industryProfile } from '@twentyfour/entitlement'
import { BASE_TERMS, TERM_KEYS, resolveTermSet, type TermKey } from '@twentyfour/terms'
import { useBootstrap } from '@twentyfour/runtime'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, CardHeader, Icon, Input, Table, TableScroll, Td, Th, Tr, useToast,
} from '@twentyfour/ui'

const DESCRIPTIONS: Record<TermKey, string> = {
  catalog: 'The whole list of what you sell',
  catalog_item: 'One thing in it',
  catalog_category: 'How they are grouped',
  catalog_modifier: 'An optional addition',
  order: 'A registered sale',
  order_line: 'One row of a sale',
  booking: 'A held slot in time',
  customer: 'The person paying',
  staff_member: 'The person serving',
  location: 'Where trade happens',
  resource: 'A bookable thing that is not a person',
  duration: 'How long something takes',
  receipt: 'What the customer is handed',
  no_show: 'When they never arrive',
}

/**
 * The third layer of the vocabulary cascade.
 *
 * Base, then the trade, then whatever this business calls it. A hotel that
 * says Suite rather than Room changes one word here and it changes everywhere,
 * because the word was never a key: the route stays /catalog and the column
 * stays catalog_item whatever is typed in this table.
 */
export function WordsTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { profile, termOverrides } = useBootstrap()
  const mayEdit = usePermission('settings.business')

  const family = industryProfile(profile.industry)?.family
  const fromTrade = useMemo(
    () => resolveTermSet({ family, profile: profile.industry }),
    [family, profile.industry],
  )

  type Overrides = Record<string, { one: string; other: string }>
  const saved = (termOverrides ?? {}) as Overrides
  const [draft, setDraft] = useState<Overrides>(() => ({ ...saved }))

  const save = useMutation({
    mutationFn: () => {
      // Anything blank is sent as null, which drops the override and lets the
      // trade's own word come back.
      const payload: Record<string, { one: string; other: string } | null> = {}
      for (const key of TERM_KEYS) {
        const entry = draft[key]
        payload[key] = entry && entry.one.trim() && entry.other.trim() ? entry : null
      }
      return settings.updateTerms(payload)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: 'Words saved',
        description: 'They change everywhere at once, including on receipts.',
      })
    },
  })

  const set = (key: TermKey, part: 'one' | 'other', value: string) => {
    setDraft((current) => {
      const existing = current[key] ?? { one: '', other: '' }
      return { ...current, [key]: { ...existing, [part]: value } }
    })
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const overridden = TERM_KEYS.filter((key) => draft[key]?.one?.trim()).length

  return (
    <div className="flex flex-col gap-5">
      <Card className="border-accent-border bg-accent-subtle">
        <div className="flex gap-3">
          <Icon name="ShieldCheck" size="lg" className="mt-0.5 shrink-0 text-accent-text" />
          <div className="text-base text-text-muted">
            <p className="font-medium text-text">These are labels, never keys</p>
            <p className="mt-1">
              Renaming one changes what appears on screen and on documents. It does not move any
              data, change any address, or alter what a report counts. You can change your mind as
              often as you like.
            </p>
          </div>
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader
          className="p-5"
          title="What you call things"
          description={`Leave a row blank to use your trade's word. ${overridden} of ${TERM_KEYS.length} changed.`}
        />
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>Thing</Th>
                <Th>Your trade says</Th>
                <Th>You say (one)</Th>
                <Th>You say (more than one)</Th>
              </tr>
            </thead>
            <tbody>
              {TERM_KEYS.map((key) => {
                const trade = fromTrade[key]
                const base = BASE_TERMS[key]
                const custom = draft[key]
                return (
                  <Tr key={key}>
                    <Td>
                      <span className="block font-medium text-text">{DESCRIPTIONS[key]}</span>
                      <span className="block font-mono text-xs text-text-subtle">{key}</span>
                    </Td>
                    <Td>
                      <span className="text-text-muted">{trade.one} / {trade.other}</span>
                      {trade.one !== base.one && (
                        <Badge tone="neutral" className="ml-2">from your trade</Badge>
                      )}
                    </Td>
                    <Td className="w-40">
                      <Input
                        aria-label={`Your word for one ${DESCRIPTIONS[key].toLowerCase()}`}
                        placeholder={trade.one}
                        disabled={!mayEdit}
                        value={custom?.one ?? ''}
                        onChange={(event) => set(key, 'one', event.target.value)}
                      />
                    </Td>
                    <Td className="w-40">
                      <Input
                        aria-label={`Your word for several ${DESCRIPTIONS[key].toLowerCase()}`}
                        placeholder={trade.other}
                        disabled={!mayEdit}
                        value={custom?.other ?? ''}
                        onChange={(event) => set(key, 'other', event.target.value)}
                      />
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        </TableScroll>
      </Card>

      {mayEdit && (
        <div className="flex items-center gap-3">
          <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
            Save words
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft({ ...saved })}>
              Discard
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
