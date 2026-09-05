import { useNavigate } from 'react-router'
import { Button, EmptyState } from '@twentyfour/ui'

export function NotFound() {
  const navigate = useNavigate()
  return (
    <EmptyState
      icon="Search"
      title="That page does not exist"
      description="The link may be old, or the module it belonged to may not be on your plan."
      action={<Button onClick={() => navigate('/')}>Back to today</Button>}
      className="mt-10"
    />
  )
}
