import { handleProspectCandidateIndex, type ProspectIndexEventPayload } from '../lib/prospectCandidateIndexProjection'

export const metadata = {
  event: 'prm.prospect.registration_reverted',
  persistent: true,
  id: 'prm:prospect-candidate-index-on-reverted',
}

export default async function handler(payload: ProspectIndexEventPayload): Promise<void> {
  await handleProspectCandidateIndex(payload, 'delete')
}
