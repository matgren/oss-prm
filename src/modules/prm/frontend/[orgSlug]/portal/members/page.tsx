'use client'
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { PartnerStatusBanner } from '../_components/PartnerStatusBanner'
import { extractPrmErrorMessage } from '../../../../lib/errors'

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

/**
 * Inline confirm dialog matching the backend variant (`backend/prm/agency-members/[id]/confirmDialog.tsx`).
 * Kept inline here because it's the only consumer in the portal area and we
 * want to keep portal pages self-contained per OM customer-portal conventions.
 */
function classifyDialogKey(event: { key: string; metaKey?: boolean; ctrlKey?: boolean }): 'submit' | 'cancel' | 'none' {
  if (event.key === 'Escape') return 'cancel'
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') return 'submit'
  return 'none'
}

type DeactivateConfirmProps = {
  open: boolean
  busy: boolean
  copy: { title: string; body: string; cancel: string; confirm: string; saving: string }
  onConfirm: () => void
  onCancel: () => void
}

function DeactivateConfirmDialog({ open, busy, copy, onConfirm, onCancel }: DeactivateConfirmProps) {
  const confirmRef = React.useRef<HTMLButtonElement | null>(null)
  React.useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => confirmRef.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [open])
  if (!open) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      data-testid="portal-member-deactivate-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(e) => {
        const intent = classifyDialogKey(e)
        if (intent === 'cancel') {
          e.preventDefault()
          onCancel()
        } else if (intent === 'submit') {
          e.preventDefault()
          if (!busy) onConfirm()
        }
      }}
    >
      <div className="w-full max-w-md rounded-md border bg-card p-4 shadow-lg">
        <h3 className="mb-2 text-sm font-semibold">{copy.title}</h3>
        <p className="mb-4 text-sm text-muted-foreground">{copy.body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {copy.cancel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (!busy) onConfirm()
            }}
          >
            {busy ? copy.saving : copy.confirm}
          </Button>
        </div>
      </div>
    </div>
  )
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
  const [pendingDeactivate, setPendingDeactivate] = React.useState<Member | null>(null)
  const [busyMemberId, setBusyMemberId] = React.useState<string | null>(null)

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
      flash(extractPrmErrorMessage(err, t('prm.portal.members.inviteError', 'Invite failed.')), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const patchMemberActive = React.useCallback(
    async (member: Member, nextActive: boolean) => {
      if (!agencyId) return
      setBusyMemberId(member.id)
      try {
        await apiCallOrThrow(`/api/prm/portal/agency/${agencyId}/member/${member.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: nextActive }),
        })
        flash(
          nextActive
            ? t('prm.portal.members.flash.reactivated', 'Member reactivated — portal access restored.')
            : t('prm.portal.members.flash.deactivated', 'Member deactivated — portal access revoked.'),
          'success',
        )
        await load()
      } catch (err) {
        flash(
          extractPrmErrorMessage(err, t('prm.portal.members.flash.error', 'Update failed.')),
          'error',
        )
      } finally {
        setBusyMemberId(null)
      }
    },
    [agencyId, t, load],
  )

  const resendMemberInvite = React.useCallback(
    async (member: Member) => {
      if (!agencyId) return
      setBusyMemberId(member.id)
      try {
        await apiCallOrThrow(
          `/api/prm/portal/agency/${agencyId}/member/${member.id}/resend-invite`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        )
        flash(t('prm.portal.members.flash.resent', 'Invitation resent.'), 'success')
        await load()
      } catch (err) {
        flash(
          extractPrmErrorMessage(err, t('prm.portal.members.flash.error', 'Update failed.')),
          'error',
        )
      } finally {
        setBusyMemberId(null)
      }
    },
    [agencyId, t, load],
  )

  const canManage = (m: Member): boolean => {
    if (!isPartnerAdmin) return false
    if (!me) return false
    if (m.id === me.id) return false // partner_admin cannot deactivate self
    if (m.roleSlug !== 'partner_member') return false // portal can only manage partner_member rows
    if (agencyStatus !== 'active') return false // historical agency = no member mgmt
    return true
  }

  const deactivateCopy = {
    title: t('prm.portal.members.deactivate.title', 'Deactivate member?'),
    body: t(
      'prm.portal.members.deactivate.body',
      'This will revoke their portal access immediately and sign them out of all sessions. They will not be able to log in until reactivated.',
    ),
    cancel: t('prm.portal.members.deactivate.cancel', 'Cancel'),
    confirm: t('prm.portal.members.deactivate.confirm', 'Deactivate'),
    saving: t('prm.portal.members.deactivate.saving', 'Deactivating…'),
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
        {isPartnerAdmin && !showInvite ? (
          <Button type="button" onClick={() => setShowInvite(true)}>
            {t('prm.portal.members.invite', 'Invite member')}
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
              <th className="px-3 py-2 text-left font-medium">{t('prm.portal.members.col.name', 'Name')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('prm.portal.members.col.email', 'Email')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('prm.portal.members.col.role', 'Role')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('prm.portal.members.col.state', 'State')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('prm.portal.members.col.gh', 'GitHub')}</th>
              {isPartnerAdmin ? (
                <th className="px-3 py-2 text-left font-medium">
                  {t('prm.portal.members.col.actions', 'Actions')}
                </th>
              ) : null}
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
                <td className="px-3 py-2">
                  {!m.isActive
                    ? t('prm.portal.members.state.deactivated', 'Deactivated')
                    : !m.activatedAt
                      ? t('prm.portal.members.state.invited', 'Invited')
                      : t('prm.portal.members.state.active', 'Active')}
                </td>
                <td className="px-3 py-2">{m.githubProfile ?? '—'}</td>
                {isPartnerAdmin ? (
                  <td className="px-3 py-2">
                    {canManage(m) ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {m.isActive && !m.activatedAt ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busyMemberId === m.id}
                            onClick={() => void resendMemberInvite(m)}
                          >
                            {busyMemberId === m.id
                              ? t('prm.portal.members.action.resending', 'Resending…')
                              : t('prm.portal.members.action.resend', 'Resend invite')}
                          </Button>
                        ) : null}
                        {m.isActive ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={busyMemberId === m.id}
                            onClick={() => setPendingDeactivate(m)}
                          >
                            {t('prm.portal.members.action.deactivate', 'Deactivate')}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busyMemberId === m.id}
                            onClick={() => void patchMemberActive(m, true)}
                          >
                            {busyMemberId === m.id
                              ? t('prm.portal.members.action.reactivating', 'Reactivating…')
                              : t('prm.portal.members.action.reactivate', 'Reactivate')}
                          </Button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
            {members.length === 0 ? (
              <tr>
                <td colSpan={isPartnerAdmin ? 6 : 5} className="px-3 py-6 text-center text-muted-foreground">
                  {t('prm.portal.members.empty', 'No members yet.')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <DeactivateConfirmDialog
        open={pendingDeactivate !== null}
        busy={busyMemberId === pendingDeactivate?.id}
        copy={deactivateCopy}
        onConfirm={async () => {
          if (!pendingDeactivate) return
          await patchMemberActive(pendingDeactivate, false)
          setPendingDeactivate(null)
        }}
        onCancel={() => setPendingDeactivate(null)}
      />
    </div>
  )
}
