/**
 * Partner invite email body.
 *
 * Plain HTML rendering keeps the template framework-agnostic — `react-email` renders are
 * available via the platform when present, but the fallback string-template path below
 * is sufficient for the v1 send-or-log scenario (OQ-014).
 */

export type PartnerInviteEmailProps = {
  firstName: string
  lastName: string
  agencyName: string
  roleSlug: string
  acceptUrl: string
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function humaniseRole(roleSlug: string): string {
  switch (roleSlug) {
    case 'partner_admin':
      return 'Partner Admin'
    case 'partner_member':
      return 'Partner Member'
    default:
      return roleSlug
  }
}

export function renderPartnerInviteEmail(props: PartnerInviteEmailProps): string {
  const fullName = htmlEscape(`${props.firstName} ${props.lastName}`.trim())
  const agency = htmlEscape(props.agencyName)
  const role = htmlEscape(humaniseRole(props.roleSlug))
  const url = htmlEscape(props.acceptUrl)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Invitation to ${agency}</title>
</head>
<body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 32px 24px;">
  <h1 style="font-size: 22px; margin: 0 0 8px;">Welcome to ${agency}, ${fullName}.</h1>
  <p style="margin: 0 0 20px; line-height: 1.5;">
    You have been invited to join <strong>${agency}</strong> as a <strong>${role}</strong> on the Open Mercato partner portal.
    Click the button below to set your password and finish onboarding.
  </p>
  <p style="margin: 0 0 28px;">
    <a href="${url}" style="display: inline-block; padding: 12px 20px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;">
      Accept invitation
    </a>
  </p>
  <p style="margin: 0 0 4px; font-size: 13px; color: #666;">If the button doesn't work, copy and paste this URL into your browser:</p>
  <p style="margin: 0 0 28px; font-size: 13px;"><a href="${url}" style="color: #2952cc;">${url}</a></p>
  <p style="margin: 0; font-size: 12px; color: #888;">
    This invitation expires in 72 hours. If you didn't expect this email, please ignore it — no account was created on your behalf.
  </p>
</body>
</html>`
}

export default renderPartnerInviteEmail
