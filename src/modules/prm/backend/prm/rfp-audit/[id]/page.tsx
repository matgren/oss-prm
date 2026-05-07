'use client'
import * as React from 'react'
import { useParams } from 'next/navigation'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

type AuditRow = {
  broadcast_id: string
  agency_id: string
  agency_name: string | null
  broadcast_at: string
  first_opened_at: string | null
  declined_at: string | null
  declined_reason: string | null
  response_status: string
  final_outcome: 'selected' | 'not_selected' | 'no_decision'
}

type ListResponse = {
  ok: true
  items: AuditRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/**
 * B11 — RFP Broadcasts Audit (Spec #6 §3.6).
 *
 * OM PartnerOps read-only audit of a single RFP's broadcast set. Shows
 * per-Agency timing, response status, and final outcome.
 */
export default function RfpAuditPage() {
  const t = useT()
  const params = useParams()
  const rfpId = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? params.id[0] : ''

  const [items, setItems] = React.useState<AuditRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(50)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)

  const load = React.useCallback(async () => {
    if (!rfpId) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      const res = await apiCall<ListResponse>(`/api/prm/rfp/${rfpId}/broadcasts?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.rfpAudit.error.loadFailed', 'Failed to load broadcast audit'))
      }
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.rfpAudit.error.loadFailed', 'Failed to load broadcast audit'),
      )
    } finally {
      setLoading(false)
    }
  }, [rfpId, page, pageSize, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const columns = React.useMemo<ColumnDef<AuditRow>[]>(
    () => [
      {
        accessorKey: 'agency_name',
        header: t('prm.rfpAudit.col.agency', 'Agency'),
        cell: ({ row }) => row.original.agency_name ?? row.original.agency_id,
      },
      {
        accessorKey: 'broadcast_at',
        header: t('prm.rfpAudit.col.broadcastAt', 'Broadcast at'),
        cell: ({ row }) => new Date(row.original.broadcast_at).toLocaleString(),
      },
      {
        accessorKey: 'first_opened_at',
        header: t('prm.rfpAudit.col.firstOpenedAt', 'First opened'),
        cell: ({ row }) =>
          row.original.first_opened_at ? new Date(row.original.first_opened_at).toLocaleString() : '—',
      },
      {
        accessorKey: 'declined_at',
        header: t('prm.rfpAudit.col.declinedAt', 'Declined'),
        cell: ({ row }) => {
          if (!row.original.declined_at) return '—'
          const when = new Date(row.original.declined_at).toLocaleString()
          return row.original.declined_reason ? `${when} — ${row.original.declined_reason}` : when
        },
      },
      {
        accessorKey: 'response_status',
        header: t('prm.rfpAudit.col.responseStatus', 'Response status'),
      },
      {
        accessorKey: 'final_outcome',
        header: t('prm.rfpAudit.col.finalOutcome', 'Final outcome'),
      },
    ],
    [t],
  )

  return (
    <Page>
      <PageHeader title={t('prm.rfpAudit.title', 'RFP Broadcasts Audit')} />
      <PageBody>
        {loading && <LoadingMessage label={t('common.loading', 'Loading…')} />}
        {error && <ErrorMessage label={error} />}
        {!loading && !error && (
          <DataTable
            data={items}
            columns={columns}
            pagination={{
              page,
              pageSize,
              total,
              totalPages,
              onPageChange: (p: number) => setPage(p),
              onPageSizeChange: (s: number) => {
                setPageSize(s)
                setPage(1)
              },
            }}
          />
        )}
      </PageBody>
    </Page>
  )
}
