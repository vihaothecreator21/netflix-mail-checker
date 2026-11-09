const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const LOGIN_MS = 10 * 60 * 1000;

function googleJson_(url, options) {
  const result = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true, followRedirects: false }, options || {}));
  let data;
  try { data = JSON.parse(result.getContentText()); } catch (_) { throw new Error('GOOGLE_RESPONSE'); }
  if (result.getResponseCode() < 200 || result.getResponseCode() >= 300) {
    throw new Error(data.error === 'invalid_grant' || result.getResponseCode() === 401 ? 'NOT_CONNECTED' : 'GOOGLE_REQUEST');
  }
  return data;
}

function oauthConfig_(props) {
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(props.OAUTH_CLIENT_ID || '') ||
      !props.OAUTH_CLIENT_SECRET || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(props.BACKEND_URL || '')) {
    throw new Error('OAUTH_CONFIGURATION');
  }
  return { client_id: props.OAUTH_CLIENT_ID, client_secret: props.OAUTH_CLIENT_SECRET, redirect_uri: props.BACKEND_URL };
}

function mailboxToken_(props) {
  const config = oauthConfig_(props);
  try {
    const token = googleJson_('https://oauth2.googleapis.com/token', {
      method: 'post', payload: Object.assign(config, { grant_type: 'refresh_token', refresh_token: props.MAILBOX_REFRESH_TOKEN }),
    });
    if (typeof token.access_token !== 'string') throw new Error('GOOGLE_RESPONSE');
    return token.access_token;
  } catch (error) {
    if (error.message === 'NOT_CONNECTED') PropertiesService.getScriptProperties().setProperty('MAILBOX_CONNECTED', 'false');
    throw error;
  }
}

function one_(parameters, name) {
  return parameters && parameters[name] && parameters[name].length === 1 ? parameters[name][0] : '';
}

function ownerAction_(parameters, store) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { status: 'busy' };
  try {
    const props = store.getProperties();
    // Rotation also invalidates an owner request waiting for this lock.
    if (!equalHash_(sha256_(one_(parameters, 'key')), props.OWNER_SETUP_HASH || '')) return { status: 'unauthorized' };
    const action = one_(parameters, 'action');
    if (action === 'owner_status') return {
      status: 'owner_status', configured: !!props.OAUTH_CLIENT_ID && !!props.OAUTH_CLIENT_SECRET && !!props.BACKEND_URL,
      connected: props.MAILBOX_CONNECTED === 'true', email: props.MAILBOX_EMAIL || null,
    };
    const config = oauthConfig_(props);
    const state = one_(parameters, 'state');
    if (!/^[a-f0-9]{64}$/.test(state)) return { status: 'invalid_request' };
    const now = Date.now();
    const pending = JSON.parse(props.OAUTH_PENDING || 'null');
    if (pending && now - pending.started >= LOGIN_MS) store.deleteProperty('OAUTH_PENDING');
    if (action === 'owner_start') {
      const nonce = one_(parameters, 'nonce');
      const challenge = one_(parameters, 'challenge');
      if (!/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(challenge)) return { status: 'invalid_request' };
      if (pending && now - pending.started < COOLDOWN_MS) return { status: 'busy' };
      store.setProperty('OAUTH_PENDING', JSON.stringify({ state: state, nonce: nonce, challenge: challenge, started: now, ownerHash: props.OWNER_SETUP_HASH }));
      const bytes = challenge.match(/../g).map(function (pair) { const byte = parseInt(pair, 16); return byte > 127 ? byte - 256 : byte; });
      const query = {
        client_id: config.client_id, redirect_uri: config.redirect_uri, response_type: 'code',
        scope: 'openid email ' + GMAIL_SCOPE, access_type: 'offline', prompt: 'consent select_account',
        state: state, nonce: nonce, code_challenge: Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''), code_challenge_method: 'S256',
      };
      return { status: 'authorize', url: 'https://accounts.google.com/o/oauth2/v2/auth?' + Object.keys(query).map(function (name) {
        return encodeURIComponent(name) + '=' + encodeURIComponent(query[name]);
      }).join('&') };
    }
    const verifier = one_(parameters, 'verifier');
    if (action !== 'owner_finish' || !pending || pending.state !== state ||
        pending.ownerHash !== props.OWNER_SETUP_HASH || now - pending.started >= LOGIN_MS ||
        !/^[a-f0-9]{64}$/.test(verifier) || !equalHash_(sha256_(verifier), pending.challenge)) return { status: 'expired' };
    if (!pending.code && !pending.denied) return { status: 'pending' };
    // Consume before exchange; replay and concurrent finish requests cannot redeem twice.
    store.deleteProperty('OAUTH_PENDING');
    if (pending.denied) return { status: 'denied' };
    const token = googleJson_('https://oauth2.googleapis.com/token', {
      method: 'post', payload: Object.assign(config, { grant_type: 'authorization_code', code: pending.code, code_verifier: verifier }),
    });
    // ID token comes directly from Google's authenticated HTTPS exchange, never from the browser.
    const claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe((token.id_token || '').split('.')[1] || '')).getDataAsString('UTF-8'));
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== config.client_id ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() || claims.nonce !== pending.nonce ||
        claims.email_verified !== true || typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(claims.email) ||
        typeof claims.sub !== 'string' || !claims.sub || typeof token.refresh_token !== 'string' || !token.refresh_token ||
        !(token.scope || '').split(' ').includes(GMAIL_SCOPE)) throw new Error('OAUTH_CLAIMS');
    if (props.MAILBOX_SUB && props.MAILBOX_SUB !== claims.sub) return { status: 'different_mailbox' };
    store.setProperties({ MAILBOX_REFRESH_TOKEN: token.refresh_token, MAILBOX_EMAIL: claims.email,
      MAILBOX_SUB: claims.sub, MAILBOX_CONNECTED: 'true' }, false);
    return { status: 'connected', email: claims.email };
  } finally { lock.releaseLock(); }
}

function receiveCallback_(parameters) {
  const state = one_(parameters, 'state');
  const code = one_(parameters, 'code');
  const error = one_(parameters, 'error');
  if (!/^[a-f0-9]{64}$/.test(state) || (!code && !error) || code.length > 2048) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const store = PropertiesService.getScriptProperties();
    const pending = JSON.parse(store.getProperty('OAUTH_PENDING') || 'null');
    if (!pending || pending.state !== state || pending.code || pending.denied ||
        pending.ownerHash !== store.getProperty('OWNER_SETUP_HASH') || Date.now() - pending.started >= LOGIN_MS) return;
    if (error) pending.denied = true;
    else pending.code = code;
    store.setProperty('OAUTH_PENDING', JSON.stringify(pending));
  } finally { lock.releaseLock(); }
}
