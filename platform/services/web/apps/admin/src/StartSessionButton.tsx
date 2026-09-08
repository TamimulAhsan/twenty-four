import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  adminKeys,
  adminSessions,
  type ImpersonationMode,
  type TenantSummary,
} from '@twentyfour/api'
import { Button, useToast } from '@twentyfour/ui'
import { ReasonDialog, errorMessage } from './common'

/**
 * Opening a support session on one tenant.
 *
 * Always read-only from here, whatever the role allows. Write access is a
 * second, deliberate step taken from the session bar once the specialist has
 * seen the problem, because the reason for writing is never known before you
 * have looked, and a reason given in advance is a reason invented in advance.
 */
export function StartSessionButton({
  tenant,
  mode = 'read',
  label = 'Watch',
  variant = 'outline',
}: {
  tenant: Pick<TenantSummary, 'tenantId' | 'name'>
  mode?: ImpersonationMode
  label?: string
  variant?: 'outline' | 'ghost' | 'primary'
}) {
  const [asking, setAsking] = useState(false)
  const queryClient = useQueryClient()
  const toast = useToast()

  const start = useMutation({
    mutationFn: (reason: string) =>
      adminSessions.start({ tenantId: tenant.tenantId, mode, reason }),
    onSuccess: () => {
      setAsking(false)
      void queryClient.invalidateQueries({ queryKey: adminKeys.sessions() })
      void queryClient.invalidateQueries({ queryKey: adminKeys.audit() })
      toast.show({
        tone: 'success',
        title: `Watching ${tenant.name}`,
        description: 'The token is read-only and expires on its own.',
      })
    },
    onError: (error) =>
      toast.show({
        tone: 'danger',
        title: 'No session opened',
        description: errorMessage(error),
      }),
  })

  return (
    <>
      <Button size="sm" variant={variant} iconStart="Eye" onClick={() => setAsking(true)}>
        {label}
      </Button>
      <ReasonDialog
        open={asking}
        title={`Watch ${tenant.name}`}
        description={
          <>
            A read-only token, scoped to this one tenant and expiring on a timer. It lets you open
            their dashboard and see what they see. It does not let you change anything.
          </>
        }
        confirmLabel="Start"
        pending={start.isPending}
        onConfirm={(reason) => start.mutate(reason)}
        onClose={() => setAsking(false)}
      />
    </>
  )
}
