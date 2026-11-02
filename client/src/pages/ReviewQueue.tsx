// Owned by Alan (days 3-4 for queue logic)
import { useNavigate } from 'react-router-dom'
import { useMe } from '../hooks/useMe'

export default function ReviewQueue() {
  const navigate = useNavigate()
  const me = useMe()

  if (me.status === 'loading') return <p>Loading…</p>

  if (me.status === 'unauthenticated') {
    navigate('/signin')
    return null
  }

  if (me.status === 'error') return <p>Error: {me.message}</p>

  if (me.me.repos.length === 0) {
    return <p>No connected repositories you can access.</p>
  }

  // TODO (Alan, days 3-4): render ranked queue
  return <div>Review Queue</div>
}
