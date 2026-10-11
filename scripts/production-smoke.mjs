import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const image = process.argv[2] || 'estasinvitado-notifications:verify';
const name = `notifications-smoke-${Date.now()}`;
const adminKey = randomBytes(32).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const runNode = code => docker('exec', name, 'node', '--input-type=module', '-e', code);
async function start(databasePath) {
  docker('run', '-d', '--name', name, '--network', 'none',
    '-e', 'RESEND_API_KEY=test-no-delivery', '-e', `ADMIN_API_KEY=${adminKey}`,
    '-e', `DATABASE_PATH=${databasePath}`, '-v', `${name}:/data`, image);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      runNode("const r = await fetch('http://127.0.0.1:28461/health'); if (!r.ok) process.exit(1);");
      return;
    } catch { await setTimeout(300); }
  }
  throw new Error(`Container failed to start with ${databasePath}`);
}
try {
  await start('./.local/notifications.sqlite');
  assert.equal(docker('exec', name, 'id', '-u'), '1000');
  runNode(`
    const r = await fetch('http://127.0.0.1:28461/v1/admin/invitations', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.ADMIN_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'storage-check', name: 'Storage check', from: 'test@example.com', recipients: ['organizer@example.com'] })
    });
    if (r.status !== 201) throw new Error('Registration failed');
  `);
  runNode("const fs = await import('node:fs'); if (fs.realpathSync('/app/.local/notifications.sqlite') !== '/data/notifications.sqlite') throw new Error('Database outside volume');");
  // Recreate the container, preserving only the data volume.
  docker('stop', '-t', '5', name);
  docker('rm', name);
  await start('/data/notifications.sqlite');
  runNode(`
    const r = await fetch('http://127.0.0.1:28461/v1/admin/invitations', {
      headers: { Authorization: 'Bearer ' + process.env.ADMIN_API_KEY }
    });
    const body = await r.json();
    if (!r.ok || !body.invitations.some(i => i.id === 'storage-check')) throw new Error('Persistent data missing');
  `);
  const healthcheck = JSON.parse(docker('inspect', name))[0].Config.Healthcheck.Test;
  assert.equal(healthcheck[0], 'CMD-SHELL');
  docker('exec', name, 'sh', '-c', healthcheck[1]);
  console.log('PASS: non-root startup, legacy database path, persistent volume after recreation, image healthcheck');
} finally {
  try { docker('rm', '-f', name); } catch {}
  try { docker('volume', 'rm', name); } catch {}
}
