import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  Dictionary,
  DictionaryEntry,
} from '@open-mercato/core/modules/dictionaries/data/entities'
import { resolveDictionariesRouteContext } from '@open-mercato/core/modules/dictionaries/api/context'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type {
  OpenApiMethodDoc,
  OpenApiRouteDoc,
} from '@open-mercato/shared/lib/openapi'

/**
 * Backend-staff read-only access to PRM dictionaries (topics, industries,
 * services, technologies). Powers the `TagsInput` pickers on the backend
 * Marketing Materials new/edit forms (mirror of the portal-scoped sibling at
 * `src/modules/prm/api/portal/dictionaries/[key]/entries/route.ts`).
 *
 * Whitelisted to PRM dictionary keys only — staff must NOT pull arbitrary
 * tenant dictionaries through this surface (use core's `[dictionaryId]`
 * routes for cross-module dictionary management).
 *
 * Response shape matches the portal route (`{ ok, items: [{value, label}] }`)
 * so the form contract stays uniform across portal and backend consumers.
 */

const PRM_DICTIONARY_KEYS = ['topics', 'industries', 'services', 'technologies'] as const

const paramsSchema = z.object({ key: z.enum(PRM_DICTIONARY_KEYS) })

export const metadata = {
  GET: {
    requireAuth: true,
    requireFeatures: ['prm.marketing_material.write'],
  },
}

export async function GET(
  req: Request,
  ctx: { params?: { key?: string } },
): Promise<Response> {
  const parsed = paramsSchema.safeParse({ key: ctx.params?.key })
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Unknown dictionary' },
      { status: 404 },
    )
  }

  let context: Awaited<ReturnType<typeof resolveDictionariesRouteContext>>
  try {
    context = await resolveDictionariesRouteContext(req)
  } catch (err) {
    if (err instanceof CrudHttpError) {
      return NextResponse.json({ ok: false, ...err.body }, { status: err.status })
    }
    throw err
  }

  const dictionary = await context.em.findOne(Dictionary, {
    tenantId: context.tenantId,
    organizationId: context.organizationId,
    key: parsed.data.key,
    deletedAt: null,
  } as any)
  if (!dictionary) {
    return NextResponse.json({ ok: true, items: [] })
  }

  const entries = await context.em.find(
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
  tags: ['PRM Backend'],
  summary: 'Backend dictionary entries (whitelisted PRM keys)',
  description:
    'Returns dictionary entries (value + label) for a whitelisted PRM dictionary (topics, industries, services, technologies). Scoped to the caller\'s tenant + organization via staff auth. Mirrors the portal route — staff and partners get the same shape.',
  responses: [
    { status: 200, description: 'List of entries', schema: responseSchema },
  ],
  errors: [
    { status: 401, description: 'Unauthorized', schema: errorSchema },
    { status: 403, description: 'Missing prm.marketing_material.write', schema: errorSchema },
    { status: 404, description: 'Unknown dictionary key', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Backend dictionary entries',
  methods: { GET: getDoc },
}
