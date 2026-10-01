/** Host-owned scripts. Never execute SQL, Git hooks, filters, checkout, or reset. */
export const FIND_APPLIED_MIGRATION = String.raw`
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const p = JSON.parse(process.argv[1]);
const git = args => execFileSync('git', ['--no-replace-objects', '-C', p.root, ...args], {
  timeout: 1000, maxBuffer: p.maxBytes + 4096, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' }
});
let checked = 0;
try {
  const commits = git(['log', '--all', '--full-history', '--format=%H', '-n', '81', '--', p.file])
    .toString('utf8').trim().split('\n').filter(Boolean);
  const started = Date.now();
  for (const revision of commits.slice(0, 80)) {
    if (Date.now() - started > 8000) break;
    if (!/^[a-f0-9]{40,64}$/.test(revision)) continue;
    checked++;
    try {
      const object = revision + ':' + p.file;
      const size = Number(git(['cat-file', '-s', object]).toString('utf8').trim());
      if (!Number.isSafeInteger(size) || size < 1 || size > p.maxBytes) continue;
      const bytes = git(['cat-file', 'blob', object]);
      if (bytes.length === size && createHash('sha256').update(bytes).digest('hex') === p.checksum) {
        console.log(JSON.stringify({ revision, content: bytes.toString('base64'), checked }));
        process.exit(0);
      }
    } catch { /* Missing/deleted/oversized blob is not a matching source. */ }
  }
  console.log(JSON.stringify({ checked, limited: commits.length > checked }));
} catch { console.log(JSON.stringify({ checked, unavailable: true })); }
`;

export const RESTORE_APPLIED_MIGRATION = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const p = JSON.parse(process.argv[1]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const target = path.join(p.root, p.file);
const bytes = Buffer.from(p.content, 'base64');
let temporary;
let wrote = false;
function readTarget() {
  if (fs.realpathSync(target) !== target) throw new Error('non_canonical_file');
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > p.maxBytes) throw new Error('unsafe_file');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return { stat, bytes: fs.readFileSync(fd) }; } finally { fs.closeSync(fd); }
}
try {
  if (bytes.length > p.maxBytes || hash(bytes) !== p.checksum) throw new Error('invalid_candidate');
  const before = readTarget();
  if (hash(before.bytes) !== p.previousChecksum) throw new Error('concurrent_file_change');
  // A private backup outside the discovered migration directories preserves pending intent.
  const directory = fs.mkdtempSync('/tmp/apps-migration-restoration-');
  fs.chmodSync(directory, 0o700);
  const backupPath = path.join(directory, p.previousChecksum + '.sql');
  fs.writeFileSync(backupPath, before.bytes, { flag: 'wx', mode: 0o600 });
  temporary = path.join(path.dirname(target), '.migration-restoration-' + randomUUID());
  fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: before.stat.mode & 0o777 });
  const current = readTarget();
  if (current.stat.ino !== before.stat.ino || current.stat.dev !== before.stat.dev ||
      hash(current.bytes) !== p.previousChecksum) throw new Error('concurrent_file_change');
  fs.renameSync(temporary, target);
  temporary = undefined;
  wrote = true;
  if (hash(readTarget().bytes) !== p.checksum) throw new Error('verification_failed');
  console.log(JSON.stringify({ restored: true, backupPath }));
} catch (error) {
  if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
  const reasons = ['non_canonical_file', 'unsafe_file', 'invalid_candidate', 'concurrent_file_change', 'verification_failed'];
  console.log(JSON.stringify({ restored: false, wrote, reason: reasons.includes(error.message) ? error.message : 'filesystem_unavailable' }));
  process.exitCode = 1;
}
`;

export const VERIFY_APPLIED_MIGRATIONS = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const p = JSON.parse(process.argv[1]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  for (const entry of p.entries) {
    const target = path.join(p.root, entry.file);
    if (fs.realpathSync(target) !== target) throw new Error();
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > p.maxBytes || hash(fs.readFileSync(target)) !== entry.checksum) throw new Error();
    if (p.committed) {
      const blob = execFileSync('git', ['--no-replace-objects', '-C', p.root, 'cat-file', 'blob', 'HEAD:' + entry.file],
        { timeout: 1000, maxBuffer: p.maxBytes, stdio: ['ignore', 'pipe', 'pipe'] });
      if (hash(blob) !== entry.checksum) throw new Error();
    }
  }
  console.log('verified');
} catch { console.log('Restored migration bytes are missing or changed in the workspace or commit.'); process.exitCode = 1; }
`;