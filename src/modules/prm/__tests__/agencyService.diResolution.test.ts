/**
 * Runtime DI resolution test — POST-MVP-FOLLOW-UPS Tracker
 * "Unit-test coverage for the two PR #1 resume bugs (T0 Agency)" — bug (a):
 *
 *   PR #1 originally registered every PRM service as
 *     `asFunction(({ em }) => new Service(em)).scoped()`
 *   (no `.proxy()`). The shared request container in
 *   `@open-mercato/shared/lib/di/container.ts` is built with
 *   `InjectionMode.CLASSIC`, which does NOT inject named dependencies into
 *   destructured factory params unless the registration explicitly chains
 *   `.proxy()`. Without it, `em` arrives as `undefined` and the first ORM
 *   call throws `TypeError: Cannot read properties of undefined (reading
 *   'findOne')`. Fix landed in commits d0141c2 + c488dbb.
 *
 * The existing static-text scanner `diProxyGuardrail.test.ts` catches the
 * literal `.proxy()` in the source. This test catches the *runtime contract*
 * end-to-end: stand up a real Awilix container with the same `InjectionMode`
 * the request container uses, register the PRM services through the actual
 * `register(container)` exported by `src/modules/prm/di.ts`, resolve each
 * service, and confirm that the `em` reference inside the constructed service
 * is the same sentinel value we registered. If a future change replaces
 * `.proxy()` with a sibling helper that satisfies the regex but breaks
 * injection (or someone removes `.proxy()` while editing nearby lines), this
 * assertion goes red.
 *
 * Why a real EM isn't required: this test only proves the wiring contract.
 * The Phase 2 sibling test (`agencyService.uuidCoherence.test.ts`) covers
 * the second PR #1 bug (pre-flush UUID coherence) at the service layer.
 */

import { asValue, createContainer, InjectionMode } from 'awilix'
import { register as registerPrmDi } from '../di'

/**
 * Distinct service registrations that this test covers. Each is registered in
 * `src/modules/prm/di.ts` as a destructured-param `asFunction(({ em }) => ...)`
 * call — exactly the shape that broke under `InjectionMode.CLASSIC` without
 * `.proxy()`.
 *
 * Keep this list aligned with `di.ts`; if a new PRM service ships, add it
 * here. (`reinviteCooldownService` is excluded on purpose — it takes no `em`
 * dependency and is registered as a plain `asFunction(() => new ReinviteCooldownService()).singleton()`.)
 */
const SERVICES_REQUIRING_EM = [
  'agencyService',
  'agencyMemberService',
  'prospectService',
  'licenseDealService',
  'rfpService',
  'caseStudyService',
  'marketingMaterialService',
] as const

type SentinelEm = { __sentinel: 'prm-di-resolution-test-em' }

function makeSentinelEm(): SentinelEm {
  // Object identity is the assertion target — instance equality (===) is what
  // proves the named dependency was actually wired through, not silently
  // replaced with undefined or a default.
  return { __sentinel: 'prm-di-resolution-test-em' }
}

/**
 * Build a fresh Awilix container that mirrors the production request
 * container's injection mode (`InjectionMode.CLASSIC` — see
 * `node_modules/@open-mercato/shared/src/lib/di/container.ts`). We deliberately
 * use the SAME mode so this test reproduces the exact wiring failure the
 * runtime would have hit.
 */
function buildRequestLikeContainer(em: SentinelEm) {
  const container = createContainer({ injectionMode: InjectionMode.CLASSIC })
  container.register({ em: asValue(em) })
  return container
}

describe('PRM DI runtime resolution (POST-MVP-FOLLOW-UPS — PR #1 resume bug a)', () => {
  it('Awilix CLASSIC mode does NOT inject destructured params without .proxy() — sanity guard', () => {
    // This is a regression-cover sanity check: we explicitly construct an
    // asFunction registration WITHOUT .proxy() against an InjectionMode.CLASSIC
    // container and confirm Awilix returns `undefined` for the destructured
    // dep. If this ever stops being true (i.e. Awilix changes default semantics
    // for CLASSIC), the rest of this test suite — and the .proxy() guardrail —
    // would be over-protective. We want to know about that immediately.
    const { asFunction } = require('awilix') as typeof import('awilix')
    const em = makeSentinelEm()
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC })
    container.register({
      em: asValue(em),
      // No .proxy() — replicates the original PR #1 bug shape.
      buggyService: asFunction(({ em }: { em: SentinelEm }) => ({ resolvedEm: em })).scoped(),
    })
    const resolved = container.resolve('buggyService') as { resolvedEm: SentinelEm | undefined }
    // Under CLASSIC mode without .proxy(), the destructured `em` arrives as
    // undefined. This is the exact wiring trap PR #1 hit.
    expect(resolved.resolvedEm).toBeUndefined()
  })

  it.each(SERVICES_REQUIRING_EM)(
    '%s receives the sentinel `em` reference at resolve-time (proves .proxy() is wired)',
    (serviceName) => {
      const em = makeSentinelEm()
      const container = buildRequestLikeContainer(em)

      // Run the actual production registrar against the test container.
      registerPrmDi(container as any)

      const service = container.resolve(serviceName) as { em?: unknown }

      // Each PRM service stores the EM as a private field `em`. TypeScript's
      // `private` is compile-time only; at runtime the property is enumerable.
      // We assert object identity so a regression that injects a default /
      // proxy / undefined still fails this test.
      expect(service).toBeDefined()
      expect((service as any).em).toBe(em)
    },
  )

  it('reinviteCooldownService resolves cleanly (no em dep — sanity sibling)', () => {
    // ReinviteCooldownService takes no constructor args. This case ensures
    // the test container is actually running registrars and not silently
    // failing at registration time.
    const em = makeSentinelEm()
    const container = buildRequestLikeContainer(em)
    registerPrmDi(container as any)
    expect(container.resolve('reinviteCooldownService')).toBeDefined()
  })
})
