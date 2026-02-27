/**
 * Data retention manager.
 * Implements the downsampling strategy from DESIGN.md §14.5:
 *   - Last 7 days:  full resolution
 *   - Last 30 days: 33% sample (keep every 3rd record)
 *   - Last 90 days: 10% sample (keep every 10th record)
 *   - Older:        delete (only episode summaries + hourly commander_log kept)
 */

import type { Database } from "bun:sqlite";

export interface RetentionConfig {
  /** Days of full resolution data */
  fullResolutionDays: number;
  /** Days for 33% sample (past full resolution) */
  thirdSampleDays: number;
  /** Days for 10% sample (past 33% sample) */
  tenthSampleDays: number;
}

const DEFAULT_CONFIG: RetentionConfig = {
  fullResolutionDays: 7,
  thirdSampleDays: 30,
  tenthSampleDays: 90,
};

export interface RetentionResult {
  decisionLogDeleted: number;
  snapshotsDeleted: number;
  marketHistoryDeleted: number;
  commanderLogDeleted: number;
}

export class RetentionManager {
  private config: RetentionConfig;

  constructor(
    private db: Database,
    config?: Partial<RetentionConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run the retention policy. Call this periodically (e.g., daily).
   * Returns count of deleted records per table.
   */
  run(): RetentionResult {
    const now = Date.now();
    const msPerDay = 86_400_000;
    const fullCutoff = new Date(now - this.config.fullResolutionDays * msPerDay).toISOString();
    const thirdCutoff = new Date(now - this.config.thirdSampleDays * msPerDay).toISOString();
    const tenthCutoff = new Date(now - this.config.tenthSampleDays * msPerDay).toISOString();

    const result: RetentionResult = {
      decisionLogDeleted: 0,
      snapshotsDeleted: 0,
      marketHistoryDeleted: 0,
      commanderLogDeleted: 0,
    };

    const tx = this.db.transaction(() => {
      // 33% sample zone (7-30 days old): keep every 3rd record
      result.decisionLogDeleted += this.downsample(
        "decision_log", fullCutoff, thirdCutoff, 3
      );
      result.snapshotsDeleted += this.downsample(
        "state_snapshots", fullCutoff, thirdCutoff, 3
      );
      result.marketHistoryDeleted += this.downsample(
        "market_history", fullCutoff, thirdCutoff, 3
      );

      // 10% sample zone (30-90 days old): keep every 10th record
      result.decisionLogDeleted += this.downsample(
        "decision_log", thirdCutoff, tenthCutoff, 10
      );
      result.snapshotsDeleted += this.downsample(
        "state_snapshots", thirdCutoff, tenthCutoff, 10
      );
      result.marketHistoryDeleted += this.downsample(
        "market_history", thirdCutoff, tenthCutoff, 10
      );

      // Older than 90 days: delete from high-volume tables (keep episodes + commander_log)
      result.decisionLogDeleted += this.deleteOlderThan("decision_log", tenthCutoff);
      result.snapshotsDeleted += this.deleteOlderThan("state_snapshots", tenthCutoff);
      result.marketHistoryDeleted += this.deleteOlderThan("market_history", tenthCutoff);

      // Commander log older than 90 days: keep hourly (1 per hour ≈ 1 per 360 records at 60s interval)
      result.commanderLogDeleted += this.downsample(
        "commander_log", tenthCutoff, "1970-01-01T00:00:00Z", 360
      );
    });

    tx();
    return result;
  }

  /**
   * Downsample a table between two date boundaries.
   * Keeps every Nth record (by id), deletes the rest.
   * Returns number of deleted records.
   */
  private downsample(
    table: string,
    newerThan: string,
    olderThan: string,
    keepEveryN: number
  ): number {
    // Delete records where (id % N) != 0, within the date range
    const result = this.db.run(
      `DELETE FROM ${table}
       WHERE created_at < ? AND created_at >= ?
       AND (id % ?) != 0`,
      [newerThan, olderThan, keepEveryN]
    );
    return result.changes;
  }

  /**
   * Delete all records older than a cutoff date.
   */
  private deleteOlderThan(table: string, olderThan: string): number {
    const result = this.db.run(
      `DELETE FROM ${table} WHERE created_at < ?`,
      [olderThan]
    );
    return result.changes;
  }

  /** Get estimated data age ranges */
  getDataRange(table: string): { oldest: string | null; newest: string | null; count: number } {
    const row = this.db
      .query(`SELECT MIN(created_at) as oldest, MAX(created_at) as newest, COUNT(*) as count FROM ${table}`)
      .get() as { oldest: string | null; newest: string | null; count: number };
    return row;
  }
}
