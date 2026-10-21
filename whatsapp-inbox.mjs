export async function ensureWhatsAppInbox(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_messages (
    message_id TEXT PRIMARY KEY, phone TEXT NOT NULL, contact_name TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    message_type TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'received', created_at TEXT NOT NULL
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS whatsapp_messages_by_phone ON whatsapp_messages(phone,created_at DESC)').run();
}
