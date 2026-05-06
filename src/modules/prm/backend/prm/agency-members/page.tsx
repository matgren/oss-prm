'use client'
import * as React from 'react'
import Link from 'next/link'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

type MemberRow = {
  id: string
  agencyId: string
  agencyName?: string
  email: string
  firstName: string
  lastName: string
  roleSlug: string
  isActive: boolean
  githubProfile: string | null
  invitedAt: string
  activatedAt: string | null
  agencyStatus: string
}

type ListResponse = {
  ok: true
  items: MemberRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export default function CrossAgencyMembersPage() {
  const t = useT()
  const [items, setItems] = React.useState<MemberRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(50)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [q, setQ] = React.useState('')
  const [githubProfile, setGithubProfile] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (q.trim()) params.set('q', q.trim())
      if (githubProfile.trim()) params.set('githubProfile', githubProfile.trim())
      const res = await apiCall<ListResponse>(`/api/prm/agency-member?${params.toString()}`)
      if (!res.ok || !res.result?.ok) throw new Error('Failed to load members')
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, q, githubProfile])

  React.useEffect(() => {
    void load()
  }, [load])

  const columns = React.useMemo<ColumnDef<MemberRow>[]>(
    () => [
      {
        id: 'name',
        header: t('prm.members.col.name', 'Name'),
        cell: ({ row }) => (
          <Link className="underline-offset-2 hover:underline" href={`/backend/prm/agency-members/${row.original.id}`}>
            {row.original.firstName} {row.original.lastName}
          </Link>
        ),
      },
      { id: 'email', header: t('prm.members.col.email', 'Email'), accessorKey: 'email' },
      {
        id: 'agency',
        header: t('prm.members.col.agency', 'Agency'),
        cell: ({ row }) => (
          <Link href={`/backend/prm/${row.original.agencyId}`} className="underline-offset-2 hover:underline">
            {row.original.agencyName ?? row.original.agencyId.slice(0, 8)}
          </Link>
        ),
      },
      { id: 'roleSlug', header: t('prm.members.col.role', 'Role'), accessorKey: 'roleSlug' },
      { id: 'agencyStatus', header: t('prm.members.col.agencyStatus', 'Agency status'), accessorKey: 'agencyStatus' },
      {
        id: 'state',
        header: t('prm.members.col.state', 'State'),
        cell: ({ row }) => (!row.original.isActive ? 'Deactivated' : !row.original.activatedAt ? 'Invited' : 'Active'),
      },
      { id: 'githubProfile', header: t('prm.members.col.gh', 'GitHub'), accessorKey: 'githubProfile' },
    ],
    [t],
  )

  return (
    <Page>
      <PageHeader
        title={t('prm.members.title', 'Agency Members')}
        description={t('prm.members.description', 'Cross-agency, read-only — use for GitHub-handle conflict diagnostics.')}
      />
      <PageBody>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('prm.members.filter.q', 'Search')}</span>
            <Input
              type="search"
              className="h-8"
              placeholder="Name or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(1)
                  void load()
                }
              }}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('prm.members.filter.gh', 'GitHub handle exact')}</span>
            <Input
              type="text"
              className="h-8"
              placeholder="alice"
              value={githubProfile}
              onChange={(e) => setGithubProfile(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(1)
                  void load()
                }
              }}
            />
          </label>
          <Button type="button" variant="outline" onClick={() => void load()}>
            {t('prm.members.filter.apply', 'Apply')}
          </Button>
        </div>
        <DataTable<MemberRow>
          entityId="prm.agency_member"
          columns={columns}
          data={items}
          isLoading={loading}
          error={error}
          pagination={{
            page,
            pageSize,
            total,
            totalPages,
            onPageChange: (next) => setPage(next),
            onPageSizeChange: (size) => {
              setPageSize(size)
              setPage(1)
            },
            pageSizeOptions: [25, 50, 100],
          }}
        />
      </PageBody>
    </Page>
  )
}

// Metadata lives in `page.meta.ts`.
