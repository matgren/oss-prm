'use client'
import * as React from 'react'
import Link from 'next/link'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { PortalEmptyState } from '@open-mercato/ui/portal/components/PortalEmptyState'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

type ProspectRow = {
  id: string
  agencyId: string
  organizationId: string
  companyName: string
  contactName: string
  contactEmail: string
  source: 'agency_owned' | 'event' | 'other'
  status: 'new' | 'qualified' | 'contacted' | 'won' | 'lost' | 'dormant'
  lostReason: string | null
  notes: string | null
  registeredAt: string
  statusChangedAt: string
  registeredByAgencyMemberId: string
  canEdit: boolean
  canTransitionTo: string[]
}

type ListResponse = {
  ok: true
  items: ProspectRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const SOURCE_OPTIONS = [
  { value: '', labelKey: 'prm.portal.prospects.filter.source.all', label: 'All sources' },
  { value: 'agency_owned', labelKey: 'prm.portal.prospects.source.agency_owned', label: 'Agency-owned' },
  { value: 'event', labelKey: 'prm.portal.prospects.source.event', label: 'Event' },
  { value: 'other', labelKey: 'prm.portal.prospects.source.other', label: 'Other' },
] as const

const STATUS_OPTIONS = [
  { value: '', labelKey: 'prm.portal.prospects.filter.status.all', label: 'All statuses' },
  { value: 'new', labelKey: 'prm.portal.prospects.status.new', label: 'New' },
  { value: 'qualified', labelKey: 'prm.portal.prospects.status.qualified', label: 'Qualified' },
  { value: 'contacted', labelKey: 'prm.portal.prospects.status.contacted', label: 'Contacted' },
  { value: 'won', labelKey: 'prm.portal.prospects.status.won', label: 'Won' },
  { value: 'lost', labelKey: 'prm.portal.prospects.status.lost', label: 'Lost' },
  { value: 'dormant', labelKey: 'prm.portal.prospects.status.dormant', label: 'Dormant' },
] as const

/**
 * P5 — Portal Prospects list (Spec #2 §2 — wip-scoreboard).
 *
 * Per OQ-010: custom React, no DataTable. Filters: status, source, registered_month.
 * Quick-action transitions are wired through P6 (detail page), not from this list,
 * because every transition requires the optimistic-concurrency token.
 */
export default function PortalProspectsListPage() {
  const t = useT()
  const [items, setItems] = React.useState<ProspectRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize] = React.useState(25)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [status, setStatus] = React.useState('')
  const [source, setSource] = React.useState('')
  const [registeredMonth, setRegisteredMonth] = React.useState('')
  const [showRegister, setShowRegister] = React.useState(false)
  const [register, setRegister] = React.useState({
    companyName: '',
    contactName: '',
    contactEmail: '',
    source: 'agency_owned',
    notes: '',
  })
  const [submitting, setSubmitting] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (status) params.set('status', status)
      if (source) params.set('source', source)
      if (registeredMonth) params.set('registeredMonth', registeredMonth)
      const res = await apiCall<ListResponse>(`/api/prm/portal/prospects?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error('Failed to load prospects')
      }
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prospects')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, status, source, registeredMonth])

  React.useEffect(() => {
    void load()
  }, [load])

  const onRegister = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      await apiCallOrThrow('/api/prm/portal/prospects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: register.companyName.trim(),
          contactName: register.contactName.trim(),
          contactEmail: register.contactEmail.trim(),
          source: register.source,
          notes: register.notes.trim() ? register.notes.trim() : null,
        }),
      })
      flash(t('prm.portal.prospects.flash.registered', 'Prospect registered.'), 'success')
      setRegister({ companyName: '', contactName: '', contactEmail: '', source: 'agency_owned', notes: '' })
      setShowRegister(false)
      setPage(1)
      await load()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : t('prm.portal.prospects.flash.registerError', 'Could not register prospect.'),
        'error',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('prm.portal.prospects.title', 'Prospects')}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              'prm.portal.prospects.subtitle',
              'Track companies you have introduced to Open Mercato. New registrations appear in the WIP widget.',
            )}
          </p>
        </div>
        <Button type="button" onClick={() => setShowRegister((s) => !s)}>
          {showRegister
            ? t('prm.portal.prospects.hideRegister', 'Hide form')
            : t('prm.portal.prospects.register', 'Register prospect')}
        </Button>
      </header>

      {showRegister ? (
        <form
          className="grid grid-cols-1 gap-3 rounded-md border p-4 md:grid-cols-2"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowRegister(false)
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              ;(e.currentTarget as HTMLFormElement).requestSubmit()
            }
          }}
          onSubmit={onRegister}
        >
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="text-muted-foreground">
              {t('prm.portal.prospects.fields.company', 'Company name')}
            </span>
            <Input
              value={register.companyName}
              required
              onChange={(e) => setRegister((r) => ({ ...r, companyName: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.portal.prospects.fields.contactName', 'Contact name')}
            </span>
            <Input
              value={register.contactName}
              required
              onChange={(e) => setRegister((r) => ({ ...r, contactName: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.portal.prospects.fields.contactEmail', 'Contact email')}
            </span>
            <Input
              type="email"
              value={register.contactEmail}
              required
              onChange={(e) => setRegister((r) => ({ ...r, contactEmail: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.portal.prospects.fields.source', 'Source')}
            </span>
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={register.source}
              onChange={(e) => setRegister((r) => ({ ...r, source: e.target.value }))}
            >
              {SOURCE_OPTIONS.filter((opt) => opt.value).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey, opt.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="text-muted-foreground">{t('prm.portal.prospects.fields.notes', 'Notes')}</span>
            <Textarea
              className="min-h-20"
              value={register.notes}
              onChange={(e) => setRegister((r) => ({ ...r, notes: e.target.value }))}
            />
          </label>
          <div className="md:col-span-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setShowRegister(false)}>
              {t('prm.portal.prospects.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? t('prm.portal.prospects.submitting', 'Saving…')
                : t('prm.portal.prospects.submit', 'Register')}
            </Button>
          </div>
        </form>
      ) : null}

      <section className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/20 p-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t('prm.portal.prospects.filter.status', 'Status')}</span>
          <select
            className="h-8 rounded-md border border-input bg-background px-2"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey, opt.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t('prm.portal.prospects.filter.source', 'Source')}</span>
          <select
            className="h-8 rounded-md border border-input bg-background px-2"
            value={source}
            onChange={(e) => {
              setSource(e.target.value)
              setPage(1)
            }}
          >
            {SOURCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey, opt.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {t('prm.portal.prospects.filter.month', 'Month (YYYY-MM)')}
          </span>
          <Input
            type="month"
            className="h-8"
            value={registeredMonth}
            onChange={(e) => {
              setRegisteredMonth(e.target.value)
              setPage(1)
            }}
          />
        </label>
      </section>

      {error ? <ErrorMessage label={error} /> : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-3 py-2 text-left font-medium">
                {t('prm.portal.prospects.col.company', 'Company')}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t('prm.portal.prospects.col.contact', 'Contact')}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t('prm.portal.prospects.col.status', 'Status')}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t('prm.portal.prospects.col.source', 'Source')}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t('prm.portal.prospects.col.registeredAt', 'Registered')}
              </th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  {t('prm.portal.prospects.loading', 'Loading…')}
                </td>
              </tr>
            ) : null}
            {items.map((p) => (
              <tr key={p.id} className="border-t hover:bg-muted/30">
                <td className="px-3 py-2 font-medium">
                  <Link className="underline-offset-2 hover:underline" href={`./prospects/${p.id}`}>
                    {p.companyName}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col">
                    <span>{p.contactName}</span>
                    <span className="text-xs text-muted-foreground">{p.contactEmail}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className="rounded-full border px-2 py-0.5 text-xs">{p.status}</span>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{p.source}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {new Date(p.registeredAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 text-right">
                  <Link
                    className="text-xs text-primary underline-offset-2 hover:underline"
                    href={`./prospects/${p.id}`}
                  >
                    {t('prm.portal.prospects.open', 'Open')}
                  </Link>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6">
                  <PortalEmptyState
                    title={t(
                      'prm.portal.prospects.empty.title',
                      'No prospects yet',
                    )}
                    description={t(
                      'prm.portal.prospects.empty.description',
                      'Register your first prospect above to start tracking companies you have introduced to Open Mercato. New registrations appear in the WIP widget.',
                    )}
                    action={
                      <Button type="button" size="sm" onClick={() => setShowRegister(true)}>
                        {t('prm.portal.prospects.empty.action', 'Register a prospect')}
                      </Button>
                    }
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t('prm.portal.prospects.pagination', 'Showing {count} of {total}', {
              count: items.length,
              total,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {t('prm.portal.prospects.prev', 'Previous')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t('prm.portal.prospects.next', 'Next')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
