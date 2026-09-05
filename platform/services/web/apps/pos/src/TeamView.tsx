import { PageBody } from '@twentyfour/ui'
import { TeamList } from '@twentyfour/shell'

export function TeamView() {
  return (
    <PageBody scroll>
        <TeamList purpose="Whoever is signed in is who a sale is attributed to. Someone without access cannot be put against one." />
    </PageBody>
  )
}
