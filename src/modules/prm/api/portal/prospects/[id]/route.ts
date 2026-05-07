import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { hasFeature } from '@open-mercato/shared/security/features'
import { updateProspectSchema } from '../../../../data/validators'
import type { AgencyMemberService } from '../../../../lib/agencyMemberService'
import type { ProspectService, ProspectActor } from '../../../../lib/prospectService'
import { PRM_ERROR_CODES, isPrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { summariseProspect } from '../route'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  GET: { requireAuth: false },
  PATCH: { requireAuth: false },
}

async function resolvePortalActor(
  req: Request,
  options: { id: string; requireFeature: string },
) {
  let auth
  try {
    auth = await requireCustomerAuth(req)
  } catch (resp) {
    if (resp instanceof Response) return { error: resp as Response, auth: null, container: null, actor: null, member: null }
    throw resp
  }
  const container = await createRequestContainer()
  const rbac = container.resolve('customerRbacService') as CustomerRbacService
  try {
    await requireCustomerFeature(auth, [options.requireFeature], rbac)
  } catch (resp) {
    if (resp instanceof Response) return { error: resp as Response, auth, container, actor: null, member: null }
    throw resp
  }
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    return {
      error: NextResponse.json(
        { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_MEMBER_NOT_FOUND, message: 'Not linked to an agency.' } },
        { status: 403 },
      ),
      auth,
      container,
      actor: null,
      member: null,
    }
  }
  const features = auth.resolvedFeatures
  const isPartnerAdmin = hasFeature(features, 'prm.prospect.transition_any_in_agency')
  const actor: ProspectActor = {
    type: 'customer_user',
    customerUserId: auth.sub,
    agencyMemberId: member.id,
    isPartnerAdmin,
  }
  return { error: null, auth, container, actor, member }
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid prospect id' }, { status: 400 })
  }
  const ctx = await resolvePortalActor(req, { id: params.id, requireFeature: 'prm.prospect.read_own_agency' })
  if (ctx.error) return ctx.error
  const { auth, container, actor, member } = ctx as Required<typeof ctx>

  const prospectService = container.resolve('prospectService') as ProspectService
  const prospect = await prospectService.findById(params.id, { tenantId: auth.tenantId })
  if (!prospect || prospect.agencyId !== member.agencyId) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.PROSPECT_NOT_FOUND, message: 'Prospect not found' } },
      { status: 404 },
    )
  }
  const features = auth.resolvedFeatures
  const canEdit =
    actor.isPartnerAdmin ||
    (hasFeature(features, 'prm.prospect.transition_own_authored') &&
      prospect.registeredByAgencyMemberId === member.id)
  return NextResponse.json({
    ok: true,
    prospect: summariseProspect(prospect, {
      canEdit,
      canTransitionTo: prospectService.computeAllowedTransitions(prospect, actor),
    }),
  })
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid prospect id' }, { status: 400 })
  }
  // The transition + edit features are checked downstream after we know which body kind arrived.
  const ctx = await resolvePortalActor(req, { id: params.id, requireFeature: 'prm.prospect.read_own_agency' })
  if (ctx.error) return ctx.error
  const { auth, container, actor, member } = ctx as Required<typeof ctx>

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  // Reject any payload carrying `registeredAt` or `registered_at` outright (invariant #1
  // belt-and-braces; the discriminated-union `.strict()` already does this on the edit
  // branch but we mirror the rejection at the route boundary for the transition branch
  // and any unknown shape).
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>
    if ('registeredAt' in obj || 'registered_at' in obj) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'registered_at_immutable',
            message: 'registered_at is immutable and cannot be modified.',
          },
        },
        { status: 400 },
      )
    }
  }

  const parsed = updateProspectSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const rbac = container.resolve('customerRbacService') as CustomerRbacService
  // The two branches require different features.
  if (parsed.data.kind === 'transition') {
    const requiredFeature = actor.isPartnerAdmin
      ? 'prm.prospect.transition_any_in_agency'
      : 'prm.prospect.transition_own_authored'
    try {
      await requireCustomerFeature(auth, [requiredFeature], rbac)
    } catch (resp) {
      if (resp instanceof Response) return resp
      throw resp
    }
  } else {
    // Edit also uses transition_own_authored / transition_any_in_agency as the gate
    // because edits go through the same author-scope check as transitions (invariant #12 C4).
    const requiredFeature = actor.isPartnerAdmin
      ? 'prm.prospect.transition_any_in_agency'
      : 'prm.prospect.transition_own_authored'
    try {
      await requireCustomerFeature(auth, [requiredFeature], rbac)
    } catch (resp) {
      if (resp instanceof Response) return resp
      throw resp
    }
  }

  const prospectService = container.resolve('prospectService') as ProspectService
  const existing = await prospectService.findById(params.id, { tenantId: auth.tenantId })
  if (!existing || existing.agencyId !== member.agencyId) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.PROSPECT_NOT_FOUND, message: 'Prospect not found' } },
      { status: 404 },
    )
  }

  try {
    if (parsed.data.kind === 'edit') {
      const { kind: _kind, ...patch } = parsed.data
      const { prospect, changedFields } = await prospectService.update(params.id, patch, {
        tenantId: auth.tenantId,
        actor,
      })
      return NextResponse.json({
        ok: true,
        prospect: summariseProspect(prospect, {
          canEdit: true,
          canTransitionTo: prospectService.computeAllowedTransitions(prospect, actor),
        }),
        changedFields,
      })
    }
    const transition = await prospectService.transitionStatus(
      params.id,
      {
        toStatus: parsed.data.toStatus,
        lostReason: parsed.data.lostReason ?? null,
        ifMatchStatusChangedAt: parsed.data.ifMatchStatusChangedAt,
        reason: 'portal_transition',
      },
      { tenantId: auth.tenantId, actor },
    )
    return NextResponse.json({
      ok: true,
      prospect: summariseProspect(transition, {
        canEdit: true,
        canTransitionTo: prospectService.computeAllowedTransitions(transition, actor),
      }),
    })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const okProspectSchema = z.object({
  ok: z.literal(true),
  prospect: z.record(z.string(), z.any()),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Read own-agency prospect (P6)',
  tags: ['PRM Portal'],
  responses: [{ status: 200, description: 'OK', schema: okProspectSchema }],
  errors: [
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Not linked', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
  ],
}

const patchDoc: OpenApiMethodDoc = {
  summary: 'Edit or transition prospect (P6 / US3.2)',
  tags: ['PRM Portal'],
  requestBody: { schema: updateProspectSchema, description: 'Edit or status-transition' },
  responses: [{ status: 200, description: 'OK', schema: okProspectSchema }],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden / author-scope / won-is-om-only', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
    { status: 409, description: 'Invalid transition / status conflict', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal prospect detail',
  description: 'Authenticated CustomerUser session — own-agency scoped, author-scoped writes.',
  methods: { GET: getDoc, PATCH: patchDoc },
}
