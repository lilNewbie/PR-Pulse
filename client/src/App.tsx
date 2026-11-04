import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import MyPRs from './pages/MyPRs'
import ReviewQueue from './pages/ReviewQueue'
import TeamRepos from './pages/TeamRepos'
import SignIn from './pages/SignIn'
import { useMe } from './hooks/useMe'

// US-01 AC3: signed in, but none of the connected repos are visible to this user.
function NoReposNotice() {
  const me = useMe()
  if (me.status !== 'ok' || me.me.repos.length > 0) return null
  return <p>No connected repositories you can access</p>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route
          path="/*"
          element={
            <>
              <nav
                style={{ padding: '1rem', borderBottom: '1px solid #ccc', display: 'flex', gap: '1rem' }}
              >
                <NavLink to="/my-prs">My PRs</NavLink>
                <NavLink to="/queue">Review Queue</NavLink>
                <NavLink to="/repos">Team Repos</NavLink>
              </nav>
              <main style={{ padding: '1rem' }}>
                <NoReposNotice />
                <Routes>
                  <Route path="/" element={<MyPRs />} />
                  <Route path="/my-prs" element={<MyPRs />} />
                  <Route path="/queue" element={<ReviewQueue />} />
                  <Route path="/repos" element={<TeamRepos />} />
                </Routes>
              </main>
            </>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
