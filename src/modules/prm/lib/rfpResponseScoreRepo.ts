import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { RfpResponseScore } from '../data/entities'
import { PRM_ERROR_CODES, PrmDomainError, isUniqueViolation } from './errors'

/**
 * Append-only repository for `RfpResponseScore` (Spec #6 invariant #18).
 *
 * **Single write surface — `insertNextVersion`.** The repository deliberately
 * exposes NO `update`, NO `remove`. Callers must compose by inserting a new
 * row with `version = max(version) + 1` and a `change_reason` that
 * documents the supersession. This pattern is the audit-trail backbone:
 * any "correction" leaves a permanent record of what changed and why.
 *
 * Race-safety: `version` is computed inside the same transaction as the
 * INSERT (`SELECT MAX(version) FROM prm_rfp_response_scores WHERE
 * rfp_response_id = $1`). The UNIQUE `(rfp_response_id, version)`
 * constraint is the source of truth — concurrent writers will collide on
 * the constraint and the second one re-tries with v+1. We surface the
 * collision as a 409 to the caller so they can retry naturally.
 *
 * Read shape: callers can pull either the latest version or the full
 * history. The composite index `(rfp_response_id, version desc)` keeps
 * both shapes O(log n) per response.
 */
export interface InsertRfpResponseScoreInput {
  rfpResponseId: string
  organizationId: string
  scoredByUserId: string
  techFitScore: number
  domainFitScore: number
  optionalScore: number | null
  includeOptional: boolean
  reasoning: string
  source: 'manual' | 'llm_assisted'
  llmModelId: string | null
  changeReason: string | null
}

export class RfpResponseScoreRepo {
  constructor(private readonly em: EntityManager) {}

  /**
   * Insert the next-version score for `rfpResponseId`. Returns the persisted
   * entity. Throws `PrmDomainError(NO_SCORED_RESPONSES)` only on writer
   * collision retries exhausted (v1 retries once on UNIQUE violation; the
   * second collision suggests a runaway concurrent write).
   */
  async insertNextVersion(input: InsertRfpResponseScoreInput): Promise<RfpResponseScore> {
    let attempts = 0
    while (attempts < 2) {
      const nextVersion = await this.getNextVersion(input.rfpResponseId)
      try {
        const row = this.em.create(RfpResponseScore, {
          id: randomUUID(),
          organizationId: input.organizationId,
          rfpResponseId: input.rfpResponseId,
          version: nextVersion,
          scoredByUserId: input.scoredByUserId,
          techFitScore: input.techFitScore,
          domainFitScore: input.domainFitScore,
          optionalScore: input.optionalScore,
          includeOptional: input.includeOptional,
          reasoning: input.reasoning,
          source: input.source,
          llmModelId: input.llmModelId,
          changeReason: input.changeReason,
          createdAt: new Date(),
        } as any)
        this.em.persist(row)
        await this.em.flush()
        return row
      } catch (err) {
        if (isUniqueViolation(err) && attempts === 0) {
          // Concurrent writer claimed `nextVersion` first — re-fetch and
          // retry with the new max + 1.
          attempts += 1
          continue
        }
        throw err
      }
    }
    throw new PrmDomainError(
      PRM_ERROR_CODES.VALIDATION_FAILED,
      'Score version collision — too many concurrent writers',
      409,
    )
  }

  /** Returns the latest score row for `rfpResponseId`, or null when never scored. */
  async findLatest(
    rfpResponseId: string,
    scope: { organizationId: string },
  ): Promise<RfpResponseScore | null> {
    const rows = await this.em.find(
      RfpResponseScore,
      { rfpResponseId, organizationId: scope.organizationId } as any,
      { orderBy: { version: 'desc' }, limit: 1 } as any,
    )
    return rows.length > 0 ? rows[0]! : null
  }

  /** Returns the full history (oldest first) — used by the audit page. */
  async findHistory(
    rfpResponseId: string,
    scope: { organizationId: string },
  ): Promise<RfpResponseScore[]> {
    return this.em.find(
      RfpResponseScore,
      { rfpResponseId, organizationId: scope.organizationId } as any,
      { orderBy: { version: 'asc' } } as any,
    )
  }

  /** Returns the latest scores for many responses in one round-trip. */
  async findLatestForResponses(
    rfpResponseIds: string[],
    scope: { organizationId: string },
  ): Promise<Map<string, RfpResponseScore>> {
    const out = new Map<string, RfpResponseScore>()
    if (rfpResponseIds.length === 0) return out
    const rows = await this.em.find(
      RfpResponseScore,
      {
        rfpResponseId: { $in: rfpResponseIds },
        organizationId: scope.organizationId,
      } as any,
      { orderBy: { rfpResponseId: 'asc', version: 'desc' } } as any,
    )
    for (const row of rows) {
      if (!out.has(row.rfpResponseId)) out.set(row.rfpResponseId, row)
    }
    return out
  }

  private async getNextVersion(rfpResponseId: string): Promise<number> {
    // Single-statement MAX — runs in the same transaction as the INSERT.
    const conn = this.em.getConnection()
    const rows = await conn.execute<{ max: number | null }[]>(
      'select max(version) as max from "prm_rfp_response_scores" where "rfp_response_id" = ?',
      [rfpResponseId],
    )
    const max = Array.isArray(rows) && rows.length > 0 ? (rows[0]?.max ?? null) : null
    return typeof max === 'number' && Number.isFinite(max) ? max + 1 : 1
  }
}

export default RfpResponseScoreRepo
