import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type GuildConfig = {
  prefix: string;
  staffRoles: string[];
  moderatorRoles: string[];
  administratorRoles: string[];
  developerRoles: string[];
  testerRoles: string[];
  supportRoles: string[];
  autoRoles: string[];
  channels: {
    ticketCategory?: string;
    report?: string;
    testerReport?: string;
    developerReport?: string;
    moderationLog?: string;
    joinLeaveLog?: string;
    ticketLog?: string;
    anonymousDmLog?: string;
    welcome?: string;
    application?: string;
    bug?: string;
    suggestion?: string;
  };
  colours: {
    primary: string;
    success: string;
    danger: string;
    warning: string;
  };
  welcome: {
    enabled: boolean;
    message: string;
    showMemberCount: boolean;
  };
};

const defaultConfig: GuildConfig = {
  prefix: "!",
  staffRoles: [],
  moderatorRoles: [],
  administratorRoles: [],
  developerRoles: [],
  testerRoles: [],
  supportRoles: [],
  autoRoles: [],
  channels: {},
  colours: {
    primary: "#5865F2",
    success: "#57F287",
    danger: "#ED4245",
    warning: "#FEE75C",
  },
  welcome: {
    enabled: false,
    message: "Welcome to {server}, {user}.",
    showMemberCount: true,
  },
};

const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "management.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    creator_id TEXT NOT NULL,
    claimed_by TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS moderation_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    action TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    author_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    message_id TEXT,
    channel_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auto_reactions (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    trigger_text TEXT,
    PRIMARY KEY (guild_id, channel_id, emoji)
  );
  CREATE TABLE IF NOT EXISTS anonymous_dm_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    message_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reaction_roles (
    guild_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    label TEXT NOT NULL,
    emoji TEXT,
    PRIMARY KEY (guild_id, message_id, role_id)
  );
`);

const now = () => Date.now();

export function getGuildConfig(guildId: string): GuildConfig {
  const row = db
    .prepare("SELECT config_json FROM guild_config WHERE guild_id = ?")
    .get(guildId) as { config_json?: string } | undefined;
  if (!row?.config_json) {
    saveGuildConfig(guildId, defaultConfig);
    return structuredClone(defaultConfig);
  }
  try {
    const saved = JSON.parse(row.config_json) as Partial<GuildConfig>;
    return {
      ...structuredClone(defaultConfig),
      ...saved,
      channels: { ...defaultConfig.channels, ...saved.channels },
      colours: { ...defaultConfig.colours, ...saved.colours },
      welcome: { ...defaultConfig.welcome, ...saved.welcome },
    };
  } catch {
    return structuredClone(defaultConfig);
  }
}

export function saveGuildConfig(guildId: string, config: GuildConfig) {
  db.prepare(`
    INSERT INTO guild_config (guild_id, config_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
  `).run(guildId, JSON.stringify(config), now());
}

export function createTicket(guildId: string, channelId: string, creatorId: string) {
  return db.prepare(`
    INSERT INTO tickets (guild_id, channel_id, creator_id, created_at) VALUES (?, ?, ?, ?)
  `).run(guildId, channelId, creatorId, now());
}

export function getTicket(channelId: string) {
  return db.prepare("SELECT * FROM tickets WHERE channel_id = ?").get(channelId) as
    | { id: number; guild_id: string; channel_id: string; creator_id: string; claimed_by: string | null; status: string }
    | undefined;
}

export function updateTicket(channelId: string, updates: { claimedBy?: string | null; status?: string }) {
  if (updates.claimedBy !== undefined) {
    db.prepare("UPDATE tickets SET claimed_by = ? WHERE channel_id = ?").run(updates.claimedBy, channelId);
  }
  if (updates.status !== undefined) {
    db.prepare("UPDATE tickets SET status = ?, closed_at = ? WHERE channel_id = ?").run(
      updates.status,
      updates.status === "closed" ? now() : null,
      channelId,
    );
  }
}

export function createCase(
  guildId: string,
  action: string,
  moderatorId: string,
  targetId: string,
  reason: string,
) {
  return db.prepare(`
    INSERT INTO moderation_cases (guild_id, action, moderator_id, target_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, action, moderatorId, targetId, reason, now());
}

export function addWarning(guildId: string, targetId: string, moderatorId: string, reason: string) {
  return db.prepare(`
    INSERT INTO warnings (guild_id, target_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(guildId, targetId, moderatorId, reason, now());
}

export function getWarnings(guildId: string, targetId: string) {
  return db.prepare(`
    SELECT id, moderator_id, reason, created_at FROM warnings
    WHERE guild_id = ? AND target_id = ? ORDER BY created_at DESC LIMIT 25
  `).all(guildId, targetId) as Array<{ id: number; moderator_id: string; reason: string; created_at: number }>;
}

export function createSubmission(
  guildId: string,
  kind: string,
  authorId: string,
  data: Record<string, string>,
  messageId?: string,
  channelId?: string,
) {
  return db.prepare(`
    INSERT INTO submissions (guild_id, kind, author_id, data_json, message_id, channel_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, kind, authorId, JSON.stringify(data), messageId ?? null, channelId ?? null, now());
}

export function updateSubmissionStatus(messageId: string, status: string) {
  db.prepare("UPDATE submissions SET status = ? WHERE message_id = ?").run(status, messageId);
}

export function addAnonymousDmLog(guildId: string, senderId: string, recipientId: string, messageHash: string) {
  db.prepare(`
    INSERT INTO anonymous_dm_logs (guild_id, sender_id, recipient_id, message_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, senderId, recipientId, messageHash, now());
}

export function upsertAutoReaction(guildId: string, channelId: string, emoji: string, triggerText?: string) {
  db.prepare(`
    INSERT INTO auto_reactions (guild_id, channel_id, emoji, trigger_text) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id, emoji) DO UPDATE SET trigger_text = excluded.trigger_text
  `).run(guildId, channelId, emoji, triggerText ?? null);
}

export function getAutoReactions(guildId: string, channelId: string) {
  return db.prepare(`
    SELECT emoji, trigger_text FROM auto_reactions WHERE guild_id = ? AND channel_id = ?
  `).all(guildId, channelId) as Array<{ emoji: string; trigger_text: string | null }>;
}

export function saveReactionRole(guildId: string, messageId: string, roleId: string, label: string, emoji?: string) {
  db.prepare(`
    INSERT OR REPLACE INTO reaction_roles (guild_id, message_id, role_id, label, emoji) VALUES (?, ?, ?, ?, ?)
  `).run(guildId, messageId, roleId, label, emoji ?? null);
}

export function getReactionRole(guildId: string, messageId: string, roleId: string) {
  return db.prepare(`
    SELECT role_id, label, emoji FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND role_id = ?
  `).get(guildId, messageId, roleId) as { role_id: string; label: string; emoji: string | null } | undefined;
}