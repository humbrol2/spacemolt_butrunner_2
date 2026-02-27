import { Database } from "bun:sqlite";

const username = process.argv[2];
if (!username) {
  console.log("Usage: bun run scripts/remove-bot.ts <username>");
  process.exit(1);
}

const db = new Database("data/commander.db");
const result = db.run("DELETE FROM bot_sessions WHERE username = ?", [username]);
if (result.changes > 0) {
  console.log(`Removed ${username} from bot_sessions`);
} else {
  console.log(`No bot found with username: ${username}`);
}
// Also clean bot_settings
const settings = db.run("DELETE FROM bot_settings WHERE username = ?", [username]);
if (settings.changes > 0) {
  console.log(`Removed ${username} settings`);
}
db.close();
