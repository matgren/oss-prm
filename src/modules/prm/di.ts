import { asFunction, asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { AgencyService } from './lib/agencyService'
import { AgencyMemberService } from './lib/agencyMemberService'
import { ReinviteCooldownService } from './lib/reinviteCooldownService'

/**
 * PRM dependency-injection registration.
 *
 * Services are scoped to the request EM so they participate in the same MikroORM transaction
 * as `customer_accounts.CustomerInvitationService` (PROXY-GATE-RESOLUTIONS §Q2).
 */
export function register(container: AppContainer): void {
  container.register({
    agencyService: asFunction(({ em }: { em: EntityManager }) => new AgencyService(em)).scoped(),
    agencyMemberService: asFunction(
      ({ em }: { em: EntityManager }) => new AgencyMemberService(em),
    ).scoped(),
    reinviteCooldownService: asFunction(() => new ReinviteCooldownService()).singleton(),
    // Convenience: bag of admin-only field names so interceptors and enrichers
    // share one source of truth.
    prmAdminOnlyAgencyFields: asValue([
      'tier',
      'status',
      'contractSigned',
      'ndaSigned',
      'onboarded',
    ] as const),
  })
}

export default register
