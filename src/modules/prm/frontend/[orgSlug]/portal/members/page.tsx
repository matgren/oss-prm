'use client'
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { PartnerStatusBanner } from '../_components/PartnerStatusBanner'

type Member = {
  id: string
  email: string
  firstName: string
  lastName: string
  roleSlug: string
  isActive: boolean
  invitedAt: string
  activatedAt: string | null
  customerUserId: string | null
  githubProfile: string | null
}

type Me = {
  ok: true
  member: Member | null
  agency: { id: string; name: string; slug: string; status: string } | null
}

export default function PortalMembersPage() {
  const t = useT()
  const [agencyId, setAgencyId] = React.useState<string | null>(null)
  const [agencyStatus, setAgencyStatus] = React.useState<string>('active')
  const [me, setMe] = React.useState<Member | null>(null)
  const [members, setMembers] = React.useState<Member[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [showInvite, setShowInvite] = React.useState(false)
  const [invite, setInvite] = React.useState({ firstName: '', lastName: '', email: '', githubProfile: '' })
  const [submitting, setSubmitting] = React.useState(false)

  const isPartnerAdmin = me?.roleSlug === 'partner_admin'

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const meRes = await apiCall<Me>('/api/prm/portal/me')
      if (!meRes.ok || !meRes.result?.ok || !meRes.result.agency || !meRes.result.member) {
        setError(t('prm.portal.members.notLinked', 'Your account is not linked to an agency.'))
        return
      }
      const aid = meRes.result.agency.id
      setAgencyId(aid)
      setAgencyStatus(meRes.result.agency.status)
      setMe(meRes.result.member)
      const list = await apiCall<{ ok: true; items: Member[] }>(`/api/prm/portal/agency/${aid}/member`)
      if (list.ok && list.result?.ok) setMembers(list.result.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  const onInviteSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!agencyId) return
    setSubmitting(true)
    try {
      await apiCallOrThrow(`/api/prm/portal/agency/${agencyId}/member`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...invite,
          githubProfile: invite.githubProfile || null,
        }),
      })
      flash(t('prm.portal.members.inviteSent', 'Invitation sent.'), 'success')
      setInvite({ firstName: '', lastName: '', email: '', githubProfile: '' })
      setShowInvite(false)
      await load()
    } catch (err) {
      flash(err instanceof Error ? err.message : t('prm.portal.members.inviteError', 'Invite failed.'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingMessage label={t('prm.portal.members.loading', 'Loading…')} />
  if (error) return <ErrorMessage label={error} />

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <PartnerStatusBanner
        status={agencyStatus}
        t={t}
        messageKey="prm.portal.members.banner.historical"
        message="Your partnership is historical — member management is paused."
      />
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('prm.portal.members.title', 'Members')}</h1>
        {isPartnerAdmin ? (
          <Button type="button" onClick={() => setShowInvite((s) => !s)}>
            {showInvite ? t('prm.portal.members.hideInvite', 'Hide form') : t('prm.portal.members.invite', 'Invite member')}
          </Button>
        ) : null}
      </header>
      {showInvite && isPartnerAdmin ? (
        <form
          className="grid grid-cols-1 gap-3 rounded-md border p-4 md:grid-cols-2"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setShowInvite(false)
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              ;(e.currentTarget as HTMLFormElement).requestSubmit()
            }
          }}
          onSubmit={onInviteSubmit}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('prm.portal.members.firstName', 'First name')}</span>
            <Input
              value={invite.firstName}
              required
              onChange={(e) => setInvite((s) => ({ ...s, firstName: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('prm.portal.members.lastName', 'Last name')}</span>
            <Input
              value={invite.lastName}
              required
              onChange={(e) => setInvite((s) => ({ ...s, lastName: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="text-muted-foreground">{t('prm.portal.members.email', 'Email')}</span>
            <Input
              type="email"
              value={invite.email}
              required
              onChange={(e) => setInvite((s) => ({ ...s, email: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="text-muted-foreground">{t('prm.portal.members.gh', 'GitHub handle (optional)')}</span>
            <Input
              value={invite.githubProfile}
              onChange={(e) => setInvite((s) => ({ ...s, githubProfile: e.target.value }))}
            />
          </label>
          <div className="md:col-span-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setShowInvite(false)}>
              {t('prm.portal.members.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={submitting || agencyStatus !== 'active'}>
              {submitting ? t('prm.portal.members.sending', 'Sending…') : t('prm.portal.members.send', 'Send invite')}
            </Button>
          </div>
        </form>
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-left font-medium">Email</th>
              <th className="px-3 py-2 text-left font-medium">Role</th>
              <th className="px-3 py-2 text-left font-medium">State</th>
              <th className="px-3 py-2 text-left font-medium">GitHub</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-t">
                <td className="px-3 py-2">
                  {m.firstName} {m.lastName}
                  {m.id === me?.id ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
                </td>
                <td className="px-3 py-2">{m.email}</td>
                <td className="px-3 py-2">{m.roleSlug}</td>
                <td className="px-3 py-2">{!m.isActive ? 'Deactivated' : !m.activatedAt ? 'Invited' : 'Active'}</td>
                <td className="px-3 py-2">{m.githubProfile ?? '—'}</td>
              </tr>
            ))}
            {members.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  {t('prm.portal.members.empty', 'No members yet.')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
