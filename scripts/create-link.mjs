import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fail() {
  console.error('Cách dùng: npm run create-link -- <ten-link> <https://username.github.io/repository/>');
  process.exitCode = 1;
}

const [name, base, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name || '')) throw new Error('ARGUMENTS');
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('URL');
  const key = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(key).digest('hex');
  const owner = name === 'owner';
  if (owner) url.searchParams.set('setup', '1');
  url.hash = new URLSearchParams({ [owner ? 'setup' : 'key']: key }).toString();
  const directory = join(tmpdir(), 'netflix-code-checker');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}-${randomBytes(6).toString('hex')}.private.json`);
  await writeFile(path, JSON.stringify({
    privateLink: url.href,
    propertyName: owner ? 'OWNER_SETUP_HASH' : `ACCESS_KEY_${name}`,
    propertyValue: owner ? hash : JSON.stringify({ hash, enabled: true }),
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Đã tạo file riêng: ${path}`);
  console.log('Chỉ gửi privateLink cho người nhận. Thêm propertyName/propertyValue vào Script Properties.');
} catch {
  fail();
}
