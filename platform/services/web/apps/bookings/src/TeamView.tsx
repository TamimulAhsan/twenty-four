import { TeamList } from '@twentyfour/shell'
import { useTerms } from '@twentyfour/terms'
import { PageBody } from '@twentyfour/ui'

export function TeamView() {
  const terms = useTerms()
  return (
    <PageBody scroll>
        <TeamList
          purpose={`Only someone who can sign in gets a column on the calendar. A withdrawn account keeps its past ${terms.t('booking', { plural: true, case: 'lower' })} and stops taking new ones.`}
        />
    </PageBody>
  )
}
