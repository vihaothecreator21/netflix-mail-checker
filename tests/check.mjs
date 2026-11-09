import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { consumeKey, validateResponse, validEndpoint, checkCode, WINDOW_MS } from '../src/api.js';

const source = ['Code.gs', 'OAuth.gs'].map((file) => readFileSync(new URL(`../apps-script/${file}`, import.meta.url), 'utf8')).join('\n');
const NOW = Date.parse('2026-11-07T08:00:00.000Z');
const KEY = 'a'.repeat(64); // Synthetic fixture, never a deployed credential.
const hash = (key) => createHash('sha256').update(key).digest('hex');
const entry = (key = KEY) => JSON.stringify({ hash: hash(key), enabled: true });
const part = (text, mimeType = 'text/plain') => ({ mimeType, body: { data: Buffer.from(text).toString('base64url') } });
const mail = (id, text, age = 60000, mimeType = 'text/plain', sender = 'info@account.netflix.com') => ({
  id, internalDate: String(NOW - age),
  payload: { ...part(text, mimeType), headers: [{ name: 'From', value: `Netflix <${sender}>` }, { name: 'Subject', value: 'Your Netflix sign-in code' }] },
});

function harness(messages = [], overrides = {}) {
  let clock = NOW;
  let locked = false;
  let onWrite = null;
  let onLock = null;
  let listResult = null;
  let exchange = null;
  let refreshError = false;
  const calls = [];
  const props = {
    NETFLIX_LABEL_ID: 'Label_123',
    NETFLIX_SENDERS: '["info@account.netflix.com"]',
    ACCESS_KEY_family: entry(),
    OWNER_SETUP_HASH: hash('c'.repeat(64)),
    OAUTH_CLIENT_ID: 'test.apps.googleusercontent.com', OAUTH_CLIENT_SECRET: 'synthetic-secret',
    BACKEND_URL: 'https://script.google.com/macros/s/test/exec',
    MAILBOX_REFRESH_TOKEN: 'synthetic-refresh', MAILBOX_CONNECTED: 'true',
    ...overrides,
  };
  const store = {
    getProperties: () => ({ ...props }),
    getProperty: (name) => props[name] ?? null,
    setProperty: (name, value) => { props[name] = value; },
    deleteProperty: (name) => { delete props[name]; },
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
    HtmlService: { createHtmlOutput: (content) => ({ content }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, value) => [...createHash('sha256').update(value).digest()].map((b) => b > 127 ? b - 256 : b),
      base64DecodeWebSafe: (data) => Buffer.from(data, 'base64url'),
      base64EncodeWebSafe: (data) => Buffer.from(data).toString('base64url'),
      newBlob: (data) => ({ getDataAsString: () => Buffer.from(data).toString('utf8') }),
    },
    UrlFetchApp: { fetch: (url, requestOptions) => {
      let result;
      let status = 200;
      if (url === 'https://oauth2.googleapis.com/token') {
        if (requestOptions.payload.grant_type === 'refresh_token') {
          result = refreshError ? { error: 'invalid_grant' } : { access_token: 'synthetic-access' };
          if (refreshError) status = 400;
        } else result = exchange;
      } else {
        assert.equal(requestOptions.headers.Authorization, 'Bearer synthetic-access');
        assert.equal(requestOptions.followRedirects, false);
        const address = new URL(url);
        const id = decodeURIComponent(address.pathname.split('/messages')[1].slice(1));
        const options = Object.fromEntries(address.searchParams);
        options.labelIds = address.searchParams.getAll('labelIds');
        if (!id) { calls.push({ kind: 'list', options }); result = listResult || { messages: messages.map(({ id }) => ({ id })) }; }
        else {
        calls.push({ kind: options.format, id });
        const message = messages.find((item) => item.id === id);
        if (!message) throw new Error('PRIVATE_MAILBOX_ERROR');
        result = options.format === 'metadata'
          ? { id, internalDate: message.internalDate, payload: { headers: message.payload.headers } }
          : message;
        }
      }
      return { getResponseCode: () => status, getContentText: () => JSON.stringify(result) };
    } },
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
    setExchange: (value) => { exchange = value; },
    failRefresh: () => { refreshError = true; },
    owner: (action, values = {}, key = 'c'.repeat(64)) => {
      const parameters = Object.fromEntries(Object.entries({ key, action, ...values }).map(([name, value]) => [name, [value]]));
      return JSON.parse(context.doPost({ parameters, postData: { type: 'application/x-www-form-urlencoded', length: 1000 } }).content);
    },
    callback: (values) => context.doGet({ parameters: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, [value]])) }),
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
  assert(!h.api.doGet().content.includes('0123'));
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

test('automatic filtering without a Gmail label; marketing ignored; latest verification fails closed', () => {
  const marketing = mail('marketing', 'Your sign-in code: 9999', 1);
  marketing.payload.headers[1].value = 'New shows for November';
  const h = harness([marketing, mail('valid', 'Your sign-in code: 0123')], { NETFLIX_LABEL_ID: '', NETFLIX_SENDERS: '[]' });
  assert.equal(h.check().otp, '0123');
  assert.equal(h.calls[0].options.labelIds.length, 0);
  assert.equal(harness([mail('bad', 'Get Code')], { NETFLIX_LABEL_ID: '', NETFLIX_SENDERS: '[]' }).check().status, 'unreadable');
  assert.equal(harness([mail('spoof', 'Your sign-in code: 0123', 1, 'text/plain', 'a@evilnetflix.com')], { NETFLIX_LABEL_ID: '', NETFLIX_SENDERS: '[]' }).check().status, 'not_found');
});

test('unconnected/revoked Gmail never returns stale code or credentials', () => {
  const empty = harness([], { MAILBOX_REFRESH_TOKEN: '' });
  const result = empty.check();
  assert.equal(result.status, 'not_connected');
  validateResponse(result);
  assert.equal(empty.calls.length, 0);
  const revoked = harness();
  revoked.failRefresh();
  assert.equal(revoked.check().status, 'not_connected');
  assert.equal(revoked.props.MAILBOX_CONNECTED, 'false');
});

const login = (h) => {
  const state = 'd'.repeat(64), verifier = 'e'.repeat(64), nonce = 'f'.repeat(64);
  return { state, verifier, nonce, start: () => h.owner('owner_start', { state, nonce, challenge: hash(verifier) }),
    finish: () => h.owner('owner_finish', { state, verifier }) };
};
const token = (patch = {}) => ({
  refresh_token: 'new-synthetic-refresh', access_token: 'synthetic-access',
  scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
  id_token: 'header.' + Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com',
    aud: 'test.apps.googleusercontent.com', exp: NOW / 1000 + 600, nonce: 'f'.repeat(64),
    email_verified: true, email: 'synthetic@example.com', sub: 'synthetic-owner', ...patch,
  })).toString('base64url') + '.signature',
});

test('owner secret isolated from viewer; PKCE, callback binding, one-time exchange and privacy', () => {
  const h = harness();
  assert.equal(h.owner('owner_status', {}, KEY).status, 'unauthorized');
  assert.equal(h.check('c'.repeat(64)).status, 'unauthorized');
  assert.equal(h.owner('owner_status').status, 'owner_status');
  const flow = login(h);
  const start = flow.start();
  assert.equal(start.status, 'authorize');
  const url = new URL(start.url);
  assert.equal(url.searchParams.get('code_challenge'), Buffer.from(hash(flow.verifier), 'hex').toString('base64url'));
  assert.equal(url.searchParams.get('redirect_uri'), h.props.BACKEND_URL);
  assert(!start.url.includes('c'.repeat(64)));
  assert.equal(flow.start().status, 'busy');
  h.callback({ state: '0'.repeat(64), code: 'wrong' });
  assert.equal(flow.finish().status, 'pending');
  const page = h.callback({ state: flow.state, code: 'synthetic-authorization-code' });
  assert(!page.content.includes('synthetic-authorization-code'));
  assert.equal(h.owner('owner_finish', { state: flow.state, verifier: '0'.repeat(64) }).status, 'expired');
  h.setExchange(token());
  const result = flow.finish();
  assert.equal(result.status, 'connected');
  assert.equal(h.props.MAILBOX_REFRESH_TOKEN, 'new-synthetic-refresh');
  assert(!JSON.stringify(result).includes('refresh'));
  assert.equal(flow.finish().status, 'expired');
  assert.equal(h.props.OAUTH_PENDING, undefined);
});

test('denial, expired login, rotated owner secret and simultaneous finish fail closed', () => {
  const denied = harness();
  const first = login(denied); first.start();
  denied.callback({ state: first.state, error: 'access_denied' });
  assert.equal(first.finish().status, 'denied');
  const expired = harness(); const second = login(expired); second.start(); expired.advance(600000);
  expired.callback({ state: second.state, code: 'late-code' });
  assert.equal(second.finish().status, 'expired');
  assert.equal(expired.props.OAUTH_PENDING, undefined);
  const rotated = harness();
  rotated.duringLock(() => { rotated.props.OWNER_SETUP_HASH = hash('0'.repeat(64)); });
  assert.equal(rotated.owner('owner_status').status, 'unauthorized');
  const concurrent = harness(); const third = login(concurrent); third.start();
  concurrent.callback({ state: third.state, code: 'synthetic-code' });
  concurrent.setExchange(token());
  let nested;
  concurrent.duringLock(() => { nested = third.finish(); });
  assert.equal(third.finish().status, 'connected');
  assert.equal(nested.status, 'busy');
});

test('Google claims, missing Gmail grant and another mailbox cannot overwrite the owner', () => {
  for (const patch of [{ aud: 'wrong' }, { iss: 'https://evil.example' }, { exp: NOW / 1000 }, { nonce: 'wrong' }, { email_verified: false }]) {
    const h = harness(); const flow = login(h); flow.start(); h.callback({ state: flow.state, code: 'synthetic-code' });
    h.setExchange(token(patch));
    assert.equal(flow.finish().status, 'error');
    assert.equal(h.props.MAILBOX_REFRESH_TOKEN, 'synthetic-refresh');
  }
  for (const patch of [{ scope: 'openid email' }, { refresh_token: '' }]) {
    const h = harness(); const flow = login(h); flow.start(); h.callback({ state: flow.state, code: 'synthetic-code' });
    h.setExchange({ ...token(), ...patch });
    assert.equal(flow.finish().status, 'error');
  }
  const h = harness([], { MAILBOX_SUB: 'existing-owner' });
  const flow = login(h); flow.start(); h.callback({ state: flow.state, code: 'synthetic-code' }); h.setExchange(token());
  assert.equal(flow.finish().status, 'different_mailbox');
  assert.equal(h.props.MAILBOX_REFRESH_TOKEN, 'synthetic-refresh');
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
  const outputOwner = execFileSync(process.execPath, ['scripts/create-link.mjs', 'owner', 'https://example.github.io/checker/'], { encoding: 'utf8' });
  const ownerPath = outputOwner.split(/\r?\n/)[0].replace('Đã tạo file riêng: ', '');
  try {
    const data = JSON.parse(readFileSync(ownerPath, 'utf8'));
    const url = new URL(data.privateLink);
    assert.equal(url.searchParams.get('setup'), '1');
    assert.equal(data.propertyName, 'OWNER_SETUP_HASH');
    assert.equal(data.propertyValue, hash(new URLSearchParams(url.hash.slice(1)).get('setup')));
  } finally { unlinkSync(ownerPath); }
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
