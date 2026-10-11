import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createApi } from '../src/server.mjs';
import { deliverNext } from '../src/worker.mjs';
import { eventInput } from '../src/validation.mjs';

const admin = 'admin-test-key-'.repeat(4);
const config = id => ({ id, name: 'Nuestra boda', from: 'Bodas <bodas@example.test>', recipients: ['organizer@example.test'], events: ['rsvp.created', 'message.created'] });
const event = (name = 'Ana') => eventInput({ type: 'rsvp.created', data: { name, attendingCeremony: true, attendingParty: false, passes: 2, message: '<img src=x onerror=alert(1)> & cariño' } });
async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'notifications-test-'));
  const store = new Store(path.join(directory, 'test.sqlite'));
  const server = createApi({ store, adminKey: admin, defaultFrom: config('one').from });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { key = admin, method = 'GET', body, dedupe = 'rsvp/1' } = {}) => fetch(base + route, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': dedupe }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { store, request, base };
}
test('tenant API keys scope events; create/rotate/revoke and deduplication work over HTTP', async t => {
  const { store, request } = await fixture(t);
  assert.equal((await request('/v1/admin/invitations', { key: 'invalid'.repeat(8) })).status, 401);
  const a = await (await request('/v1/admin/invitations', { method: 'POST', body: config('wedding-a') })).json();
  const b = await (await request('/v1/admin/invitations', { method: 'POST', body: config('wedding-b') })).json();
  assert.ok(a.apiKey.startsWith('inv_'));
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM invitations').all()).includes(a.apiKey));
  assert.ok(!(await (await request('/v1/admin/invitations')).text()).includes(a.apiKey));
  const send = options => request('/v1/events', { method: 'POST', key: a.apiKey, body: event(), ...options });
  const first = await send(); assert.equal(first.status, 202); const saved = await first.json();
  const duplicate = await (await send()).json(); assert.equal(duplicate.id, saved.id); assert.equal(duplicate.duplicate, true);
  assert.equal((await send({ body: event('Other name') })).status, 409);
  assert.equal((await request(`/v1/events/${saved.id}`, { key: b.apiKey })).status, 404);
  assert.equal((await request(`/v1/events/${saved.id}`, { key: a.apiKey })).status, 200);
  assert.equal((await request('/v1/admin/invitations', { key: a.apiKey })).status, 401);
  // Identical idempotency keys in different invitations are independent.
  assert.equal((await send({ key: b.apiKey })).status, 202);
  const rotated = await (await request('/v1/admin/invitations/wedding-a/keys', { method: 'POST' })).json();
  assert.equal((await send()).status, 401);
  assert.equal((await send({ key: rotated.apiKey })).status, 202);
  assert.equal((await request('/v1/admin/invitations/wedding-a', { method: 'PATCH', body: { enabled: false } })).status, 200);
  assert.equal((await send({ key: rotated.apiKey })).status, 401);
});
test('validation, tenant rate limit, configured recipients and escaped HTML', async t => {
  const { request, store } = await fixture(t);
  assert.equal((await request('/v1/admin/invitations', { method: 'POST', body: { ...config('bad'), from: 'evil\r\nBCC: hidden@example.test' } })).status, 400);
  const tenant = store.register(config('valid'));
  const send = (body, dedupe = 'same') => request('/v1/events', { method: 'POST', body, key: tenant.apiKey, dedupe });
  assert.equal((await send({ type: 'anything', data: {} })).status, 400);
  assert.equal((await send({ type: 'rsvp.created', data: { ...event().data, passes: -1 } })).status, 400);
  assert.equal((await send(event(), 'spaces not allowed')).status, 400);
  const response = await send({ ...event(), to: ['attacker@example.test'], from: 'attacker@example.test' });
  const { id } = await response.json();
  const mail = JSON.parse(store.db.prepare('SELECT email FROM events WHERE id=?').get(id).email);
  assert.deepEqual(mail.to, ['organizer@example.test']); assert.equal(mail.from, config('valid').from);
  assert.ok(!mail.html.includes('<img')); assert.ok(mail.html.includes('&lt;img'));
  for (let i = 1; i < 30; i++) assert.equal((await send(event(), `unique-${i}`)).status, 202);
  assert.equal((await send(event(), 'limited')).status, 429);
  assert.equal((await send(event(), 'same')).status, 202, 'Deduped retries bypass the new-event limit');
});
test('queue survives reopen, retries 429 and network failure with the same provider key, then sends once', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'notifications-persist-'));
  const filename = path.join(directory, 'queue.sqlite');
  let store = new Store(filename);
  try {
    const tenant = store.register(config('persistent'));
    const receipt = store.accept(tenant, 'event/1', event(), 1_000);
    store.close(); store = new Store(filename);
    const keys = []; let calls = 0;
    const fetchImpl = async (_url, options) => {
      keys.push(options.headers['Idempotency-Key']); calls++;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
      if (calls === 2) throw new Error('Network timeout');
      return Response.json({ id: 'resend-accepted-id' });
    };
    await deliverNext(store, { apiKey: 'test', fetchImpl, now: 1_000 });
    assert.equal(store.status(receipt.id, tenant.id).status, 'queued');
    assert.equal(await deliverNext(store, { apiKey: 'test', fetchImpl, now: 120_999 }), false);
    await deliverNext(store, { apiKey: 'test', fetchImpl, now: 121_000 });
    await deliverNext(store, { apiKey: 'test', fetchImpl, now: 181_000 });
    assert.equal(new Set(keys).size, 1); assert.equal(calls, 3);
    assert.equal(store.status(receipt.id, tenant.id).status, 'sent');
    assert.equal(await deliverNext(store, { apiKey: 'test', fetchImpl, now: 200_000 }), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('leases recover crashed jobs and stop ambiguous deliveries after the provider dedupe window', () => {
  const store = new Store(':memory:');
  try {
    const tenant = store.register(config('lease'));
    store.accept(tenant, 'lease/1', event(), 0);
    const first = store.claim(0); assert.ok(first);
    assert.equal(store.claim(59_999), undefined);
    const recovered = store.claim(60_000); assert.equal(recovered.id, first.id); assert.equal(recovered.attempts, 2);
  } finally { store.close(); }
});
test('disabled tenants do not send queued mail; expired ambiguous retries are held', async () => {
  const store = new Store(':memory:');
  try {
    const tenant = store.register(config('disabled'));
    const { id } = store.accept(tenant, 'event/1', event(), 0);
    store.update(config('disabled'), false); assert.equal(store.claim(0), undefined);
    store.update(config('disabled'), true);
    store.claim(0);
    let called = false;
    await deliverNext(store, { apiKey: 'test', now: 24 * 3600_000, fetchImpl: async () => { called = true; } });
    assert.equal(called, false); assert.equal(store.status(id, tenant.id).error, 'delivery_window_expired');
  } finally { store.close(); }
});
test('concurrent provider requests retry, permanent errors require explicit admin retry', async () => {
  const store = new Store(':memory:');
  try {
    const tenant = store.register(config('provider-conflict'));
    const { id } = store.accept(tenant, 'event/1', event(), 0);
    await deliverNext(store, { apiKey: 'test', now: 0, fetchImpl: async () => Response.json({ name: 'concurrent_idempotent_requests' }, { status: 409 }) });
    assert.equal(store.status(id, tenant.id).status, 'queued');
    await deliverNext(store, { apiKey: 'test', now: 30_000, fetchImpl: async () => Response.json({ name: 'validation_error' }, { status: 422 }) });
    assert.equal(store.status(id, tenant.id).status, 'failed');
    assert.equal(store.retry(id, 31_000).status, 'queued');
    await deliverNext(store, { apiKey: 'test', now: 32_000, fetchImpl: async () => Response.json({ id: 'sent-after-fix' }) });
    assert.equal(store.status(id, tenant.id).provider_id, 'sent-after-fix');
    assert.throws(() => store.retry(id, 33_000), /Only failed/);
  } finally { store.close(); }
});
test('only explicitly authorized invitations can supply an organizer email from their editor', async t => {
  const { request, store } = await fixture(t);
  const managedResponse = await request('/v1/admin/invitations', { method: 'POST', body: {
    ...config('editor-managed'), recipientSource: 'invitation', recipients: [],
  } });
  assert.equal(managedResponse.status, 201);
  const managed = await managedResponse.json();
  const fixed = store.register(config('service-managed'));
  const payload = { ...event(), organizerEmail: 'editor-admin@example.test' };
  const send = (key, body) => request('/v1/events', { method: 'POST', key, body });
  assert.equal((await send(fixed.apiKey, payload)).status, 403);
  assert.equal((await send(managed.apiKey, event())).status, 400);
  assert.equal((await send(managed.apiKey, { ...payload, organizerEmail: 'invalid' })).status, 400);
  const response = await send(managed.apiKey, payload);
  assert.equal(response.status, 202);
  const accepted = await response.json();
  const mail = JSON.parse(store.db.prepare('SELECT email FROM events WHERE id=?').get(accepted.id).email);
  assert.deepEqual(mail.to, ['editor-admin@example.test']);
  assert.equal(mail.from, config('editor-managed').from);
  assert.equal((await send(managed.apiKey, { ...payload, organizerEmail: 'different@example.test' })).status, 409);
  assert.deepEqual(store.list().find(i => i.id === 'service-managed').recipients, ['organizer@example.test']);
});
