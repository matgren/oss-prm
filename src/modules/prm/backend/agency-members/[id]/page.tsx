'use client'
import * as React from 'react'
import { useParams } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'

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
        <CrudForm<UpdateValues>
          schema={updateSchema}
          fields={[
            { id: 'firstName', label: t('prm.members.fields.firstName', 'First name'), type: 'text', required: true, layout: 'half' },
            { id: 'lastName', label: t('prm.members.fields.lastName', 'Last name'), type: 'text', required: true, layout: 'half' },
            { id: 'roleInAgency', label: t('prm.members.fields.roleInAgency', 'Role in agency'), type: 'text' },
            { id: 'githubProfile', label: t('prm.members.fields.gh', 'GitHub handle'), type: 'text' },
            { id: 'isActive', label: t('prm.members.fields.active', 'Active'), type: 'checkbox' },
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
            flash(t('prm.members.detail.flash.saved', 'Member saved.'), 'success')
            await load()
          }}
        />
      </PageBody>
    </Page>
  )
}

// Metadata lives in `page.meta.ts`.
