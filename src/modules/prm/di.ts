import { asFunction, asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { AgencyService } from './lib/agencyService'
import { AgencyMemberService } from './lib/agencyMemberService'
import { ReinviteCooldownService } from './lib/reinviteCooldownService'
import { ProspectService } from './lib/prospectService'
import { LicenseDealService } from './lib/licenseDealService'
import { RfpService } from './lib/rfpService'
import { CaseStudyService } from './lib/caseStudyService'
import { MarketingMaterialService } from './lib/marketingMaterialService'
import {
  executeAttributionSaga,
  type AttributionSagaArgs,
  type SagaActivityResult,
} from './lib/attributionSaga'

/**
 * PRM dependency-injection registration.
 *
 * Services are scoped to the request EM so they participate in the same MikroORM transaction
 * as `customer_accounts.CustomerInvitationService` (PROXY-GATE-RESOLUTIONS §Q2).
 *
 * Workflow function registration (Spec #3 — attribution-loop):
 *   - `workflowFunction:prm.saga.executeAttribution` — the activity handler the
 *     `prm.license_deal.attribution_saga` `WorkflowDefinition` invokes via
 *     `EXECUTE_FUNCTION`. Idempotent. Reads the LicenseDeal + Prospect, applies
 *     the per-path saga steps, and returns a structured outcome.
 */
export function register(container: AppContainer): void {
  container.register({
    // `.proxy()` forces PROXY injection mode for this registration — required because
    // the request container is built with `InjectionMode.CLASSIC` (see
    // `@open-mercato/shared/lib/di/container.ts`), under which destructured factory
    // params do NOT receive named dependencies. Without this, `em` arrives as
    // undefined and the first ORM call throws `Cannot read properties of undefined
    // (reading 'findOne')`. Mirrors the canonical pattern used in `data_sync/di.ts`.
    agencyService: asFunction(({ em }: { em: EntityManager }) => new AgencyService(em)).scoped().proxy(),
    agencyMemberService: asFunction(
      ({ em }: { em: EntityManager }) => new AgencyMemberService(em),
    ).scoped().proxy(),
    prospectService: asFunction(({ em }: { em: EntityManager }) => new ProspectService(em)).scoped().proxy(),
    licenseDealService: asFunction(
      ({ em }: { em: EntityManager }) => new LicenseDealService(em),
    ).scoped().proxy(),
    rfpService: asFunction(({ em }: { em: EntityManager }) => new RfpService(em)).scoped().proxy(),
    caseStudyService: asFunction(
      ({ em }: { em: EntityManager }) => new CaseStudyService(em),
    ).scoped().proxy(),
    marketingMaterialService: asFunction(
      ({ em }: { em: EntityManager }) => new MarketingMaterialService(em),
    ).scoped().proxy(),
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
    // Workflow activity handler — the platform's EXECUTE_FUNCTION dispatcher
    // looks up `workflowFunction:<name>` keys.
    'workflowFunction:prm.saga.executeAttribution': asValue(
      async (
        args: AttributionSagaArgs,
        ctx: { workflowInstance: { tenantId: string; organizationId: string } },
      ): Promise<SagaActivityResult> => {
        // The platform passes a forked EM via container.resolve('em'); both the
        // outer container (for sibling services) and the EM live on the same
        // request scope.
        const em = container.resolve('em') as EntityManager
        return executeAttributionSaga(args, {
          em,
          container: container as unknown as Parameters<typeof executeAttributionSaga>[1]['container'],
        })
      },
    ),
  })
}

export default register
