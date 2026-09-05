import { useBootstrap } from '@twentyfour/runtime'
import { useTerms } from '@twentyfour/terms'
import { PageBody, Badge, Card, CardHeader, Icon, Table, TableScroll, Td, Th, Tr } from '@twentyfour/ui'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The rules behind the calendar.
 *
 * Opening hours decide which slots the grid will even offer, so they belong
 * beside it rather than three clicks away in the dashboard's settings.
 */
export function HoursView() {
  const terms = useTerms()
  const { profile } = useBootstrap()

  return (
    <PageBody scroll>
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_1fr]">
        <Card padded={false}>
          <CardHeader
            className="p-5"
            title="Opening hours"
            description="The outer limit for every slot the calendar will offer."
          />
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Day</Th>
                  <Th>Opens</Th>
                  <Th>Closes</Th>
                </tr>
              </thead>
              <tbody>
                {[...profile.openingHours]
                  .sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7))
                  .map((day) => (
                    <Tr key={day.weekday}>
                      <Td className="font-medium">{WEEKDAYS[day.weekday]}</Td>
                      <Td className="tnum text-text-muted">{day.opens ?? '—'}</Td>
                      <Td className="tnum text-text-muted">
                        {day.closes ?? <Badge tone="neutral">Closed</Badge>}
                      </Td>
                    </Tr>
                  ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>

        <div className="flex flex-col gap-5">
        <Card className="border-accent-border bg-accent-subtle">
          <div className="flex gap-3">
            <Icon name="ShieldCheck" size="lg" className="mt-0.5 shrink-0 text-accent-text" />
            <div>
              <p className="text-base font-medium text-text">
                Two people can take the same slot. One person cannot.
              </p>
              <p className="mt-0.5 text-base text-text-muted">
                The calendar refuses a second {terms.t('booking', { case: 'lower' })} against
                someone who is already busy, whichever screen it was made from. That refusal comes
                from the server, so it holds even if two people book at the same moment.
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex gap-3">
            <Icon name="Clock" size="lg" className="mt-0.5 shrink-0 text-text-subtle" />
            <div>
              <p className="text-base font-medium text-text">Buffers and deposits</p>
              <p className="mt-0.5 text-base text-text-muted">
                Turnaround time between {terms.t('booking', { plural: true, case: 'lower' })} and
                deposit rules are set per {terms.t('catalog_item', { case: 'lower' })}, so a long
                treatment can hold a longer gap than a short one.
              </p>
            </div>
          </div>
        </Card>
        </div>
      </div>
    </PageBody>
  )
}
