const WINDOW_MS = 15 * 60 * 1000;
const COOLDOWN_MS = 30 * 1000;
const DAILY_LIMIT = 1000;
const MAX_MESSAGES = 50;

function response_(status, extra) {
  return Object.assign({
    status: status,
    otp: null,
    receivedAt: null,
    checkedAt: new Date().toISOString(),
    hideAt: null,
  }, extra || {});
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_(response_('unauthorized'));
}

function doPost(e) {
  try {
    if (!e || !e.postData || e.postData.length > 1024 ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(e.postData.type || '') ||
        !e.parameters || !e.parameters.key || e.parameters.key.length !== 1) {
      return json_(response_('unauthorized'));
    }
    const key = e.parameters.key[0];
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return json_(response_('unauthorized'));
    const store = PropertiesService.getScriptProperties();
    const props = store.getProperties();
    const keyId = authenticate_(key, props);
    if (!keyId) return json_(response_('unauthorized'));
    const blocked = reserveCheck_(store, keyId, Date.now(), props['ACCESS_KEY_' + keyId]);
    if (blocked) return json_(blocked);
    if (e.parameters.probe && e.parameters.probe.length === 1 && e.parameters.probe[0] === '1') {
      return json_(response_('not_found'));
    }
    return json_(checkMailbox_(readConfig_(props), Date.now()));
  } catch (_) {
    // Never log exceptions: Gmail errors can contain message data or credentials.
    return json_(response_('error'));
  }
}

function equalHash_(left, right) {
  let difference = left.length ^ right.length;
  for (let i = 0; i < 64; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function authenticate_(key, props) {
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8)
    .map(function (byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
  const names = Object.keys(props).filter(function (name) { return /^ACCESS_KEY_[a-z0-9_-]{1,32}$/.test(name); });
  if (names.length > 10) throw new Error('KEY_CONFIGURATION');
  let match = null;
  names.forEach(function (name) {
    const entry = JSON.parse(props[name]);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.hash) || typeof entry.enabled !== 'boolean') {
      throw new Error('KEY_CONFIGURATION');
    }
    if (equalHash_(hash, entry.hash) && entry.enabled) match = name.slice('ACCESS_KEY_'.length);
  });
  return match;
}

function reserveCheck_(store, keyId, now, expectedEntry) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return response_('rate_limited', { retryAfterSeconds: 5 });
  try {
    // Read again under the lock; concurrent requests must not share a reservation.
    const entry = store.getProperty('ACCESS_KEY_' + keyId);
    if (!entry || entry !== expectedEntry || JSON.parse(entry).enabled !== true) return response_('unauthorized');
    const day = new Date(now).toISOString().slice(0, 10);
    const global = JSON.parse(store.getProperty('RATE_GLOBAL') || 'null');
    if (global && (typeof global.day !== 'string' || !Number.isInteger(global.count) || global.count < 0)) {
      throw new Error('RATE_CONFIGURATION');
    }
    const count = global && global.day === day ? global.count : 0;
    if (count >= DAILY_LIMIT) {
      const nextDay = Date.parse(day + 'T00:00:00.000Z') + 86400000;
      return response_('rate_limited', { retryAfterSeconds: Math.max(1, Math.ceil((nextDay - now) / 1000)) });
    }
    const lastValue = store.getProperty('RATE_' + keyId);
    const last = lastValue === null ? null : Number(lastValue);
    if (last !== null && (!Number.isFinite(last) || last < 0)) throw new Error('RATE_CONFIGURATION');
    if (last !== null && now - last < COOLDOWN_MS) {
      return response_('rate_limited', {
        retryAfterSeconds: Math.min(30, Math.max(1, Math.ceil((COOLDOWN_MS - (now - last)) / 1000))),
      });
    }
    const updates = {};
    updates['RATE_' + keyId] = String(now);
    updates.RATE_GLOBAL = JSON.stringify({ day: day, count: count + 1 });
    store.setProperties(updates, false);
    return null;
  } finally {
    lock.releaseLock();
  }
}

function readConfig_(props) {
  if (!/^Label_[A-Za-z0-9_-]+$/.test(props.NETFLIX_LABEL_ID || '')) throw new Error('LABEL_CONFIGURATION');
  const senders = JSON.parse(props.NETFLIX_SENDERS || 'null');
  if (!Array.isArray(senders) || !senders.length || senders.length > 10 || senders.some(function (sender) {
    return typeof sender !== 'string' || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9-]+\.)*netflix\.com$/.test(sender);
  })) throw new Error('SENDER_CONFIGURATION');
  return { labelId: props.NETFLIX_LABEL_ID, senders: senders };
}

function senderAddress_(headers) {
  const matches = (headers || []).filter(function (header) { return header.name.toLowerCase() === 'from'; });
  if (matches.length !== 1) return '';
  const value = matches[0].value.trim();
  const angle = value.match(/<([^<>]+)>\s*$/);
  const address = (angle ? angle[1] : value).trim().toLowerCase();
  return /^[^\s<>@]+@[^\s<>@]+$/.test(address) ? address : '';
}

function checkMailbox_(config, now) {
  const query = 'after:' + (Math.floor((now - WINDOW_MS) / 1000) - 1) + ' {' + config.senders.map(function (sender) {
    return 'from:' + sender;
  }).join(' ') + '}';
  const list = Gmail.Users.Messages.list('me', {
    labelIds: [config.labelId], q: query, maxResults: MAX_MESSAGES, includeSpamTrash: false,
  });
  // ponytail: 50 candidates/check; fail closed on overflow, paginate if real volume requires it.
  if (list.nextPageToken) throw new Error('TOO_MANY_MESSAGES');
  let newest = null;
  let sameTime = false;
  (list.messages || []).forEach(function (item) {
    const message = Gmail.Users.Messages.get('me', item.id, {
      format: 'metadata', metadataHeaders: ['From'], fields: 'id,internalDate,payload/headers',
    });
    const received = Number(message.internalDate);
    if (!Number.isFinite(received) || received > now || now - received >= WINDOW_MS ||
        config.senders.indexOf(senderAddress_(message.payload && message.payload.headers)) === -1) return;
    if (!newest || received > newest.received) {
      newest = { id: item.id, received: received };
      sameTime = false;
    } else if (received === newest.received) sameTime = true;
  });
  if (!newest) return response_('not_found');
  if (sameTime) return response_('unreadable');
  const message = Gmail.Users.Messages.get('me', newest.id, { format: 'full', fields: 'internalDate,payload' });
  if (Number(message.internalDate) !== newest.received ||
      config.senders.indexOf(senderAddress_(message.payload && message.payload.headers)) === -1) {
    return response_('unreadable');
  }
  const code = extractCode_(message.payload);
  const checked = Date.now();
  if (checked - newest.received >= WINDOW_MS) return response_('not_found');
  if (!code) return response_('unreadable', { receivedAt: new Date(newest.received).toISOString() });
  return response_('found', {
    otp: code,
    receivedAt: new Date(newest.received).toISOString(),
    checkedAt: new Date(checked).toISOString(),
    hideAt: new Date(newest.received + WINDOW_MS).toISOString(),
  });
}

function htmlText_(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':' };
  return html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:br|p|div|tr|td|h[1-6]|li|table)\b[^>]*>/gi, '\n')
    .replace(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|colon);/gi, function (_, name) {
      if (name[0] !== '#') return entities[name.toLowerCase()];
      const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ' ';
    });
}

function contextualCodes_(text) {
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const context = '(?:(?:your\\s+)?(?:netflix\\s+)?(?:sign[\\s-]?in|log[\\s-]?in|verification|one[\\s-]?time|temporary(?:\\s+access)?|access|security|authentication)\\s+(?:code|passcode)|(?:your\\s+)?netflix\\s+code|ma\\s+(?:dang\\s*nhap|xac\\s*minh|xac\\s*thuc|truy\\s*cap(?:\\s+tam\\s*thoi)?|bao\\s*mat)|(?:use|enter)\\s+(?:this|the|your)\\s+(?:code|passcode)\\s+to\\s+(?:sign[\\s-]?in|log[\\s-]?in)|(?:su dung|nhap)\\s+ma(?:\\s+nay)?\\s+de\\s+dang\\s*nhap)';
  const patterns = [
    new RegExp(context + '\\s*(?:(?:cua ban(?:\\s+la)?|is|la)\\s*)?[:：\\-–—]?\\s*(?<![\\p{L}\\p{N}])(\\d{4})(?![\\p{L}\\p{N}])', 'gu'),
    new RegExp('(?<![\\p{L}\\p{N}])(\\d{4})(?![\\p{L}\\p{N}])\\s+(?:is|la)\\s+(?:your\\s+)?' + context, 'gu'),
  ];
  const codes = new Set();
  patterns.forEach(function (pattern) {
    let match;
    while ((match = pattern.exec(folded)) !== null) {
      const offset = match.index + match[0].indexOf(match[1]);
      const before = folded.slice(Math.max(0, offset - 16), offset);
      const after = folded.slice(offset + 4);
      if (/\d[\s()./+-]*$/.test(before) || /^[\s()./+-]*\d/.test(after)) continue;
      codes.add(match[1]);
    }
  });
  return Array.from(codes);
}

function extractCode_(payload) {
  const plain = [];
  const html = [];
  let size = 0;
  let nodes = 0;
  function visit(part, depth) {
    if (!part || depth > 20 || ++nodes > 100) throw new Error('MIME_LIMIT');
    const attachment = (part.headers || []).some(function (header) {
      return header.name.toLowerCase() === 'content-disposition' && /^attachment\b/i.test(header.value);
    });
    if (part.filename || attachment) return;
    if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
      if (part.body && part.body.attachmentId && !part.body.data) throw new Error('MIME_BODY_UNAVAILABLE');
      if (part.body && part.body.data) {
        size += part.body.data.length;
        if (size > 350000) throw new Error('MIME_LIMIT');
        const text = Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString('UTF-8');
        (part.mimeType === 'text/plain' ? plain : html).push(text);
      }
    }
    (part.parts || []).forEach(function (child) { visit(child, depth + 1); });
  }
  visit(payload, 0);
  const plainCodes = contextualCodes_(plain.join('\n'));
  const htmlCodes = contextualCodes_(html.map(htmlText_).join('\n'));
  if (plainCodes.length > 1 || htmlCodes.length > 1 ||
      (plainCodes.length && htmlCodes.length && plainCodes[0] !== htmlCodes[0])) return null;
  return plainCodes[0] || htmlCodes[0] || null;
}

function authorizeOwner() {
  // Run once in the Apps Script editor as the mailbox owner. Logs no mailbox data.
  Gmail.Users.Labels.list('me');
}

function configureNetflixLabel() {
  const labels = (Gmail.Users.Labels.list('me').labels || []).filter(function (label) {
    return label.name === 'NetflixVerification';
  });
  if (labels.length !== 1) throw new Error('Create the Gmail label NetflixVerification first.');
  PropertiesService.getScriptProperties().setProperty('NETFLIX_LABEL_ID', labels[0].id);
}
