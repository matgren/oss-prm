'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { Button } from '@open-mercato/ui/primitives/button'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT, type TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'

type AgencyDetail = {
  id: string
  name: string
  slug: string
  description: string | null
  websiteUrl: string | null
  logoUrl: string | null
  headquartersCountry: string
  headquartersCity: string | null
  teamSizeBucket: string | null
  industries: string[]
  services: string[]
  techCapabilities: string[]
  tier: string
  status: string
  contractSigned: boolean
  ndaSigned: boolean
  onboarded: boolean
  createdAt: string
  updatedAt: string
}

type AgencyMember = {
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

const updateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(8000).nullable().optional(),
  websiteUrl: z.string().url().max(500).nullable().optional().or(z.literal('')),
  logoUrl: z.string().max(2000).nullable().optional().or(z.literal('')),
  headquartersCountry: z.string().length(2).regex(/^[A-Z]{2}$/),
  headquartersCity: z.string().max(120).nullable().optional().or(z.literal('')),
  teamSizeBucket: z.enum(['1-5', '6-20', '21-50', '51-100', '100+']).nullable().optional(),
  tier: z.enum(['om_agency', 'ai_native', 'ai_native_expert', 'ai_native_core']),
  status: z.enum(['active', 'historical']),
  contractSigned: z.boolean(),
  ndaSigned: z.boolean(),
  onboarded: z.boolean(),
})

type UpdateValues = z.infer<typeof updateSchema>

const inviteSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email(),
  githubProfile: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/)
    .optional()
    .or(z.literal('')),
  roleSlug: z.enum(['partner_admin', 'partner_member']),
})

type InviteValues = z.infer<typeof inviteSchema>

export default function AgencyDetailPage() {
  const t = useT()
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const agencyId = String(params?.id ?? '')
  const [agency, setAgency] = React.useState<AgencyDetail | null>(null)
  const [members, setMembers] = React.useState<AgencyMember[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<'profile' | 'members'>('profile')

  const loadAgency = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall<{ ok: true; agency: AgencyDetail }>(`/api/prm/agency/${agencyId}`)
      if (!res.ok || !res.result?.ok) {
        setError('Agency not found')
        setAgency(null)
        return
      }
      setAgency(res.result.agency)
      const mres = await apiCall<{ ok: true; items: AgencyMember[] }>(`/api/prm/agency/${agencyId}/member`)
      if (mres.ok && mres.result?.ok) {
        setMembers(mres.result.items)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [agencyId])

  React.useEffect(() => {
    if (agencyId) void loadAgency()
  }, [agencyId, loadAgency])

  if (loading) return <LoadingMessage label={t('prm.agencies.detail.loading', 'Loading agency…')} />
  if (error || !agency) return <ErrorMessage label={error ?? t('prm.agencies.detail.notFound', 'Agency not found')} />

  return (
    <Page>
      <PageHeader
        title={agency.name}
        description={t('prm.agencies.detail.subtitle', 'Slug: {slug} · Tier: {tier} · Status: {status}', {
          slug: agency.slug,
          tier: agency.tier,
          status: agency.status,
        })}
        actions={
          <Button asChild type="button" variant="outline">
            <Link href="/backend/prm">{t('prm.agencies.detail.back', 'Back to list')}</Link>
          </Button>
        }
      />
      <PageBody>
        <div className="border-b">
          <nav className="flex gap-1">
            <button
              type="button"
              className={`border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === 'profile' ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground'
              }`}
              onClick={() => setTab('profile')}
            >
              {t('prm.agencies.tab.profile', 'Profile')}
            </button>
            <button
              type="button"
              className={`border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === 'members' ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground'
              }`}
              onClick={() => setTab('members')}
            >
              {t('prm.agencies.tab.members', 'Members')} ({members.length})
            </button>
          </nav>
        </div>

        {tab === 'profile' ? (
          <CrudForm<UpdateValues>
            schema={updateSchema}
            fields={[
              { id: 'name', label: t('prm.agencies.fields.name', 'Name'), type: 'text', required: true },
              { id: 'description', label: t('prm.agencies.fields.description', 'Description'), type: 'textarea' },
              { id: 'websiteUrl', label: t('prm.agencies.fields.website', 'Website URL'), type: 'text' },
              { id: 'logoUrl', label: t('prm.agencies.fields.logo', 'Logo URL'), type: 'text' },
              { id: 'headquartersCountry', label: t('prm.agencies.fields.country', 'Country'), type: 'text', required: true, layout: 'half' },
              { id: 'headquartersCity', label: t('prm.agencies.fields.city', 'City'), type: 'text', layout: 'half' },
              {
                id: 'teamSizeBucket',
                label: t('prm.agencies.fields.teamSize', 'Team size'),
                type: 'select',
                options: [
                  { value: '1-5', label: '1-5' },
                  { value: '6-20', label: '6-20' },
                  { value: '21-50', label: '21-50' },
                  { value: '51-100', label: '51-100' },
                  { value: '100+', label: '100+' },
                ],
              },
              {
                id: 'tier',
                label: t('prm.agencies.fields.tier', 'Tier (admin-only)'),
                type: 'select',
                options: [
                  { value: 'om_agency', label: 'OM Agency' },
                  { value: 'ai_native', label: 'AI Native' },
                  { value: 'ai_native_expert', label: 'AI Native Expert' },
                  { value: 'ai_native_core', label: 'AI Native Core' },
                ],
                description: t('prm.agencies.fields.tier.help', 'Admin-only — controls Marketing visibility and tier widgets.'),
              },
              {
                id: 'status',
                label: t('prm.agencies.fields.status', 'Status (admin-only)'),
                type: 'select',
                options: [
                  { value: 'active', label: 'Active' },
                  { value: 'historical', label: 'Historical' },
                ],
              },
              { id: 'contractSigned', label: t('prm.agencies.fields.contract', 'Contract signed (admin-only)'), type: 'checkbox' },
              { id: 'ndaSigned', label: t('prm.agencies.fields.nda', 'NDA signed (admin-only)'), type: 'checkbox' },
              { id: 'onboarded', label: t('prm.agencies.fields.onboarded', 'Onboarded (admin-only)'), type: 'checkbox' },
            ]}
            initialValues={{
              name: agency.name,
              description: agency.description ?? '',
              websiteUrl: agency.websiteUrl ?? '',
              logoUrl: agency.logoUrl ?? '',
              headquartersCountry: agency.headquartersCountry,
              headquartersCity: agency.headquartersCity ?? '',
              teamSizeBucket: (agency.teamSizeBucket ?? '') as any,
              tier: agency.tier as any,
              status: agency.status as any,
              contractSigned: agency.contractSigned,
              ndaSigned: agency.ndaSigned,
              onboarded: agency.onboarded,
            }}
            cancelHref="/backend/prm"
            onSubmit={async (values) => {
              await apiCallOrThrow(
                `/api/prm/agency/${agencyId}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ...values,
                    description: values.description || null,
                    websiteUrl: values.websiteUrl || null,
                    logoUrl: values.logoUrl || null,
                    headquartersCity: values.headquartersCity || null,
                    teamSizeBucket: values.teamSizeBucket || null,
                    headquartersCountry: values.headquartersCountry.toUpperCase(),
                  }),
                },
                { errorMessage: t('prm.agencies.detail.flash.error', 'Save failed.') },
              )
              flash(t('prm.agencies.detail.flash.saved', 'Agency saved.'), 'success')
              await loadAgency()
            }}
          />
        ) : (
          <MembersTab agencyId={agencyId} members={members} reload={loadAgency} t={t} />
        )}
      </PageBody>
    </Page>
  )
}

function MembersTab({
  agencyId,
  members,
  reload,
  t,
}: {
  agencyId: string
  members: AgencyMember[]
  reload: () => Promise<void>
  t: TranslateFn
}) {
  const [showInvite, setShowInvite] = React.useState(false)
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t('prm.agencies.members.title', 'Members')}</h2>
        <Button type="button" onClick={() => setShowInvite((s) => !s)}>
          {showInvite ? t('prm.agencies.members.hideInvite', 'Hide invite form') : t('prm.agencies.members.invite', 'Invite member')}
        </Button>
      </div>
      {showInvite ? (
        <div className="rounded-lg border p-4">
          <CrudForm<InviteValues>
            schema={inviteSchema}
            fields={[
              { id: 'firstName', label: t('prm.agencies.invite.firstName', 'First name'), type: 'text', required: true, layout: 'half' },
              { id: 'lastName', label: t('prm.agencies.invite.lastName', 'Last name'), type: 'text', required: true, layout: 'half' },
              { id: 'email', label: t('prm.agencies.invite.email', 'Email'), type: 'text', required: true, layout: 'half' },
              { id: 'githubProfile', label: t('prm.agencies.invite.gh', 'GitHub handle (optional)'), type: 'text', layout: 'half' },
              {
                id: 'roleSlug',
                label: t('prm.agencies.invite.role', 'Role'),
                type: 'select',
                required: true,
                options: [
                  { value: 'partner_admin', label: 'Partner Admin' },
                  { value: 'partner_member', label: 'Partner Member' },
                ],
                defaultValue: 'partner_admin',
              },
            ]}
            submitLabel={t('prm.agencies.invite.submit', 'Send invite')}
            onSubmit={async (values) => {
              await apiCallOrThrow(
                `/api/prm/agency/${agencyId}/invite`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ...values,
                    githubProfile: values.githubProfile || null,
                  }),
                },
                { errorMessage: t('prm.agencies.invite.flash.error', 'Invite failed.') },
              )
              flash(t('prm.agencies.invite.flash.sent', 'Invitation sent.'), 'success')
              setShowInvite(false)
              await reload()
            }}
          />
        </div>
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
                  <Link href={`/backend/prm/agency-members/${m.id}`} className="underline-offset-2 hover:underline">
                    {m.firstName} {m.lastName}
                  </Link>
                </td>
                <td className="px-3 py-2">{m.email}</td>
                <td className="px-3 py-2">{m.roleSlug}</td>
                <td className="px-3 py-2">
                  {!m.isActive ? 'Deactivated' : !m.activatedAt ? 'Invited' : 'Active'}
                </td>
                <td className="px-3 py-2">{m.githubProfile ?? '—'}</td>
              </tr>
            ))}
            {members.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  {t('prm.agencies.members.empty', 'No members yet.')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Metadata lives in `page.meta.ts`.
