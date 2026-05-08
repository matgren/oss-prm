/**
 * Partner invite email dispatcher.
 *
 * Routes through the platform-standard `sendEmail` helper
 * (`@open-mercato/shared/lib/email/send`), which delegates to Resend. When
 * `RESEND_API_KEY` is not configured, the helper throws and we fall back to
 * a structured stdout log so the raw token remains recoverable in dev.
 *
 * The acceptance link points to `/{org_slug}/portal/invitations/accept?token=...`
 * — portal pages are mounted under the org-slug segment, so the slug must be
 * resolved from the directory module.
 */

import { sendEmail } from '@open-mercato/shared/lib/email/send'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { PartnerInviteEmail } from './PartnerInviteEmail'

export type PartnerInviteEmailInput = {
  to: string
  firstName: string
  lastName: string
  rawToken: string
  tenantId: string
  organizationId: string
  agencyName: string
  roleSlug: string
  /**
   * Override the canonical accept URL. When omitted the dispatcher resolves
   * the organization slug and constructs the absolute URL from
   * `PRM_PORTAL_BASE_URL` → `NEXT_PUBLIC_PORTAL_URL` → `APP_URL` →
   * `NEXT_PUBLIC_APP_URL` → `http://localhost:3000`.
   */
  acceptUrl?: string
}

const ACCEPT_PATH_SUFFIX = '/portal/invitations/accept'

function resolveBaseUrl(): string {
  const candidates = [
    process.env.PRM_PORTAL_BASE_URL,
    process.env.NEXT_PUBLIC_PORTAL_URL,
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().replace(/\/$/, '')
    }
  }
  return 'http://localhost:3000'
}

async function resolveOrgSlug(organizationId: string): Promise<string | null> {
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const org = await em.findOne(Organization, { id: organizationId })
    const slug = org?.slug
    return typeof slug === 'string' && slug.length > 0 ? slug : null
  } catch {
    return null
  }
}

async function resolveAcceptUrl(input: PartnerInviteEmailInput): Promise<string> {
  if (input.acceptUrl) return input.acceptUrl
  const base = resolveBaseUrl()
  const slug = await resolveOrgSlug(input.organizationId)
  const slugSegment = slug ? `/${slug}` : ''
  return `${base}${slugSegment}${ACCEPT_PATH_SUFFIX}?token=${encodeURIComponent(input.rawToken)}`
}

export async function sendPartnerInviteEmail(input: PartnerInviteEmailInput): Promise<void> {
  const acceptUrl = await resolveAcceptUrl(input)
  const subject = `You're invited to join ${input.agencyName} on Open Mercato`

  try {
    await sendEmail({
      to: input.to,
      subject,
      react: PartnerInviteEmail({
        firstName: input.firstName,
        lastName: input.lastName,
        agencyName: input.agencyName,
        roleSlug: input.roleSlug,
        acceptUrl,
      }),
    })
    return
  } catch (error) {
    // Fall through to the stdout log so the raw token is still recoverable
    // in environments where Resend isn't configured (dev) or temporarily
    // failing. Never throw — invitation token is durable in the DB.
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[prm:email:partner_invite] sendEmail failed, falling back to log', { error: message })
  }

  console.info('[prm:email:partner_invite]', {
    to: input.to,
    agencyName: input.agencyName,
    roleSlug: input.roleSlug,
    acceptUrl,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
  })
}

export default sendPartnerInviteEmail
