import { Card, Eyebrow, Icon, PageHeader } from '@twentyfour/ui'

/**
 * A route that exists but is not built yet.
 *
 * Named and dated rather than hidden. A nav item that goes nowhere is worse
 * than one that says when it arrives, and hiding it would mean the sidebar no
 * longer matches the entitlement record.
 */
export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} />
      <Card className="flex flex-col items-center gap-3 py-16 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-surface-sunken text-text-subtle">
          <Icon name="Clock" size="lg" />
        </span>
        <Eyebrow>Phase {phase}</Eyebrow>
        <p className="max-w-sm text-base text-text-muted">
          This screen is scheduled for phase {phase}. The route, the navigation entry and the
          entitlement check are already in place, so it appears here exactly when it is built.
        </p>
      </Card>
    </div>
  )
}
