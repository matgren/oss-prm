'use client'

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'

type AcceptResponse =
  | { ok: true }
  | { ok: false; error?: string; details?: Record<string, string[]> }

export default function AcceptInvitationPage() {
  const [token, setToken] = React.useState<string | null>(null)
  const [orgSlug, setOrgSlug] = React.useState<string>('')
  const [displayName, setDisplayName] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const url = new URL(window.location.href)
    const t = url.searchParams.get('token')
    setToken(t && t.length > 0 ? t : null)
    const segments = url.pathname.split('/').filter(Boolean)
    setOrgSlug(segments[0] ?? '')
  }, [])

  const handleSubmit = React.useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    if (!token) {
      setError('Missing or invalid invitation token.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (!displayName.trim()) {
      setError('Please enter your display name.')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/customer_accounts/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password, displayName: displayName.trim() }),
      })
      const data = (await res.json().catch(() => null)) as AcceptResponse | null
      if (!res.ok || !data || data.ok !== true) {
        const message =
          (data && 'error' in data && typeof data.error === 'string' && data.error) ||
          'Invalid or expired invitation.'
        setError(message)
        return
      }
      const redirect = orgSlug ? `/${orgSlug}/portal/dashboard` : '/'
      window.location.assign(redirect)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setSubmitting(false)
    }
  }, [confirm, displayName, orgSlug, password, token])

  if (token === null) {
    return null
  }

  if (!token) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center justify-center px-4">
        <div className="w-full rounded-xl border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">Invitation link is invalid</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The link you followed is missing a token. Please check the email and try again.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full space-y-5 rounded-xl border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-foreground">Accept your invitation</h1>
          <p className="text-sm text-muted-foreground">
            Set a password and your display name to finish onboarding.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-foreground">Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            required
            className="w-full rounded border bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-foreground">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            className="w-full rounded border bg-background px-3 py-2 text-sm"
          />
          <span className="text-xs text-muted-foreground">At least 8 characters.</span>
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-foreground">Confirm password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            className="w-full rounded border bg-background px-3 py-2 text-sm"
          />
        </label>

        {error ? (
          <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Accepting…' : 'Accept invitation'}
        </Button>
      </form>
    </div>
  )
}
