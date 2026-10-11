import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hash } from './store.mjs';
import { HttpError, requireValue, invitationInput, eventInput } from './validation.mjs';
async function jsonBody(req) {
  requireValue(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 'Use application/json', 415);
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    requireValue(length <= 32_768, 'Request body too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
export function createApi({ store, adminKey, defaultFrom }) {
  requireValue(typeof adminKey === 'string' && adminKey.length >= 32, 'ADMIN_API_KEY must contain at least 32 characters');
  const adminHash = Buffer.from(hash(adminKey));
  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/health' && req.method === 'GET') {
        store.db.prepare('SELECT 1').get();
        return send(200, { status: 'ok' });
      }
      const token = /^Bearer (\S{20,256})$/.exec(req.headers.authorization || '')?.[1];
      requireValue(token, 'Unauthorized', 401);
      if (pathname.startsWith('/v1/admin/')) {
        requireValue(timingSafeEqual(Buffer.from(hash(token)), adminHash), 'Unauthorized', 401);
        if (pathname === '/v1/admin/invitations') {
          if (req.method === 'GET') return send(200, { invitations: store.list() });
          if (req.method === 'POST') return send(201, store.register(invitationInput(await jsonBody(req), defaultFrom)));
        }
        const retry = /^\/v1\/admin\/events\/([a-f0-9-]{36})\/retry$/.exec(pathname);
        if (retry && req.method === 'POST') return send(202, store.retry(retry[1]));
        const match = /^\/v1\/admin\/invitations\/([a-z0-9-]+)(?:\/(keys|events))?$/.exec(pathname);
        if (match) {
          const [, id, resource] = match;
          if (resource === 'keys' && req.method === 'POST') return send(200, store.rotate(id));
          if (resource === 'events' && req.method === 'GET') return send(200, { events: store.jobs(id) });
          if (!resource && req.method === 'PATCH') {
            const previous = store.list().find(i => i.id === id);
            requireValue(previous, 'Invitation not found', 404);
            const body = await jsonBody(req);
            requireValue(body && typeof body === 'object' && !Array.isArray(body), 'Invalid invitation');
            requireValue(body.enabled === undefined || typeof body.enabled === 'boolean', 'Invalid enabled');
            const config = invitationInput({ ...previous, ...body, id }, defaultFrom);
            store.update(config, body.enabled ?? previous.enabled);
            return send(200, { ...config, enabled: body.enabled ?? previous.enabled });
          }
        }
      } else {
        const invitation = store.authenticate(token);
        requireValue(invitation, 'Unauthorized', 401);
        if (pathname === '/v1/events' && req.method === 'POST') {
          const key = req.headers['idempotency-key'];
          requireValue(typeof key === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(key), 'A valid Idempotency-Key is required');
          const event = eventInput(await jsonBody(req));
          const result = store.accept(invitation, key, event);
          return send(202, result);
        }
        const match = /^\/v1\/events\/([a-f0-9-]{36})$/.exec(pathname);
        if (match && req.method === 'GET') {
          const event = store.status(match[1], invitation.id);
          requireValue(event, 'Event not found', 404);
          return send(200, event);
        }
      }
      send(404, { error: 'Not found' });
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Notification API request failed');
      if (!res.destroyed) send(error.status || 500, { error: error instanceof HttpError ? error.message : 'Internal error' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
