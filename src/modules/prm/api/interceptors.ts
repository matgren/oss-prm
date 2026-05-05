import type { ApiInterceptor } from '@open-mercato/shared/lib/crud/api-interceptor'
import { ADMIN_ONLY_AGENCY_FIELDS } from '../data/validators'
import { safeEmit } from '../lib/safeEmit'

/**
 * Portal-side guard enforcing invariant #6: admin-only fields on `prm.agency` cannot be
 * written via the portal route, regardless of the CustomerUser's role. This is the second
 * leg of the dual-enforcement pattern (the first leg is `acl` features on the backend
 * CrudForm).
 *
 * On rejection we emit `prm.agency.admin_field_access_rejected` for OM-staff observability.
 * The route handler also re-validates via `updateAgencyPortalSchema` (strict zod) — this
 * interceptor is the structural defence; the schema is the syntactic one.
 */
const adminOnlyFieldKeySet = new Set<string>(ADMIN_ONLY_AGENCY_FIELDS)

const portalAgencyAdminGuard: ApiInterceptor = {
  id: 'prm.portal-agency-admin-field-guard',
  targetRoute: 'prm/portal/agency',
  methods: ['PATCH', 'PUT'],
  priority: 100,
  async before(request, ctx) {
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: true }
    const offendingKeys: string[] = []
    for (const key of Object.keys(body as Record<string, unknown>)) {
      if (adminOnlyFieldKeySet.has(key)) offendingKeys.push(key)
    }
    if (offendingKeys.length === 0) return { ok: true }

    // Best-effort agency_id extraction from the URL — `prm/portal/agency/{id}` shape.
    let agencyId: string | null = null
    try {
      const url = new URL(request.url)
      const match = url.pathname.match(/\/agency\/([0-9a-f-]{36})/i)
      if (match) agencyId = match[1]
    } catch {
      // ignore
    }
    const customerUserId = (ctx as any)?.userId ?? null

    for (const field of offendingKeys) {
      await safeEmit(
        'prm.agency.admin_field_access_rejected',
        {
          agencyId,
          fieldName: field,
          customerUserId,
          attemptedAt: new Date().toISOString(),
        },
        { context: { agencyId, fieldName: field, customerUserId } },
      )
    }

    return {
      ok: false,
      statusCode: 403,
      message: `Field${offendingKeys.length > 1 ? 's' : ''} ${offendingKeys.join(', ')} can only be edited by OM staff.`,
      body: {
        ok: false,
        error: {
          code: 'admin_only_field',
          message: 'Admin-only field cannot be edited from the portal.',
          details: { fields: offendingKeys },
        },
      },
    }
  },
}

export const interceptors: ApiInterceptor[] = [portalAgencyAdminGuard]

export default interceptors
