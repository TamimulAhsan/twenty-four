import { useQuery } from '@tanstack/react-query'
import { adminKeys, adminPlatform } from '@twentyfour/api'
import {
  Badge,
  Card,
  ErrorState,
  Icon,
  PageHeader,
  Skeleton,
  Table,
  TableScroll,
  Td,
  Th,
  Tr,
  cn,
  useDateFormat,
} from '@twentyfour/ui'
import { ROLE_LABELS, Preamble, Section, errorMessage } from '../common'

/**
 * Who can see every merchant, and what each of them may do.
 *
 * The second factor is a column rather than a tick, because "MFA on" is not
 * the useful fact: a passkey and an SMS code are both MFA and are not the same
 * assurance. An account with none is shown in red rather than omitted, since
 * the gateway is already refusing it and the gap is the point.
 */
export function TeamPage() {
  const staff = useQuery({ queryKey: adminKeys.staff(), queryFn: adminPlatform.staff })
  const roles = useQuery({ queryKey: adminKeys.roles(), queryFn: adminPlatform.roles })
  const dates = useDateFormat()

  if (staff.isError || roles.isError) {
    return (
      <ErrorState
        title="The team did not load"
        description={errorMessage(staff.error ?? roles.error)}
        onRetry={() => {
          void staff.refetch()
          void roles.refetch()
        }}
      />
    )
  }

  const missingMfa = (staff.data ?? []).filter((member) => member.mfa === null).length

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Team and roles"
        description="Accounts on the admin plane. These are not merchant staff and never appear in a merchant's account."
      />

      {missingMfa > 0 && (
        <Preamble>
          {missingMfa === 1 ? 'One account has' : `${missingMfa} accounts have`} no second factor
          enrolled. The gateway refuses them, so this is a person who cannot sign in rather than a
          way in.
        </Preamble>
      )}

      <Section title="People">
        {staff.isPending ? (
          <Skeleton className="h-64" />
        ) : (
          <Card padded={false}>
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Role</Th>
                    <Th>Second factor</Th>
                    <Th>Last seen</Th>
                    <Th numeric>Sessions, 30 days</Th>
                  </tr>
                </thead>
                <tbody>
                  {(staff.data ?? []).map((member) => (
                    <Tr key={member.staffId}>
                      <Td>
                        <p className="font-medium text-text">{member.name}</p>
                        <p className="text-xs text-text-subtle">{member.email}</p>
                      </Td>
                      <Td>
                        <Badge tone={member.role === 'platform_admin' ? 'accent' : 'neutral'}>
                          {ROLE_LABELS[member.role]}
                        </Badge>
                      </Td>
                      <Td>
                        {member.mfa === null ? (
                          <span className="flex items-center gap-1.5 text-sm text-danger-text">
                            <Icon name="AlertCircle" size="sm" />
                            Not enrolled
                          </span>
                        ) : (
                          <span className="text-sm text-text-muted">{member.mfa}</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-text-muted">
                        {member.lastSeenAt ? dates.dateTime(member.lastSeenAt) : 'never'}
                      </Td>
                      <Td numeric>{member.impersonations}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          </Card>
        )}
      </Section>

      <Section
        title="What each role may do"
        description="Enforced at the admin gateway on every call. Hiding a screen is not what stops anybody."
      >
        {roles.isPending ? (
          <Skeleton className="h-64" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(roles.data ?? []).map((role) => (
              <Card key={role.id}>
                <p className="text-md font-semibold text-text">{role.name}</p>
                <p className="mt-1.5 text-base text-text-muted">{role.summary}</p>
                <p
                  className={cn(
                    'mt-4 flex items-start gap-2 border-t border-border pt-3 text-sm',
                    role.impersonation === null
                      ? 'text-success-text'
                      : role.impersonation === 'write'
                        ? 'text-danger-text'
                        : 'text-warning-text',
                  )}
                >
                  <Icon
                    name={role.impersonation === null ? 'ShieldCheck' : 'KeyRound'}
                    size="sm"
                    className="mt-0.5 shrink-0"
                  />
                  {role.impersonationNote}
                </p>
              </Card>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
