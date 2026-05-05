import { handleProspectCandidateIndex, type ProspectIndexEventPayload } from '../lib/prospectCandidateIndexProjection'

export const metadata = {
  event: 'prm.prospect.status_changed',
  persistent: true,
  id: 'prm:prospect-candidate-index-on-status-changed',
}

export default async function handler(payload: ProspectIndexEventPayload): Promise<void> {
  await handleProspectCandidateIndex(payload, 'upsert')
}
