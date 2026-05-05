import { handleProspectCandidateIndex, type ProspectIndexEventPayload } from '../lib/prospectCandidateIndexProjection'

export const metadata = {
  event: 'prm.prospect.updated',
  persistent: true,
  id: 'prm:prospect-candidate-index-on-updated',
}

export default async function handler(payload: ProspectIndexEventPayload): Promise<void> {
  await handleProspectCandidateIndex(payload, 'upsert')
}
