import { useQuery } from '@tanstack/react-query'
import { adminKeys, adminTenants, type PlatformInvoice } from '@twentyfour/api'
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  MoneyText,
  Skeleton,
  Table,
  TableScroll,
  Td,
  Th,
  Tr,
  useDateFormat,
} from '@twentyfour/ui'
import { KeyValue, Section } from '../common'
import { useEnvironment } from '../session'
import { useTenant, useTenantId } from './useTenant'

/**
 * What this tenant pays us, and every document we issued them.
 *
 * The documents are immutable once issued. There is no edit control on this
 * page and there is not going to be one: a correction is a new document that
 * references the original, which is a thing the Invoicing service does, not a
 * thing a console does to a row.
 */
export function BillingTab() {
  const tenantId = useTenantId()
  const environment = useEnvironment()
  const tenant = useTenant()
  const dates = useDateFormat()

  const invoices = useQuery({
    queryKey: adminKeys.tenants.invoices(tenantId),
    queryFn: () => adminTenants.invoices(tenantId),
    enabled: tenantId.length > 0,
  })

  if (tenant.isPending || !tenant.data) return <Skeleton className="h-96" />

  const subscription = tenant.data.subscription
  // Nothing knows what a tenant is billed until Invoicing exists. Saying so
  // beats a card of blanks that reads like a tenant nobody has charged.
  if (!subscription) {
    return (
      <EmptyState
        icon="Wallet"
        title="Billing is not wired up yet"
        description="Subscriptions and the documents issued against them are owned by Invoicing, which is not built. Nothing else in the platform knows what this tenant pays."
      />
    )
  }

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card>
        <CardHeader title="Subscription" />
        <div className="mt-3">
          <KeyValue
            rows={[
              { key: 'Tier', value: subscription.tier },
              { key: 'Monthly', value: <MoneyText value={subscription.amount} /> },
              { key: 'Cycle', value: subscription.cycle },
              {
                key: 'Next charge',
                value: subscription.nextChargeAt
                  ? dates.date(subscription.nextChargeAt)
                  : 'not scheduled',
              },
              { key: 'Payment method', value: subscription.paymentMethod },
              {
                key: 'Being chased',
                value: subscription.dunningState ? (
                  <Badge tone="danger">{subscription.dunningState}</Badge>
                ) : (
                  <span className="text-text-subtle">no</span>
                ),
              },
              { key: 'Billed to date', value: <MoneyText value={subscription.lifetimeBilled} /> },
            ]}
          />
        </div>
      </Card>

      <Section
        title="Documents we issued them"
        description={`Immutable once issued. A correction is a new document that references the original, never an edit.`}
        className="lg:col-span-2"
      >
        {invoices.isPending ? (
          <Skeleton className="h-64" />
        ) : (invoices.data ?? []).length === 0 ? (
          <EmptyState
            icon="FileText"
            title="Nothing issued yet"
            description="Billing starts when the tenant goes live."
          />
        ) : (
          <Card padded={false}>
            <InvoiceTable rows={invoices.data ?? []} authority={environment.fiscalAuthority} />
          </Card>
        )}
      </Section>
    </div>
  )
}

function InvoiceTable({ rows, authority }: { rows: readonly PlatformInvoice[]; authority: string }) {
  const dates = useDateFormat()
  return (
    <TableScroll>
      <Table>
        <thead>
          <tr>
            <Th>Document</Th>
            <Th>Issued</Th>
            <Th>Period</Th>
            <Th>With the {authority.toLowerCase()}</Th>
            <Th>Status</Th>
            <Th numeric>Gross</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((invoice) => (
            <Tr key={invoice.number}>
              <Td>
                <span className="font-mono text-sm">{invoice.number}</span>
              </Td>
              <Td className="text-text-muted">{dates.date(invoice.issuedAt)}</Td>
              <Td className="text-text-muted">{invoice.period}</Td>
              <Td className="text-text-muted">{invoice.fiscalState}</Td>
              <Td>
                <Badge tone={invoice.status === 'paid' ? 'success' : invoice.status === 'failed' ? 'danger' : 'warning'}>
                  {invoice.status === 'paid' ? 'Paid' : invoice.status === 'failed' ? 'Failed' : 'Open'}
                </Badge>
              </Td>
              <Td numeric>
                <MoneyText value={invoice.gross} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  )
}
