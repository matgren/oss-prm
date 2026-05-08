/**
 * Partner invite email body — React-Email component matching the OM core
 * convention (see `@open-mercato/core/modules/customer_accounts/emails/`).
 *
 * The component is passed directly to `sendEmail({ react: ... })`; Resend
 * renders it server-side via @react-email/render, so do not pre-render.
 */

import * as React from 'react'
import {
  Body,
  Container,
  Head,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components'

export type PartnerInviteEmailProps = {
  firstName: string
  lastName: string
  agencyName: string
  roleSlug: string
  acceptUrl: string
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

export function PartnerInviteEmail({
  firstName,
  lastName,
  agencyName,
  roleSlug,
  acceptUrl,
}: PartnerInviteEmailProps) {
  const fullName = `${firstName} ${lastName}`.trim()
  const role = humaniseRole(roleSlug)
  return (
    <Html>
      <Head />
      <Preview>{`You're invited to join ${agencyName} on Open Mercato`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section>
            <Text style={title}>{`Welcome to ${agencyName}, ${fullName}.`}</Text>
            <Text style={paragraph}>
              You have been invited to join <strong>{agencyName}</strong> as a{' '}
              <strong>{role}</strong> on the Open Mercato partner portal. Click
              the button below to set your password and finish onboarding.
            </Text>
            <Text>
              <Link href={acceptUrl} style={button}>
                Accept invitation
              </Link>
            </Text>
            <Text style={paragraphSmall}>
              If the button doesn&apos;t work, copy and paste this URL into your
              browser:
            </Text>
            <Text style={paragraphSmall}>
              <Link href={acceptUrl} style={fallbackLink}>
                {acceptUrl}
              </Link>
            </Text>
            <Text style={hint}>
              This invitation expires in 72 hours. If you didn&apos;t expect
              this email, please ignore it — no account was created on your
              behalf.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const body: React.CSSProperties = { backgroundColor: '#f9fafb', margin: 0, padding: '24px 0' }
const container: React.CSSProperties = { backgroundColor: '#ffffff', borderRadius: 12, padding: 24, margin: '0 auto', maxWidth: 560, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const title: React.CSSProperties = { fontSize: 22, fontWeight: 600, color: '#111827', margin: '0 0 12px' }
const paragraph: React.CSSProperties = { fontSize: 14, color: '#374151', lineHeight: '20px', margin: '0 0 20px' }
const button: React.CSSProperties = { display: 'inline-block', backgroundColor: '#111827', color: '#ffffff', padding: '12px 20px', borderRadius: 6, textDecoration: 'none', fontSize: 14 }
const paragraphSmall: React.CSSProperties = { fontSize: 13, color: '#6b7280', margin: '12px 0 4px' }
const fallbackLink: React.CSSProperties = { color: '#2952cc', wordBreak: 'break-all' }
const hint: React.CSSProperties = { fontSize: 12, color: '#9ca3af', marginTop: 24 }

export default PartnerInviteEmail
