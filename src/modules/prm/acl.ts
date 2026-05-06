// PRM access control feature catalogue.
// Naming convention follows app-spec §2.3:
//   - prm.<resource>.<action>     for backend (User session) operations
//   - portal.partner.<action>     for portal-shell gates
// Feature IDs are FROZEN once shipped (cross-spec contract).
export const features = [
  // Backend (OM staff) — agency aggregate
  { id: 'prm.agency.read', title: 'Read agencies', module: 'prm' },
  { id: 'prm.agency.create', title: 'Create agencies', module: 'prm' },
  { id: 'prm.agency.update_all', title: 'Edit any agency field (incl. admin-only)', module: 'prm' },
  { id: 'prm.agency.edit_admin_fields', title: 'Edit admin-only agency fields', module: 'prm' },
  { id: 'prm.agency.read_admin_fields', title: 'Read admin-only agency fields', module: 'prm' },
  { id: 'prm.agency.delete', title: 'Delete agencies', module: 'prm' },
  { id: 'prm.agency.invite_admin', title: 'Invite agency admins / members from backend', module: 'prm' },

  // Backend — agency member aggregate
  { id: 'prm.agency_member.read_all', title: 'Read members across agencies (B3)', module: 'prm' },
  { id: 'prm.agency_member.write_all', title: 'Edit any agency member (lockout recovery)', module: 'prm' },

  // Portal (CustomerUser session) — agency
  { id: 'prm.agency.view', title: 'View own agency profile (portal)', module: 'prm' },
  { id: 'prm.agency.edit', title: 'Edit own agency profile (portal)', module: 'prm' },

  // Portal — agency members
  { id: 'prm.agency_member.read', title: 'View own agency members (portal)', module: 'prm' },
  { id: 'prm.agency_member.manage_partner_member', title: 'Invite/edit partner_member rows (portal)', module: 'prm' },
  { id: 'prm.agency_member.self_edit', title: 'Edit own agency-member row (portal)', module: 'prm' },

  // Portal shell
  { id: 'portal.partner.access', title: 'Access partner portal shell', module: 'prm' },
  { id: 'portal.partner.notifications.view', title: 'View partner portal notifications', module: 'prm' },

  // Prospect lifecycle (Spec #2 — wip-scoreboard).
  // Cross-spec contract (FROZEN): naming follows `prm.<resource>.<action>` per AGENTS.
  { id: 'prm.prospect.read_own_agency', title: 'Read prospects in own agency (P5/P6)', module: 'prm' },
  { id: 'prm.prospect.read_cross_agency', title: 'Read prospects across all agencies (B4)', module: 'prm' },
  { id: 'prm.prospect.register', title: 'Register a new prospect (US3.1)', module: 'prm' },
  { id: 'prm.prospect.transition_any_in_agency', title: 'Transition any prospect in own agency', module: 'prm' },
  { id: 'prm.prospect.transition_own_authored', title: 'Transition own-authored prospects', module: 'prm' },

  // Dashboard + tier widgets (Spec #2).
  { id: 'prm.dashboard.view', title: 'Read partner-portal dashboard (P2)', module: 'prm' },
  { id: 'prm.wic.read_own_agency', title: 'Read own-agency WIC widget data', module: 'prm' },
  { id: 'prm.tier_requirement.read', title: 'Read tier-requirement widget data', module: 'prm' },

  // LicenseDeal attribution loop (Spec #3 — attribution-loop).
  // Cross-spec contract (FROZEN). `prm.license_deal.reassign` is the secondary-confirm
  // gate for US4.4b (status unreverse) per spec §6.1.
  { id: 'prm.license_deal.read', title: 'Read license deals (B5)', module: 'prm' },
  { id: 'prm.license_deal.write', title: 'Create/edit/attribute license deals (B5)', module: 'prm' },
  { id: 'prm.license_deal.reassign', title: 'Status unreverse (US4.4b — scoped bypass)', module: 'prm' },
  { id: 'prm.min.read_own_agency', title: 'Read own-agency MIN widget data', module: 'prm' },

  // RFP broadcast & response (Spec #5 — rfp-broadcast-response).
  // Backend-only gates. Portal RFP routes use implicit tenant scope +
  // CustomerUserRole pattern (Spec #1 / SPEC-060) — no explicit prm.* feature.
  // `create` and `publish` are split so an intern-tier role can draft but not
  // broadcast; v1 grants both to the OM PartnerOps `employee` staff role.
  { id: 'prm.rfp.create', title: 'Create + edit RFP drafts (B7)', module: 'prm' },
  { id: 'prm.rfp.publish', title: 'Publish + unpublish RFPs (B7)', module: 'prm' },
] as const

export type PrmFeatureId = (typeof features)[number]['id']

export default features
