import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'

/**
 * Portal-scoped read-only access to PRM dictionaries (topics, industries,
 * services, technologies). Used by `TagsInput` pickers in the partner portal.
 *
 * Whitelisted to PRM dictionary keys only — partners must NOT see arbitrary
 * tenant dictionaries through this surface.
 */

const PRM_DICTIONARY_KEYS = ['topics', 'industries', 'services', 'technologies'] as const
type PrmDictionaryKey = typeof PRM_DICTIONARY_KEYS[number]

function isPrmDictionaryKey(value: string): value is PrmDictionaryKey {
  return (PRM_DICTIONARY_KEYS as readonly string[]).includes(value)
}

const paramsSchema = z.object({ key: z.enum(PRM_DICTIONARY_KEYS) })

export const metadata = {
  GET: { requireAuth: false },
}

export async function GET(
  req: Request,
  ctx: { params?: { key?: string } },
) {
  let auth
  try {
    auth = await requireCustomerAuth(req)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const rawKey = ctx.params?.key
  if (typeof rawKey !== 'string' || !isPrmDictionaryKey(rawKey)) {
    return NextResponse.json({ ok: false, error: 'Unknown dictionary' }, { status: 404 })
  }
  const parsed = paramsSchema.safeParse({ key: rawKey })
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Invalid dictionary key' }, { status: 400 })
  }

  const container = await createRequestContainer()
  const rbac = container.resolve('customerRbacService') as CustomerRbacService
  try {
    await requireCustomerFeature(auth, ['portal.partner.access'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const em = container.resolve('em') as EntityManager
  const dictionary = await em.findOne(Dictionary, {
    tenantId: auth.tenantId,
    organizationId: auth.orgId,
    key: parsed.data.key,
    deletedAt: null,
  } as any)
  if (!dictionary) {
    return NextResponse.json({ ok: true, items: [] })
  }

  const entries = await em.find(
    DictionaryEntry,
    {
      dictionary,
      tenantId: dictionary.tenantId,
      organizationId: dictionary.organizationId,
    } as any,
    { orderBy: { label: 'asc' } },
  )

  return NextResponse.json({
    ok: true,
    items: entries.map((entry) => ({
      value: String(entry.value),
      label: String(entry.label ?? entry.value),
    })),
  })
}

const responseSchema = z.object({
  ok: z.literal(true),
  items: z.array(
    z.object({
      value: z.string(),
      label: z.string(),
    }),
  ),
})

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

const getDoc: OpenApiMethodDoc = {
  tags: ['PRM Portal'],
  summary: 'Portal dictionary entries',
  description:
    'Returns dictionary entries (value + label) for a whitelisted PRM dictionary (topics, industries, services, technologies). Scoped to the caller\'s tenant + organization via portal auth.',
  responses: [
    { status: 200, description: 'List of entries', schema: responseSchema },
  ],
  errors: [
    { status: 400, description: 'Invalid dictionary key', schema: errorSchema },
    { status: 401, description: 'Missing customer auth', schema: errorSchema },
    { status: 403, description: 'Customer lacks portal.partner.access', schema: errorSchema },
    { status: 404, description: 'Unknown dictionary key', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal dictionary entries',
  methods: { GET: getDoc },
}
