'use client'
import * as React from 'react'
import { useParams } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { Button } from '@open-mercato/ui/primitives/button'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { extractPrmErrorMessage } from '../../../../lib/errors'
import { ConfirmDialog, type ConfirmDialogCopy } from './confirmDialog'

type MemberDetail = {
  id: string
  agencyId: string
  email: string
  firstName: string
  lastName: string
  roleInAgency: string | null
  roleSlug: string
  isActive: boolean
  githubProfile: string | null
  customerUserId: string | null
  activatedAt: string | null
}

const updateSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  roleInAgency: z.string().max(120).optional().or(z.literal('')),
  githubProfile: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/)
    .optional()
    .or(z.literal('')),
  isActive: z.boolean(),
  roleSlug: z.enum(['partner_admin', 'partner_member']),
})

type UpdateValues = z.infer<typeof updateSchema>

export default function MemberEditPage() {
  const t = useT()
  const params = useParams<{ id: string }>()
  const memberId = String(params?.id ?? '')
  const [member, setMember] = React.useState<MemberDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [pendingDeactivate, setPendingDeactivate] = React.useState<UpdateValues | null>(null)
  const [submittingDeactivation, setSubmittingDeactivation] = React.useState(false)
  const [resendingInvite, setResendingInvite] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall<{ ok: true; agencyMember: MemberDetail }>(`/api/prm/agency-member/${memberId}`)
      if (!res.ok || !res.result?.ok) {
        setError('Member not found')
        return
      }
      setMember(res.result.agencyMember)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load member')
    } finally {
      setLoading(false)
    }
  }, [memberId])

  React.useEffect(() => {
    if (memberId) void load()
  }, [memberId, load])

  const persistChanges = React.useCallback(
    async (values: UpdateValues, wasDeactivation: boolean) => {
      await apiCallOrThrow(
        `/api/prm/agency-member/${memberId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...values,
            roleInAgency: values.roleInAgency || null,
            githubProfile: values.githubProfile || null,
          }),
        },
        { errorMessage: t('prm.members.detail.flash.error', 'Save failed.') },
      )
      const flashMsg = wasDeactivation
        ? t(
            'prm.members.detail.flash.deactivated',
            'Member deactivated — portal access revoked.',
          )
        : member && !member.isActive && values.isActive
          ? t(
              'prm.members.detail.flash.reactivated',
              'Member reactivated — portal access restored.',
            )
          : t('prm.members.detail.flash.saved', 'Member saved.')
      flash(flashMsg, 'success')
      await load()
    },
    [memberId, t, member, load],
  )

  const resendInvite = React.useCallback(async () => {
    if (!member) return
    setResendingInvite(true)
    try {
      await apiCallOrThrow(`/api/prm/agency-member/${member.id}/resend-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      flash(t('prm.members.detail.flash.resent', 'Invitation resent.'), 'success')
      await load()
    } catch (err) {
      flash(
        extractPrmErrorMessage(err, t('prm.members.detail.flash.error', 'Save failed.')),
        'error',
      )
    } finally {
      setResendingInvite(false)
    }
  }, [member, t, load])

  const confirmCopy: ConfirmDialogCopy = {
    title: t('prm.members.detail.deactivate.title', 'Deactivate member?'),
    body: t(
      'prm.members.detail.deactivate.body',
      'This will revoke their portal access immediately and sign them out of all sessions. They will not be able to log in until reactivated.',
    ),
    cancel: t('prm.members.detail.deactivate.cancel', 'Cancel'),
    confirm: t('prm.members.detail.deactivate.confirm', 'Deactivate'),
    saving: t('prm.members.detail.deactivate.saving', 'Deactivating…'),
  }

  if (loading) return <LoadingMessage label={t('prm.members.detail.loading', 'Loading member…')} />
  if (error || !member) return <ErrorMessage label={error ?? t('prm.members.detail.notFound', 'Member not found')} />

  return (
    <Page>
      <PageHeader
        title={`${member.firstName} ${member.lastName}`}
        description={t('prm.members.detail.subtitle', 'Email: {email} · Role: {role}', {
          email: member.email,
          role: member.roleSlug,
        })}
      />
      <PageBody>
        {member.isActive && !member.activatedAt ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-dashed bg-muted/40 px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              {t(
                'prm.members.detail.invitedHint',
                'This member has not accepted their invitation yet. Resending issues a fresh token and cancels the previous one.',
              )}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={resendingInvite}
              onClick={() => void resendInvite()}
            >
              {resendingInvite
                ? t('prm.members.detail.action.resending', 'Resending…')
                : t('prm.members.detail.action.resend', 'Resend invite')}
            </Button>
          </div>
        ) : null}
        <CrudForm<UpdateValues>
          schema={updateSchema}
          fields={[
            { id: 'firstName', label: t('prm.members.fields.firstName', 'First name'), type: 'text', required: true, layout: 'half' },
            { id: 'lastName', label: t('prm.members.fields.lastName', 'Last name'), type: 'text', required: true, layout: 'half' },
            { id: 'roleInAgency', label: t('prm.members.fields.roleInAgency', 'Role in agency'), type: 'text' },
            { id: 'githubProfile', label: t('prm.members.fields.gh', 'GitHub handle'), type: 'text' },
            {
              id: 'isActive',
              label: t('prm.members.fields.active', 'Active'),
              type: 'checkbox',
              description: t(
                'prm.members.fields.active.help',
                'Toggling off revokes portal access immediately and signs the member out of all sessions.',
              ),
            },
            {
              id: 'roleSlug',
              label: t('prm.members.fields.roleSlug', 'Portal role (lockout recovery)'),
              type: 'select',
              options: [
                { value: 'partner_admin', label: 'Partner Admin' },
                { value: 'partner_member', label: 'Partner Member' },
              ],
              description: t('prm.members.fields.roleSlug.help', 'Use to promote a Partner Member to Partner Admin (US1.6).'),
            },
          ]}
          initialValues={{
            firstName: member.firstName,
            lastName: member.lastName,
            roleInAgency: member.roleInAgency ?? '',
            githubProfile: member.githubProfile ?? '',
            isActive: member.isActive,
            roleSlug: member.roleSlug as any,
          }}
          cancelHref={`/backend/prm/${member.agencyId}`}
          backHref={`/backend/prm/${member.agencyId}`}
          onSubmit={async (values) => {
            const wasDeactivation = member.isActive && !values.isActive
            if (wasDeactivation) {
              setPendingDeactivate(values)
              return
            }
            await persistChanges(values, false)
          }}
        />
        <ConfirmDialog
          open={pendingDeactivate !== null}
          copy={confirmCopy}
          busy={submittingDeactivation}
          onConfirm={async () => {
            if (!pendingDeactivate) return
            setSubmittingDeactivation(true)
            try {
              await persistChanges(pendingDeactivate, true)
              setPendingDeactivate(null)
            } catch (err) {
              flash(
                err instanceof Error ? err.message : t('prm.members.detail.flash.error', 'Save failed.'),
                'error',
              )
            } finally {
              setSubmittingDeactivation(false)
            }
          }}
          onCancel={() => setPendingDeactivate(null)}
          testId="agency-member-deactivate-dialog"
        />
      </PageBody>
    </Page>
  )
}

// Metadata lives in `page.meta.ts`.
