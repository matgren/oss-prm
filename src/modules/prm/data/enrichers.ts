import type { ResponseEnricher } from '@open-mercato/shared/lib/crud/response-enricher'
import type { Agency } from './entities'

/**
 * Portal-side admin-only field block for `prm.agency`.
 *
 * Enricher gated on the `prm.agency.read_admin_fields` feature (OQ-020).
 * One block under `_prm` — never per-field. Absent block = caller lacks the feature.
 *
 * The enricher is mounted on the *PRM-owned* portal route handler (single source of truth);
 * we don't enrich `customers.customer` or any other foreign entity.
 */
type AgencyRecord = Record<string, unknown> & { id: string } & Partial<
  Pick<
    Agency,
    'tier' | 'status' | 'contractSigned' | 'ndaSigned' | 'onboarded'
  >
>

type PrmEnrichment = {
  _prm: {
    tier: string
    status: string
    contractSigned: boolean
    ndaSigned: boolean
    onboarded: boolean
  }
}

const portalAdminFieldsEnricher: ResponseEnricher<AgencyRecord, PrmEnrichment> = {
  id: 'prm.portal-agency-admin-fields',
  targetEntity: 'prm.agency',
  features: ['prm.agency.read_admin_fields'],
  priority: 50,
  timeout: 1500,
  fallback: undefined,
  critical: false,

  async enrichOne(record) {
    return {
      ...record,
      _prm: {
        tier: String(record.tier ?? 'om_agency'),
        status: String(record.status ?? 'active'),
        contractSigned: Boolean(record.contractSigned),
        ndaSigned: Boolean(record.ndaSigned),
        onboarded: Boolean(record.onboarded),
      },
    }
  },

  async enrichMany(records) {
    return records.map((record) => ({
      ...record,
      _prm: {
        tier: String(record.tier ?? 'om_agency'),
        status: String(record.status ?? 'active'),
        contractSigned: Boolean(record.contractSigned),
        ndaSigned: Boolean(record.ndaSigned),
        onboarded: Boolean(record.onboarded),
      },
    }))
  },
}

export const enrichers: ResponseEnricher[] = [portalAdminFieldsEnricher]

export default enrichers
