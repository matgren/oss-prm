/**
 * Partner invite email dispatcher.
 *
 * v1 (per OQ-014) wraps `customer_accounts`'s outbound email infrastructure when present and
 * falls back to a structured logger entry otherwise. Bounce-webhook integration is deferred
 * to v2 — the surface here is intentionally narrow: send-or-log, no retry orchestration.
 *
 * The email body mirrors `PartnerInviteEmail.tsx` (server-renderable React-Email template).
 * The acceptance link points to `/{org_slug}/portal/invitations/accept?token=...` — the
 * standard `customer_accounts` accept route.
 */

import { renderPartnerInviteEmail } from './PartnerInviteEmail'

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
   * Override the canonical accept URL. When omitted the dispatcher reads
   * `PRM_PORTAL_BASE_URL` then falls back to `/portal/invitations/accept?token=...`.
   */
  acceptUrl?: string
}

const DEFAULT_PORTAL_PATH = '/portal/invitations/accept'

function resolveAcceptUrl(input: PartnerInviteEmailInput): string {
  if (input.acceptUrl) return input.acceptUrl
  const base = process.env.PRM_PORTAL_BASE_URL ?? process.env.NEXT_PUBLIC_PORTAL_URL ?? ''
  const path = `${DEFAULT_PORTAL_PATH}?token=${encodeURIComponent(input.rawToken)}`
  if (!base) return path
  const trimmed = base.replace(/\/$/, '')
  return `${trimmed}${path}`
}

export async function sendPartnerInviteEmail(input: PartnerInviteEmailInput): Promise<void> {
  const acceptUrl = resolveAcceptUrl(input)
  const html = renderPartnerInviteEmail({
    firstName: input.firstName,
    lastName: input.lastName,
    agencyName: input.agencyName,
    roleSlug: input.roleSlug,
    acceptUrl,
  })

  // Best-effort dispatch via the platform-standard email service when present.
  // The platform may register an `emailService` in DI; we resolve dynamically to keep
  // PRM decoupled from any specific provider package (Resend, Nodemailer, …).
  try {
    const containerMod: any = await import('@open-mercato/shared/lib/di/container').catch(() => null)
    const create = containerMod?.createRequestContainer
    if (typeof create === 'function') {
      const container = await create()
      const candidate = container?.resolve?.('emailService')
      if (candidate && typeof candidate.send === 'function') {
        await candidate.send({
          to: input.to,
          subject: `You're invited to join ${input.agencyName} on Open Mercato`,
          html,
          tags: {
            module: 'prm',
            kind: 'partner_invite',
            tenantId: input.tenantId,
            organizationId: input.organizationId,
          },
        })
        return
      }
    }
  } catch {
    // Fall through to console fallback.
  }

  // Structured fallback — captured by stdout sinks in dev / observability pipelines.
  // Never throw — invitation token is durable in the DB.
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
