/** Host-owned, read-only Node script. No project imports, shell, SQL execution or receipts. */
export const READ_ARTIFACT_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const p = JSON.parse(process.argv[1]);
const MAX_ENTRIES = 200, MAX_FILES = 20, MAX_DEPTH = 3, MAX_BYTES = 4000;
const ignored = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor']);
const textExtension = /\.(?:sql|md|mdx|txt|[cm]?[jt]sx?|css|scss|html|json|ya?ml|toml)$/i;
const sensitive = /(?:^|[._-])(?:env|secrets?|credentials?|tokens?|passwords?|private[_-]?key|service[_-]?account)(?:[._-]|$)|\.(?:pem|key|p12|pfx|jks)$/i;
const safePart = name => name && name !== '.' && name !== '..' &&
  !name.startsWith('.') && !ignored.has(name.toLowerCase()) &&
  !sensitive.test(name) && !/[\x00-\x1f\x7f\\/]/.test(name);
const safeRelative = value => typeof value === 'string' && value.length <= 512 &&
  !path.isAbsolute(value) && value.split('/').every(safePart);
function redact(raw) {
  // Redact before output clipping, including incomplete values at the read boundary.
  return raw
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b[\w$]*(?:token|password|passwd|secret|api[_-]?key|service[_-]?(?:role[_-]?)?key|private[_-]?key|authorization|cookie)[\w$]*["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|\x60(?:\\[\s\S]|[^\x60\\])*(?:\x60|$))/gi, '[REDACTED]')
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sb_secret_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED_KEY]')
    .replace(/\b[\w$]*(?:token|password|passwd|secret|api[_-]?key|service[_-]?(?:role[_-]?)?key|private[_-]?key|authorization|cookie)[\w$]*["']?[ \t]*[:=][ \t]*[^\n]+/gi, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){0,2}/g, '[REDACTED_JWT]')
    .replace(/([?&](?:token|key|secret|signature|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
const fail = reason => { throw new Error(reason); };
let root, exists = false, kind;
function inspect(relative) {
  if (!safeRelative(relative)) fail('unsafe_path');
  const absolute = path.join(root, relative);
  // Reject every symlink component, even links to another in-workspace file.
  if (fs.realpathSync(absolute) !== absolute) fail('unsafe_path');
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) fail('unsafe_path');
  return { absolute, stat };
}
function readFile(relative, limit) {
  const before = inspect(relative);
  if (!before.stat.isFile() || before.stat.nlink !== 1) fail('unsafe_file');
  // Pin the parent as this isolated process's cwd. A concurrent parent symlink
  // swap cannot redirect the subsequent basename-only open outside the workspace.
  const parent = path.dirname(before.absolute);
  process.chdir(parent);
  if (process.cwd() !== parent) fail('unsafe_path');
  const fd = fs.openSync(path.basename(before.absolute), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    const current = inspect(relative).stat;
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.stat.ino ||
        opened.dev !== before.stat.dev || current.ino !== opened.ino || current.dev !== opened.dev) fail('unsafe_file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('unavailable');
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) fail('not_text');
    let raw;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: size < opened.size }); }
    catch { fail('not_text'); }
    const redacted = redact(raw);
    return { path: relative, bytes: opened.size, content_excerpt: redacted.slice(0, limit),
      content_truncated: opened.size > size || redacted.length > limit };
  } finally { fs.closeSync(fd); }
}
function collect() {
  if (!safeRelative(p.path)) fail('unsafe_path');
  root = fs.realpathSync(p.root);
  let target;
  try { target = inspect(p.path); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { exists: false, outcome: 'fail' };
    throw error;
  }
  exists = true;
  if (target.stat.isFile()) {
    kind = 'file';
    if (!textExtension.test(p.path)) fail('not_text');
    return { exists, kind, outcome: 'pass', ...readFile(p.path, MAX_BYTES) };
  }
  if (!target.stat.isDirectory()) fail('unsafe_file');
  kind = 'directory';
  const sqlOnly = p.path.split('/').includes('migrations');
  const files = [];
  let scanned = 0, truncated = false;
  function walk(relative, depth) {
    const before = inspect(relative);
    if (!before.stat.isDirectory()) fail('unsafe_path');
    process.chdir(before.absolute);
    if (process.cwd() !== before.absolute) fail('unsafe_path');
    const directory = fs.opendirSync('.', { bufferSize: 1 });
    const children = [];
    try {
      const current = inspect(relative).stat;
      if (current.ino !== before.stat.ino || current.dev !== before.stat.dev) fail('unsafe_path');
      let entry;
      while ((entry = directory.readSync())) {
        if (++scanned > MAX_ENTRIES) { truncated = true; break; }
        children.push(entry);
      }
    } finally { directory.closeSync(); }
    for (const child of children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const childPath = relative + '/' + child.name;
      if (!safeRelative(childPath) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (depth >= MAX_DEPTH || scanned >= MAX_ENTRIES) { truncated = true; continue; }
        walk(childPath, depth + 1);
      } else if (child.isFile() && (sqlOnly ? /\.sql$/i : textExtension).test(child.name)) {
        if (files.length >= MAX_FILES) { truncated = true; continue; }
        files.push(childPath);
      }
    }
    const after = inspect(relative).stat;
    if (after.ino !== before.stat.ino || after.dev !== before.stat.dev ||
        after.mtimeMs !== before.stat.mtimeMs || after.ctimeMs !== before.stat.ctimeMs) fail('unavailable');
  }
  walk(p.path, 0);
  // On incomplete discovery do not select an arbitrary subset and call it success.
  if (truncated) return { exists, kind, outcome: 'not_evaluable', truncated: true, error: 'directory_limit' };
  const entries = files.sort().map(file => readFile(file, Math.floor(3200 / Math.max(1, files.length))));
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return { exists, kind, outcome: bytes > 0 ? 'pass' : 'fail', bytes, entries,
    truncated: false, content_excerpt: entries.map(entry => entry.path + '\n' + entry.content_excerpt).join('\n').slice(0, MAX_BYTES) };
}
try { console.log(JSON.stringify(collect())); }
catch (error) {
  const reasons = ['unsafe_path', 'unsafe_file', 'not_text', 'unavailable'];
  console.log(JSON.stringify({ exists, kind, outcome: 'not_evaluable',
    error: reasons.includes(error.message) ? error.message : 'unavailable' }));
}
`;