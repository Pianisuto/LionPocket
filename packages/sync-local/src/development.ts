import {
  canonicalStringify,
  type RevisionPlaintext,
} from '@lionpocket/sync-protocol';
import {
  conflictReviews,
  recoverDeletedBranch,
  resolveConflict,
  type ConflictReview,
} from './transport-state';
import { ManualSync } from './transport';
export interface DevelopmentSyncStatus {
  enabled: boolean;
  received: string;
  applied: string;
  pending: number;
  quarantined: number;
  reemitted: number;
  conflicts: ConflictReview[];
}
/** UI actions receive public IDs/heads only; the engine and cofre stay outside renderer state. */
export class DevelopmentSyncActions {
  constructor(readonly engine: ManualSync) {}
  async status(): Promise<DevelopmentSyncStatus> {
    const [s] = await this.engine.db.read(
      'SELECT * FROM sync_local_state WHERE id=1',
    );
    return {
      enabled:
        ['synthetic_manual', 'financial'].includes(String(s.mode)) &&
        s.binding_id !== null,
      received: String(s.received_cursor),
      applied: String(s.applied_cursor),
      pending: (
        await this.engine.db.read(
          "SELECT commit_id FROM sync_outbox WHERE state!='acknowledged' AND COALESCE(last_error,'') NOT IN ('key_rotated','remote_accepted_before_rotation')",
        )
      ).length,
      reemitted: (
        await this.engine.db.read(
          "SELECT commit_id FROM sync_outbox WHERE state='blocked' AND last_error IN ('key_rotated','remote_accepted_before_rotation')",
        )
      ).length,
      quarantined: (
        await this.engine.db.read(
          "SELECT commit_id FROM sync_inbox WHERE state='quarantined'",
        )
      ).length,
      conflicts: await conflictReviews(this.engine.db),
    };
  }
  async resolve(
    objectId: string,
    heads: string[],
    revisionId: string,
    recover = false,
  ) {
    const reviews = await conflictReviews(this.engine.db),
      review = reviews.find((c) => c.objectId === objectId);
    if (
      !review ||
      canonicalStringify(review.heads) !== canonicalStringify(heads)
    )
      throw new Error('heads_changed');
    const branch = review.branches.find((b) => b.revisionId === revisionId);
    if (!branch) throw new Error('revision_missing');
    const authoredAt = new Date().toISOString();
    if (recover) {
      await this.engine.db.run(
        recoverDeletedBranch(
          objectId,
          heads,
          revisionId,
          this.engine.dialect,
          () => this.engine.device.crypto.uuid(),
          authoredAt,
        ),
      );
      return this.status();
    }
    const choice = JSON.parse(
      canonicalStringify(branch.revision),
    ) as RevisionPlaintext;
    choice.authoredAt = authoredAt;
    if (choice.action === 'delete') choice.deletedAt = authoredAt;
    await this.engine.db.run(
      resolveConflict(objectId, heads, choice, this.engine.dialect, () =>
        this.engine.device.crypto.uuid(),
      ),
    );
    return this.status();
  }
}
