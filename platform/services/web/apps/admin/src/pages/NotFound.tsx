import { useNavigate } from 'react-router'
import { Button, EmptyState } from '@twentyfour/ui'

export function NotFound() {
  const navigate = useNavigate()
  return (
    <EmptyState
      icon="Search"
      title="Nothing at that address"
      description="The link may be from an older build of the console, or the tenant it named has been offboarded."
      action={<Button onClick={() => navigate('/')}>Back to the tenant list</Button>}
      className="mt-10"
    />
  )
}
