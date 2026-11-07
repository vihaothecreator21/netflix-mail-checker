import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { consumeKey, validateResponse, validEndpoint, checkCode, WINDOW_MS } from '../src/api.js';

const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-07T08:00:00.000Z');
const KEY = 'a'.repeat(64); // Synthetic fixture, never a deployed credential.
const hash = (key) => createHash('sha256').update(key).digest('hex');
const entry = (key = KEY) => JSON.stringify({ hash: hash(key), enabled: true });
const part = (text, mimeType = 'text/plain') => ({ mimeType, body: { data: Buffer.from(text).toString('base64url') } });
const mail = (id, text, age = 60000, mimeType = 'text/plain', sender = 'info@account.netflix.com') => ({
  id, internalDate: String(NOW - age),
  payload: { ...part(text, mimeType), headers: [{ name: 'From', value: `Netflix <${sender}>` }] },
});

function harness(messages = [], overrides = {}) {
  let clock = NOW;
  let locked = false;
  let onWrite = null;
  let onLock = null;
  let listResult = null;
  const calls = [];
  const props = {
    NETFLIX_LABEL_ID: 'Label_123',
    NETFLIX_SENDERS: '["info@account.netflix.com"]',
    ACCESS_KEY_family: entry(),
    ...overrides,
  };
  const store = {
    getProperties: () => ({ ...props }),
    getProperty: (name) => props[name] ?? null,
    setProperties: (updates) => { Object.assign(props, updates); if (onWrite) { const hook = onWrite; onWrite = null; hook(); } },
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = vm.createContext({
    Date: Clock,
    PropertiesService: { getScriptProperties: () => store },
    LockService: { getScriptLock: () => ({
      tryLock: () => {
        if (locked) return false;
        locked = true;
        if (onLock) { const hook = onLock; onLock = null; hook(); }
        return true;
      },
      releaseLock: () => { locked = false; },
    }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (content) => ({ content, setMimeType() { return this; } }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, value) => [...createHash('sha256').update(value).digest()].map((b) => b > 127 ? b - 256 : b),
      base64DecodeWebSafe: (data) => Buffer.from(data, 'base64url'),
      newBlob: (data) => ({ getDataAsString: () => Buffer.from(data).toString('utf8') }),
    },
    Gmail: { Users: { Messages: {
      list: (_, options) => { calls.push({ kind: 'list', options }); return listResult || { messages: messages.map(({ id }) => ({ id })) }; },
      get: (_, id, options) => {
        calls.push({ kind: options.format, id });
        const message = messages.find((item) => item.id === id);
        if (!message) throw new Error('PRIVATE_MAILBOX_ERROR');
        return options.format === 'metadata'
          ? { id, internalDate: message.internalDate, payload: { headers: message.payload.headers } }
          : message;
      },
    }, Labels: { list: () => ({ labels: [] }) } } },
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  const event = (key = KEY) => ({ parameters: { key: [key] }, postData: { type: 'application/x-www-form-urlencoded;charset=UTF-8', length: 68 } });
  return {
    api: context, props, calls,
    check: (key = KEY) => JSON.parse(context.doPost(event(key)).content),
    request: (value) => JSON.parse(context.doPost(value).content),
    advance: (ms) => { clock += ms; },
    duringWrite: (hook) => { onWrite = hook; },
    duringLock: (hook) => { onLock = hook; },
    setList: (value) => { listResult = value; },
  };
}

let checks = 0;
function test(name, run) {
  run();
  checks++;
  console.log(`OK ${name}`);
}

test('leading zero; Google internalDate; read-only newest body', () => {
  const h = harness([mail('one', 'Your Netflix sign-in code is: 0123')]);
  const result = h.check();
  assert.equal(result.status, 'found');
  assert.equal(result.otp, '0123');
  assert.equal(result.receivedAt, new Date(NOW - 60000).toISOString());
  assert.equal(Date.parse(result.hideAt) - Date.parse(result.receivedAt), WINDOW_MS);
  assert.deepEqual(h.calls.map((c) => c.kind), ['list', 'metadata', 'full']);
  assert.equal(h.calls[0].options.labelIds[0], 'Label_123');
  validateResponse(result);
});

test('Vietnamese, reverse context, HTML entities and nested MIME', () => {
  const h = harness();
  for (const text of ['Mã đăng nhập của bạn là: 0123', '0123 là mã xác minh của bạn', '0123 is your Netflix sign-in code', 'Your Netflix code: 0123', 'Use this code to sign in: 0123']) {
    assert.equal(h.api.extractCode_(part(text)), '0123');
  }
  const html = '<html><head><style>.x{width:2026px}</style></head><body><p>Mã xác minh:</p><b>&#48;&#49;&#x32;3</b><p>© 2026</p><img src="https://example.invalid/0123"></body></html>';
  assert.equal(h.api.extractCode_({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [part('No code here'), part(html, 'text/html')] }] }), '0123');
});

test('reject years, phones, six digits, dates, ambiguous codes and unrelated numbers', () => {
  const h = harness();
  for (const text of [
    'Copyright 2026. Call +84 0123 456789.',
    'Your sign-in code is 123456',
    'Your sign-in code is AB0123',
    'Your sign-in code is 0123 456789',
    'Your verification code: 2026-11-07',
    'Your sign-in code is 0123. Your verification code is 4567.',
    'Your sign-in code expires in 2026.',
    'Use the Get Code link to retrieve your code.',
  ]) assert.equal(h.api.extractCode_(part(text)), null);
  assert.equal(h.api.extractCode_(part('Your code is 0123. Your sign-in code is 0123.')), '0123');
});

test('ignore attachments and script text; never execute HTML', () => {
  const h = harness();
  assert.equal(h.api.extractCode_({ mimeType: 'multipart/mixed', parts: [
    part('No code'), { ...part('Your sign-in code: 0123'), filename: 'message.txt' },
  ] }), null);
  assert.equal(h.api.extractCode_(part('<script>Your sign-in code: 0123</script><p>Nothing</p>', 'text/html')), null);
  assert.equal(h.api.extractCode_(part('<a title="> Your sign-in code: 0123">Nothing</a>', 'text/html')), null);
  assert.equal(h.api.extractCode_({ mimeType: 'multipart/alternative', parts: [
    part('Your sign-in code: 0123'), part('<p>Your sign-in code: 4567</p>', 'text/html'),
  ] }), null);
  assert.throws(() => h.api.extractCode_({ mimeType: 'text/plain', body: { attachmentId: 'large' } }));
});

test('newest unreadable message never falls back to older code', () => {
  const h = harness([mail('old', 'Your sign-in code: 0123', 120000), mail('new', 'Please click Get Code', 30000)]);
  const result = h.check();
  assert.equal(result.status, 'unreadable');
  assert.equal(result.otp, null);
  assert.deepEqual(h.calls.filter((c) => c.kind === 'full').map((c) => c.id), ['new']);
});

test('empty, expired, future and unapproved senders return no old code', () => {
  for (const messages of [[], [mail('old', 'Your sign-in code: 0123', WINDOW_MS)], [mail('future', 'Your sign-in code: 0123', -1)], [mail('spoof', 'Your sign-in code: 0123', 1000, 'text/plain', 'info@account.netflix.com.evil.example')]]) {
    const h = harness(messages);
    assert.equal(h.check().status, 'not_found');
    assert.equal(h.calls.filter((c) => c.kind === 'full').length, 0);
  }
});

test('choose latest internalDate regardless of list order; tie fails closed', () => {
  const h = harness([mail('latest', 'Your sign-in code: 0123', 1000), mail('older', 'Your sign-in code: 4567', 5000)]);
  assert.equal(h.check().otp, '0123');
  const tied = harness([mail('one', 'Your sign-in code: 0123'), mail('two', 'Your sign-in code: 4567')]);
  assert.equal(tied.check().status, 'unreadable');
});

test('invalid, missing, revoked and duplicate keys never access Gmail', () => {
  const h = harness();
  for (const key of ['', 'b'.repeat(64), 'A'.repeat(64), 'bad']) assert.equal(h.check(key).status, 'unauthorized');
  assert.equal(h.request({ parameters: { key: [KEY, KEY] }, postData: { type: 'application/x-www-form-urlencoded', length: 100 } }).status, 'unauthorized');
  assert.equal(h.request({ parameters: { key: [KEY] }, postData: { type: 'application/json', length: 70 } }).status, 'unauthorized');
  h.props.ACCESS_KEY_family = JSON.stringify({ hash: hash(KEY), enabled: false });
  assert.equal(h.check().status, 'unauthorized');
  delete h.props.ACCESS_KEY_family;
  assert.equal(h.check().status, 'unauthorized');
  assert.equal(h.calls.length, 0);
  assert.equal(JSON.parse(h.api.doGet().content).status, 'unauthorized');
});

test('revocation or key rotation while acquiring lock blocks access', () => {
  for (const replacement of [JSON.stringify({ hash: hash(KEY), enabled: false }), entry('b'.repeat(64))]) {
    const h = harness();
    h.duringLock(() => { h.props.ACCESS_KEY_family = replacement; });
    assert.equal(h.check().status, 'unauthorized');
    assert.equal(h.calls.length, 0);
  }
});

test('transport probe authenticates and rate-limits without reading Gmail', () => {
  const h = harness([], { NETFLIX_SENDERS: 'not configured' });
  const event = { parameters: { key: [KEY], probe: ['1'] }, postData: { type: 'application/x-www-form-urlencoded', length: 76 } };
  assert.equal(h.request(event).status, 'not_found');
  assert.equal(h.request(event).status, 'rate_limited');
  assert.equal(h.calls.length, 0);
  assert.equal(h.request({ ...event, parameters: { key: ['b'.repeat(64)], probe: ['1'] } }).status, 'unauthorized');
});

test('per-link cooldown, independent keys, daily cap and UTC reset', () => {
  const h = harness([], { ACCESS_KEY_other: entry('b'.repeat(64)) });
  assert.equal(h.check().status, 'not_found');
  assert.equal(h.check().retryAfterSeconds, 30);
  h.advance(29999);
  assert.equal(h.check().retryAfterSeconds, 1);
  assert.equal(h.check('b'.repeat(64)).status, 'not_found');
  h.advance(1);
  assert.equal(h.check().status, 'not_found');
  h.props.RATE_GLOBAL = JSON.stringify({ day: '2026-11-07', count: 1000 });
  h.advance(30000);
  const capped = h.check();
  assert.equal(capped.status, 'rate_limited');
  validateResponse(capped);
  h.advance(86400000);
  assert.equal(h.check().status, 'not_found');
  assert.equal(JSON.parse(h.props.RATE_GLOBAL).count, 1);
});

test('concurrent reservation uses lock and counts once', () => {
  const h = harness();
  let concurrent;
  h.duringWrite(() => { concurrent = h.check(); });
  assert.equal(h.check().status, 'not_found');
  assert.equal(concurrent.status, 'rate_limited');
  assert.equal(JSON.parse(h.props.RATE_GLOBAL).count, 1);
  assert.equal(h.calls.filter((c) => c.kind === 'list').length, 1);
});

test('configuration, pagination and Gmail failures return sanitized errors', () => {
  const broken = harness([], { NETFLIX_SENDERS: '["bad@example.com"]' });
  assert.equal(broken.check().status, 'error');
  const overflow = harness();
  overflow.setList({ messages: [], nextPageToken: 'more' });
  assert.equal(overflow.check().status, 'error');
  const unavailable = harness();
  unavailable.setList({ messages: [{ id: 'missing' }] });
  const result = unavailable.check();
  assert.equal(result.status, 'error');
  assert.equal(result.otp, null);
  assert(!JSON.stringify(result).includes('PRIVATE_MAILBOX_ERROR'));
  const manyKeys = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`ACCESS_KEY_${i}`, entry()]));
  const tooMany = harness([], manyKeys);
  assert.equal(tooMany.check().status, 'error');
  assert.equal(tooMany.calls.length, 0);
});

test('private fragment consumed once without browser storage', () => {
  let target;
  const location = { hash: `#key=${KEY}`, pathname: '/checker/', search: '?lang=vi' };
  const history = { replaceState: (_, __, url) => { target = url; location.hash = ''; } };
  assert.equal(consumeKey(location, history), KEY);
  assert.equal(target, '/checker/?lang=vi');
  assert.equal(consumeKey(location, history), '');
  assert.equal(consumeKey({ hash: '#key=wrong', pathname: '/', search: '' }, history), '');
});

test('frontend validates endpoint and refuses malformed or expired results', () => {
  assert(validEndpoint('https://script.google.com/macros/s/example_1/exec'));
  for (const value of ['', 'http://script.google.com/macros/s/id/exec', 'https://evil.example/exec', 'https://script.google.com/macros/s/id/exec?key=secret']) assert(!validEndpoint(value));
  const found = harness([mail('one', 'Your sign-in code: 0123')]).check();
  for (const patch of [
    { otp: 1234 }, { otp: '123456' }, { status: 'unknown' }, { checkedAt: 'bad' },
    { hideAt: 'bad' }, { receivedAt: new Date(NOW + 1).toISOString() },
    { checkedAt: found.hideAt }, { status: 'error' },
  ]) assert.throws(() => validateResponse({ ...found, ...patch }));
  assert.throws(() => validateResponse({ status: 'rate_limited', otp: null, hideAt: null, checkedAt: new Date(NOW).toISOString(), retryAfterSeconds: Infinity }));
});

test('link generator stores only hash in deployment property; no secret printed', () => {
  const output = execFileSync(process.execPath, ['scripts/create-link.mjs', 'test-family', 'https://example.github.io/checker/'], { encoding: 'utf8' });
  assert(!output.includes('#key='));
  const path = output.split(/\r?\n/)[0].replace('Đã tạo file riêng: ', '');
  assert.equal(dirname(path), join(tmpdir(), 'netflix-code-checker'));
  assert.match(basename(path), /^test-family-[a-f0-9]+\.private\.json$/);
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const key = new URL(data.privateLink).hash.slice('#key='.length);
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(data.propertyName, 'ACCESS_KEY_test-family');
    assert.equal(JSON.parse(data.propertyValue).hash, hash(key));
    assert(!data.propertyValue.includes(key));
  } finally { unlinkSync(path); }
  assert.equal(spawnSync(process.execPath, ['scripts/create-link.mjs', '../bad', 'http://example.com']).status, 1);
});

const originalFetch = globalThis.fetch;
try {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => harness().check() };
  };
  const response = await checkCode('https://script.google.com/macros/s/test/exec', KEY);
  assert.equal(response.status, 'not_found');
  assert.equal(request.options.body.get('key'), KEY);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.redirect, 'follow');
  assert.equal(request.options.mode, undefined);
  assert.equal(request.options.headers, undefined);
  console.log('OK simple POST, no preflight headers, redirects followed');
  checks++;
} finally { globalThis.fetch = originalFetch; }

console.log(`${checks} checks passed.`);
