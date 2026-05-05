import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * PRM Module Events (Phase 1 surface).
 *
 * **Cross-spec contract:** event IDs in this module are FROZEN once shipped.
 * Downstream PRM specs (#2 wip-scoreboard, #3 attribution-loop, #4 wic-ingestion,
 * #5 rfp-broadcast-response, #6 rfp-scoring-selection, #7 case-studies-marketing)
 * subscribe to these IDs verbatim. No renames, no payload removals — additive only.
 *
 * Event ID format: `prm.<singular_entity>.<past_tense_action>`.
 */
const events = [
  // Agency lifecycle
  { id: 'prm.agency.created', label: 'Agency created', entity: 'agency', category: 'lifecycle', clientBroadcast: true },
  { id: 'prm.agency.tier_changed', label: 'Agency tier changed', entity: 'agency', category: 'lifecycle', clientBroadcast: true },
  { id: 'prm.agency.status_changed', label: 'Agency status changed', entity: 'agency', category: 'lifecycle', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.agency.onboarding_state_changed', label: 'Agency onboarding state changed', entity: 'agency', category: 'lifecycle', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.agency.deleted', label: 'Agency deleted', entity: 'agency', category: 'lifecycle' },

  // Agency member lifecycle
  { id: 'prm.agency_member.added', label: 'Agency member invited (placeholder)', entity: 'agency_member', category: 'lifecycle', clientBroadcast: true },
  { id: 'prm.agency_member.activated', label: 'Agency member activated (invite accepted)', entity: 'agency_member', category: 'lifecycle', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.agency_member.removed', label: 'Agency member removed/deactivated', entity: 'agency_member', category: 'lifecycle', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.agency_member.role_changed', label: 'Agency member role changed', entity: 'agency_member', category: 'lifecycle', clientBroadcast: true },
  { id: 'prm.agency_member.updated', label: 'Agency member personal fields updated', entity: 'agency_member', category: 'crud', clientBroadcast: true, portalBroadcast: true },

  // Telemetry / diagnostic events
  { id: 'prm.agency_member.github_profile_conflict_attempted', label: 'GitHub profile conflict attempted', entity: 'agency_member', category: 'system' },
  { id: 'prm.agency.admin_field_access_rejected', label: 'Admin-only field write rejected', entity: 'agency', category: 'system' },

  // Prospect lifecycle (Spec #2 — wip-scoreboard).
  // Cross-spec contract (FROZEN): downstream Spec #3 attribution-loop binds candidate-index +
  // attribution saga subscribers to these IDs. Singular entity, past-tense action.
  { id: 'prm.prospect.registered', label: 'Prospect registered', entity: 'prospect', category: 'lifecycle', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.prospect.status_changed', label: 'Prospect status changed', entity: 'prospect', category: 'lifecycle', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.prospect.updated', label: 'Prospect updated', entity: 'prospect', category: 'crud', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.prospect.registration_reverted', label: 'Prospect registration reverted (compensating)', entity: 'prospect', category: 'system' },

  // LicenseDeal lifecycle (Spec #3 — attribution-loop).
  // Cross-spec contract (FROZEN): Spec #5 owns the `is_path_b_locked` column on `prm_rfps`,
  // Spec #6 reads it and enforces the hard guard on RFP re-open. This spec writes via the
  // `RfpPathBLockSubscriber` on `prm.license_deal.status_changed`.
  { id: 'prm.license_deal.created', label: 'License deal created', entity: 'license_deal', category: 'lifecycle', clientBroadcast: true },
  { id: 'prm.license_deal.attributed', label: 'License deal attributed', entity: 'license_deal', category: 'lifecycle', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.license_deal.attribution_overridden', label: 'License deal Golden Rule overridden', entity: 'license_deal', category: 'system' },
  { id: 'prm.license_deal.status_changed', label: 'License deal status changed', entity: 'license_deal', category: 'lifecycle', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.license_deal.reversal_started', label: 'License deal reversal started', entity: 'license_deal', category: 'lifecycle', clientBroadcast: true },
  { id: 'prm.license_deal.reversed', label: 'License deal attribution reversed', entity: 'license_deal', category: 'lifecycle', clientBroadcast: true, portalBroadcast: true },
  { id: 'prm.license_deal.status_unreversed', label: 'License deal status unreversed (US4.4b)', entity: 'license_deal', category: 'system' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'prm',
  events,
})

/** Type-safe event emitter for the PRM module. */
export const emitPrmEvent = eventsConfig.emit

/** Union of event IDs this module can publish. */
export type PrmEventId = (typeof events)[number]['id']

export default eventsConfig
