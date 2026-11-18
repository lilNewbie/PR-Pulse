import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, useNavigate } from 'react-router-dom'
import MyPRs from './pages/MyPRs'
import ReviewQueue from './pages/ReviewQueue'
import TeamRepos from './pages/TeamRepos'
import Deployments from './pages/Deployments'
import DeploymentDetail from './pages/DeploymentDetail'
import Expertise from './pages/Expertise'
import Team, { TeamNavLink } from './pages/Team'

// Loaded on demand so the chart library isn't in the bundle for every other page.
const Insights = lazy(() => import('./pages/Insights'))
import SignIn from './pages/SignIn'
import { useMe } from './hooks/useMe'
import { apiFetch } from './api/client'

function NavUser() {
  const me = useMe()
  const navigate = useNavigate()

  if (me.status !== 'ok') return null

  async function signOut() {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {})
    navigate('/signin')
  }

  return (
    <div className="nav-user">
      <span className="nav-login">{me.me.login}</span>
      <button className="btn-signout" onClick={signOut}>Sign out</button>
    </div>
  )
}

function DeploymentsNavLink() {
  const me = useMe()
  if (me.status !== 'ok' || me.me.role !== 'lead') return null
  return (
    <NavLink to="/deployments" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
      Deployments
    </NavLink>
  )
}

function NoReposNotice() {
  const me = useMe()
  if (me.status !== 'ok' || me.me.repos.length > 0) return null
  return <p className="no-repos-notice">No connected repositories you can access</p>
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
              <nav className="nav">
                <a href="/" className="nav-logo">
                  <span className="nav-logo-dot" />
                  PR Pulse
                </a>
                <div className="nav-links">
                  <NavLink to="/my-prs" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                    My PRs
                  </NavLink>
                  <NavLink to="/queue" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                    Review Queue
                  </NavLink>
                  <NavLink to="/repos" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                    Team Repos
                  </NavLink>
                  <NavLink to="/expertise" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                    Expertise
                  </NavLink>
                  <NavLink to="/insights" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                    Insights
                  </NavLink>
                  <DeploymentsNavLink />
                  <TeamNavLink />
                </div>
                <NavUser />
              </nav>
              <main className="page">
                <NoReposNotice />
                <Routes>
                  <Route path="/" element={<MyPRs />} />
                  <Route path="/my-prs" element={<MyPRs />} />
                  <Route path="/queue" element={<ReviewQueue />} />
                  <Route path="/repos" element={<TeamRepos />} />
                  <Route path="/deployments" element={<Deployments />} />
                  <Route path="/deployments/:id" element={<DeploymentDetail />} />
                  <Route path="/expertise" element={<Expertise />} />
                  <Route path="/team" element={<Team />} />
                  <Route
                    path="/insights"
                    element={
                      <Suspense fallback={<p className="text-muted">Loading…</p>}>
                        <Insights />
                      </Suspense>
                    }
                  />
                </Routes>
              </main>
            </>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
