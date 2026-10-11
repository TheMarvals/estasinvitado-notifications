import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { HttpError, requireValue, email } from './validation.mjs';
import { renderEmail } from './templates.mjs';
export const hash = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, config TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL REFERENCES invitations(id),
        dedupe_key TEXT NOT NULL, payload_hash TEXT NOT NULL, type TEXT NOT NULL,
        email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, next_attempt INTEGER NOT NULL, first_attempt INTEGER,
        lease_until INTEGER, provider_id TEXT, error TEXT,
        UNIQUE(invitation_id, dedupe_key));
      CREATE INDEX IF NOT EXISTS event_queue ON events(status, next_attempt);
      CREATE INDEX IF NOT EXISTS event_rate ON events(invitation_id, created_at);`);
  }
  register(config) {
    if (this.db.prepare('SELECT id FROM invitations WHERE id=?').get(config.id)) throw new HttpError(409, 'Invitation already exists');
    const key = `inv_${randomBytes(32).toString('hex')}`;
    this.db.prepare('INSERT INTO invitations(id,config,key_hash,key_prefix) VALUES(?,?,?,?)').run(config.id, JSON.stringify(config), hash(key), key.slice(0, 12));
    return { ...config, apiKey: key };
  }
  rotate(id) {
    const key = `inv_${randomBytes(32).toString('hex')}`;
    const result = this.db.prepare('UPDATE invitations SET key_hash=?,key_prefix=? WHERE id=?').run(hash(key), key.slice(0, 12), id);
    requireValue(result.changes, 'Invitation not found', 404);
    return { apiKey: key };
  }
  authenticate(key) {
    const row = this.db.prepare('SELECT * FROM invitations WHERE key_hash=? AND enabled=1').get(hash(key));
    return row ? { ...JSON.parse(row.config), enabled: true } : undefined;
  }
  list() {
    return this.db.prepare('SELECT id,config,key_prefix,enabled FROM invitations').all().map(row => ({ ...JSON.parse(row.config), keyPrefix: row.key_prefix, enabled: Boolean(row.enabled) }));
  }
  update(config, enabled) {
    requireValue(this.db.prepare('UPDATE invitations SET config=?,enabled=? WHERE id=?').run(JSON.stringify(config), enabled ? 1 : 0, config.id).changes, 'Invitation not found', 404);
  }
  accept(invitation, key, event, now = Date.now()) {
    const serialized = JSON.stringify(event);
    const digest = hash(serialized);
    const existing = this.db.prepare('SELECT id,payload_hash,status FROM events WHERE invitation_id=? AND dedupe_key=?').get(invitation.id, key);
    if (existing) {
      requireValue(existing.payload_hash === digest, 'Idempotency key already used for a different event', 409);
      return { id: existing.id, status: existing.status, duplicate: true };
    }
    const managedRecipient = invitation.recipientSource === 'invitation';
    requireValue(managedRecipient || !event.organizerEmail, 'This invitation cannot override recipients', 403);
    requireValue(!managedRecipient || email(event.organizerEmail), 'An organizer email from the invitation is required');
    const deliveryConfig = managedRecipient ? { ...invitation, recipients: [event.organizerEmail] } : invitation;
    requireValue(invitation.events.includes(event.type), 'Event not enabled for this invitation', 403);
    const count = this.db.prepare('SELECT count(*) AS count FROM events WHERE invitation_id=? AND created_at>?');
    requireValue(count.get(invitation.id, now - 60_000).count < 30 && count.get(invitation.id, now - 86400_000).count < 1000, 'Invitation rate limit reached', 429);
    const id = randomUUID();
    this.db.prepare('INSERT INTO events(id,invitation_id,dedupe_key,payload_hash,type,email,created_at,next_attempt) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, invitation.id, key, digest, event.type, JSON.stringify(renderEmail(deliveryConfig, event)), now, now);
    return { id, status: 'queued', duplicate: false };
  }
  status(id, invitationId) {
    return this.db.prepare('SELECT id,type,status,attempts,created_at,provider_id,error FROM events WHERE id=? AND invitation_id=?').get(id, invitationId);
  }
  jobs(invitationId) {
    return this.db.prepare('SELECT id,type,status,attempts,created_at,error FROM events WHERE invitation_id=? ORDER BY created_at DESC LIMIT 100').all(invitationId);
  }
  retry(id, now = Date.now()) {
    const job = this.db.prepare('SELECT * FROM events WHERE id=?').get(id);
    requireValue(job, 'Event not found', 404);
    requireValue(job.status === 'failed', 'Only failed events can be retried', 409);
    requireValue(job.first_attempt === null || now - job.first_attempt < 23 * 3600_000,
      'Delivery window expired; reconcile this event in Resend before sending a new event', 409);
    this.db.prepare("UPDATE events SET status='queued',attempts=0,error=NULL,next_attempt=? WHERE id=?").run(now, id);
    return { id, status: 'queued' };
  }
  claim(now = Date.now()) {
    return this.db.prepare(`UPDATE events SET status='sending', attempts=attempts+1, lease_until=?, first_attempt=COALESCE(first_attempt,?)
      WHERE id=(SELECT e.id FROM events e JOIN invitations i ON i.id=e.invitation_id WHERE i.enabled=1 AND
        ((status='queued' AND next_attempt<=?) OR (status='sending' AND lease_until<=?)) ORDER BY created_at LIMIT 1)
      RETURNING *`).get(now + 60_000, now, now, now);
  }
  sent(id, providerId) { this.db.prepare("UPDATE events SET status='sent',provider_id=?,error=NULL,lease_until=NULL WHERE id=?").run(providerId, id); }
  fail(job, error, retryable, delay, now = Date.now()) {
    const retry = retryable && job.attempts < 10 && now - job.first_attempt < 23 * 3600_000;
    this.db.prepare('UPDATE events SET status=?,error=?,next_attempt=?,lease_until=NULL WHERE id=?').run(retry ? 'queued' : 'failed', error, now + delay, job.id);
  }
  close() { this.db.close(); }
}
