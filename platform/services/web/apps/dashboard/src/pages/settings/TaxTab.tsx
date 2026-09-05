import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { settings, type TaxRate } from '@twentyfour/api'
import { useBootstrap } from '@twentyfour/runtime'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, CardHeader, Icon, Input, Switch, Table, TableScroll, Td, Th, Tr,
  useToast,
} from '@twentyfour/ui'

/**
 * Tax rates and how prices are quoted.
 *
 * Both are load-bearing and neither is obvious. The rates decide what every
 * receipt reports, and whether prices include tax decides what a merchant is
 * actually charging: flip it by accident and every price on the till moves by
 * the VAT rate without a single figure on screen changing.
 */
export function TaxTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { profile } = useBootstrap()
  const mayEdit = usePermission('settings.tax')

  const [rates, setRates] = useState<TaxRate[]>([...profile.taxRates])
  const [inclusive, setInclusive] = useState(profile.pricesIncludeTax)

  const save = useMutation({
    mutationFn: () => settings.updateProfile({ taxRates: rates, pricesIncludeTax: inclusive }),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      toast.show({ tone: 'success', title: 'Tax settings saved' })
    },
  })

  const dirty =
    inclusive !== profile.pricesIncludeTax ||
    JSON.stringify(rates) !== JSON.stringify(profile.taxRates)

  return (
    <div className="flex flex-col gap-5">
      <Card padded={false}>
        <CardHeader
          className="p-5"
          title="Rates"
          description="What can be applied to a line. The default is used for anything new."
        />
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>Label</Th>
                <Th numeric>Rate</Th>
                <Th>Default</Th>
              </tr>
            </thead>
            <tbody>
              {rates.map((rate) => (
                <Tr key={rate.id}>
                  <Td>
                    <Input
                      aria-label={`Label for ${rate.label}`}
                      value={rate.label}
                      disabled={!mayEdit}
                      onChange={(event) =>
                        setRates((entries) =>
                          entries.map((entry) =>
                            entry.id === rate.id ? { ...entry, label: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </Td>
                  <Td numeric className="w-32">
                    <Input
                      aria-label={`Rate for ${rate.label}`}
                      numeric
                      inputMode="decimal"
                      suffix="%"
                      disabled={!mayEdit}
                      value={String(rate.basisPoints / 100)}
                      onChange={(event) =>
                        setRates((entries) =>
                          entries.map((entry) =>
                            entry.id === rate.id
                              ? { ...entry, basisPoints: Math.round(Number(event.target.value) * 100) || 0 }
                              : entry,
                          ),
                        )
                      }
                    />
                  </Td>
                  <Td>
                    {rate.isDefault ? (
                      <Badge tone="accent">Default</Badge>
                    ) : mayEdit ? (
                      <button
                        type="button"
                        onClick={() =>
                          setRates((entries) =>
                            entries.map((entry) => ({ ...entry, isDefault: entry.id === rate.id })),
                          )
                        }
                        className="text-sm font-medium text-accent-text underline-offset-4 hover:underline"
                      >
                        Make default
                      </button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        <p className="flex items-start gap-2 border-t border-border p-4 text-sm text-text-muted">
          <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
          Changing a rate does not touch documents already issued. A receipt from last year
          re-renders at the rate that applied then, which is what makes it defensible.
        </p>
      </Card>

      <Card>
        <CardHeader title="How prices are quoted" />
        <div className="mt-4">
          <Switch
            checked={inclusive}
            onChange={setInclusive}
            disabled={!mayEdit}
            label="Prices already include tax"
            description="Shelf and menu prices usually do. Trade price lists usually do not."
          />
        </div>
        {inclusive !== profile.pricesIncludeTax && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-text-muted">
            <Icon name="TriangleAlert" size="sm" className="mt-0.5 shrink-0 text-warning-text" />
            This changes what every existing price means. Nothing on screen will look different,
            but what you are charging moves by the tax rate. Change your prices too, or change
            this back.
          </p>
        )}
      </Card>

      {mayEdit && (
        <div className="flex items-center gap-3">
          <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
            Save changes
          </Button>
          {dirty && <span className="text-sm text-text-subtle">You have unsaved changes.</span>}
        </div>
      )}
    </div>
  )
}
