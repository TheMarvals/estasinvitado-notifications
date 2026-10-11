export async function deliverNext(store, { apiKey, fetchImpl = fetch, now = Date.now() }) {
  const job = store.claim(now);
  if (!job) return false;
  if (now - job.first_attempt >= 23 * 3600_000) {
    // Resend forgets deduplication keys after 24h. Do not blindly resend an
    // ambiguous delivery once that protection could expire.
    store.fail(job, 'delivery_window_expired', false, 0, now);
    return true;
  }
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `invitation-event/${job.id}` },
      body: job.email,
    });
    if (response.ok) {
      const body = await response.json();
      if (!body.id) throw new Error('Invalid provider response');
      store.sent(job.id, body.id);
    } else {
      let providerError;
      if (response.status === 409) {
        try { providerError = (await response.json()).name; } catch {}
      }
      const retryable = response.status === 429 || response.status >= 500 || response.status === 408 ||
        (response.status === 409 && providerError === 'concurrent_idempotent_requests');
      const retryAfter = response.headers.get('retry-after');
      const wait = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter || '') - now) || 0;
      store.fail(job, `resend_http_${response.status}`, retryable,
        Math.max(wait, Math.min(3600_000, 30_000 * 2 ** (job.attempts - 1))), now);
    }
  } catch {
    store.fail(job, 'provider_unavailable', true, Math.min(3600_000, 30_000 * 2 ** (job.attempts - 1)), now);
  }
  return true;
}
export function startWorker(store, options) {
  let running = false;
  let active = Promise.resolve();
  const tick = () => {
    if (running) return;
    running = true;
    active = deliverNext(store, options).catch(() => console.error('Notification worker failed')).finally(() => { running = false; });
  };
  // One request per second across invitations; no burst after an outage.
  const timer = setInterval(tick, 1000);
  tick();
  return async () => { clearInterval(timer); await active; };
}
