'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tokenize, canonical, functionDefinitions } = require('./sql.cjs');

function audit({ repositories, catalogDirectory }) {
  const load = name => JSON.parse(fs.readFileSync(path.join(catalogDirectory, `catalog-${name}.json`), 'utf8'));
  const functions = load('functions');
  const history = load('history');
  const rows = [];
  for (const repository of repositories) {
    const directory = path.join(repository, 'supabase', 'migrations');
    for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      const sourcePath = path.join(directory, filename);
      const sql = fs.readFileSync(sourcePath, 'utf8');
      const match = filename.match(/^(\d+)_(.+)\.sql$/);
      if (!match) throw new Error(`Unrecognized migration filename: ${filename}`);
      const [_, version, name] = match;
      const registered = history.find(row => row.version === version);
      const definitions = functionDefinitions(sql);
      const diagnostics = definitions.map(definition => {
        const candidates = functions.filter(f => f.schema === definition.schema && f.name === definition.name);
        const matches = candidates.filter(f => canonical(f.body) === canonical(definition.body));
        return {
          name: `${definition.schema}.${definition.name}`,
          arguments: definition.arguments,
          bodyMatches: matches.map(f => f.signature),
          existingSignatures: candidates.map(f => f.signature),
        };
      });
      const tokens = tokenize(sql);
      rows.push({
        repository: path.basename(repository), filename, version, name,
        sha256: crypto.createHash('sha256').update(sql).digest('hex'),
        validTimestamp: /^\d{14}$/.test(version),
        registeredName: registered?.name || null,
        // Raw SQL equality is evidence of the recorded file, not current schema health.
        recordedSourceExact: Boolean(registered?.statements?.some(statement => statement === sql)),
        explicitTarget: /--\s*Target:\s*Apps\b/i.test(sql) ? 'Apps' :
          /--\s*Target:\s*Makinari\b/i.test(sql) ? 'Makinari' : 'review_required',
        hasDynamicBlock: tokens.some(t => t.kind === 'word' && t.value === 'do'),
        hasDataMutation: tokens.some(t => t.kind === 'word' && ['insert', 'update', 'delete', 'truncate'].includes(t.value)),
        functionDiagnostics: diagnostics,
        // Never infer application from names, body matches or history alone.
        conclusion: 'requires_complete_postcondition_review',
      });
    }
  }
  const byVersion = new Map();
  for (const row of rows) {
    const group = byVersion.get(row.version) || [];
    group.push(row);
    byVersion.set(row.version, group);
  }
  const collisions = [...byVersion.entries()].filter(([, group]) => group.length > 1).map(([version, group]) => ({
    version,
    identicalSource: new Set(group.map(row => row.sha256)).size === 1,
    files: group.map(row => `${row.repository}/${row.filename}`),
  }));
  return {
    auditedAt: new Date().toISOString(),
    readOnly: true,
    migrationCount: rows.length,
    uniqueVersions: byVersion.size,
    registeredVersions: history.length,
    collisions,
    unmatchedRemoteVersions: history.filter(remote => !byVersion.has(remote.version)).map(({ version, name }) => ({ version, name })),
    migrations: rows,
  };
}

if (require.main === module) {
  const [catalogDirectory, outputPath, ...repositories] = process.argv.slice(2);
  if (!catalogDirectory || !outputPath || !repositories.length) {
    throw new Error('Usage: node audit.cjs <catalog-directory> <output-json> <absolute-repository> [...]');
  }
  for (const p of [catalogDirectory, outputPath, ...repositories]) {
    if (!path.isAbsolute(p)) throw new Error('All paths must be absolute');
  }
  const report = audit({ repositories, catalogDirectory });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ migrations: report.migrationCount, versions: report.uniqueVersions,
    collisions: report.collisions.length, registeredVersions: report.registeredVersions }));
}

module.exports = { audit };