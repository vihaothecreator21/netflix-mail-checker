export const WINDOW_MS = 15 * 60 * 1000;
const STATUSES = new Set(['found', 'not_found', 'unreadable', 'unauthorized', 'rate_limited', 'error']);

export function consumeKey(location, history) {
  const key = new URLSearchParams(location.hash.slice(1)).get('key') || '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return /^[a-f0-9]{64}$/.test(key) ? key : '';
}

export function validEndpoint(value) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value || '');
}

export function validateResponse(data) {
  if (!data || !STATUSES.has(data.status) || !Number.isFinite(Date.parse(data.checkedAt))) {
    throw new Error('INVALID_RESPONSE');
  }
  if (data.status === 'found') {
    const received = Date.parse(data.receivedAt);
    const checked = Date.parse(data.checkedAt);
    if (!/^\d{4}$/.test(data.otp) || typeof data.otp !== 'string' ||
        !Number.isFinite(received) || received > checked || checked - received >= WINDOW_MS ||
        Date.parse(data.hideAt) !== received + WINDOW_MS) throw new Error('INVALID_RESPONSE');
  } else if (data.otp !== null || data.hideAt !== null) {
    throw new Error('INVALID_RESPONSE');
  }
  if (data.status === 'rate_limited' &&
      (!Number.isInteger(data.retryAfterSeconds) || data.retryAfterSeconds < 1 || data.retryAfterSeconds > 86400)) {
    throw new Error('INVALID_RESPONSE');
  }
  return data;
}

export async function checkCode(endpoint, key, signal) {
  const response = await fetch(endpoint, {
    method: 'POST',
    body: new URLSearchParams({ key }),
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!response.ok) throw new Error('CONNECTION_FAILED');
  return validateResponse(await response.json());
}
