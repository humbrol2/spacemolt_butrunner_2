/**
 * Bot credential and session management.
 * Stores credentials in SQLite (encrypted at rest in future versions).
 */

import type { Database } from "bun:sqlite";

export interface BotCredentials {
  username: string;
  password: string;
  empire: string | null;
  playerId: string | null;
  sessionId: string | null;
  sessionExpiresAt: string | null;
}

export class SessionStore {
  constructor(private db: Database) {}

  /** Get all registered bot credentials */
  listBots(): BotCredentials[] {
    return this.db
      .query(
        `SELECT username, password, empire, player_id as playerId,
                session_id as sessionId, session_expires_at as sessionExpiresAt
         FROM bot_sessions ORDER BY username`
      )
      .all() as BotCredentials[];
  }

  /** Get credentials for a specific bot */
  getBot(username: string): BotCredentials | null {
    return this.db
      .query(
        `SELECT username, password, empire, player_id as playerId,
                session_id as sessionId, session_expires_at as sessionExpiresAt
         FROM bot_sessions WHERE username = ?`
      )
      .get(username) as BotCredentials | null;
  }

  /** Add or update a bot's credentials */
  upsertBot(creds: Omit<BotCredentials, "sessionId" | "sessionExpiresAt">): void {
    this.db.run(
      `INSERT INTO bot_sessions (username, password, empire, player_id, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(username) DO UPDATE SET
         password = excluded.password,
         empire = excluded.empire,
         player_id = excluded.player_id,
         updated_at = datetime('now')`,
      [creds.username, creds.password, creds.empire, creds.playerId]
    );
  }

  /** Update session info after login */
  updateSession(username: string, sessionId: string, expiresAt: string): void {
    this.db.run(
      `UPDATE bot_sessions SET session_id = ?, session_expires_at = ?, updated_at = datetime('now')
       WHERE username = ?`,
      [sessionId, expiresAt, username]
    );
  }

  /** Clear session (on logout or expiry) */
  clearSession(username: string): void {
    this.db.run(
      `UPDATE bot_sessions SET session_id = NULL, session_expires_at = NULL, updated_at = datetime('now')
       WHERE username = ?`,
      [username]
    );
  }

  /** Remove a bot entirely */
  removeBot(username: string): boolean {
    const result = this.db.run("DELETE FROM bot_sessions WHERE username = ?", [username]);
    return result.changes > 0;
  }

  /** Check if a session is still valid (not expired) */
  isSessionValid(username: string): boolean {
    const bot = this.getBot(username);
    if (!bot?.sessionId || !bot.sessionExpiresAt) return false;
    return new Date(bot.sessionExpiresAt) > new Date();
  }
}
