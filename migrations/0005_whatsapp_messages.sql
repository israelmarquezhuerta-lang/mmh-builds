-- Additive only: existing customers, sessions and orders are untouched.
CREATE TABLE IF NOT EXISTS wa_conversations (
  id TEXT PRIMARY KEY,
  phone_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot','manual')),
  interest TEXT NOT NULL DEFAULT 'other' CHECK (interest IN ('pc','web','app','other')),
  needs_attention INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  last_inbound_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  lock_token TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE(phone_id, wa_id)
);
CREATE INDEX IF NOT EXISTS wa_conversations_updated ON wa_conversations(updated_at DESC, id);
CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  meta_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  sender TEXT NOT NULL CHECK(sender IN ('customer','gemini','admin')),
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_at INTEGER NOT NULL DEFAULT 0,
  bot_status TEXT NOT NULL DEFAULT 'done',
  request_key TEXT UNIQUE,
  error_code TEXT,
  admin_email TEXT
);
CREATE INDEX IF NOT EXISTS wa_messages_conversation ON wa_messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS wa_delivery_events (
  meta_id TEXT NOT NULL,
  status TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  error_code TEXT,
  PRIMARY KEY(meta_id, status, event_at)
);
CREATE TABLE IF NOT EXISTS wa_admin_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
