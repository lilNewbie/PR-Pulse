import { useSearchParams } from 'react-router-dom'

export default function SignIn() {
  const [params] = useSearchParams()
  const cancelled = params.get('cancelled') === '1'

  return (
    <div style={{ maxWidth: 400, margin: '4rem auto', textAlign: 'center' }}>
      <h1>PR Pulse</h1>
      {cancelled && (
        <p style={{ color: '#c00' }}>Sign-in was cancelled.</p>
      )}
      <a href="/auth/github/login">
        <button type="button">Sign in with GitHub</button>
      </a>
    </div>
  )
}
