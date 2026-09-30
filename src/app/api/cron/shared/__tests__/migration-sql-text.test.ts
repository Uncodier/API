import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { splitSqlStatements } from '@/lib/services/apps-platform/migration-sql-text';
import { lintMigration } from '@/lib/services/apps-platform/migration-linter';
import { canAutomaticallyReplaceMigration } from '@/lib/services/apps-platform/migration-repair-policy';

const input = (sql: string) => ({ sql, schema: 'app_123', tenant_id: 'offline-tenant' });
const literals = [
  ...[1, 2, 3, 4].map(count => ({
    label: `ordinary string with ${count} backslashes`,
    expression: `'${'\\'.repeat(count)}'`, value: '\\'.repeat(count),
  })),
  ...[2, 4].map(count => ({
    label: `E string with ${count} backslashes`,
    expression: `E'${'\\'.repeat(count)}'`, value: '\\'.repeat(count / 2),
  })),
  ...[1, 3].map(count => ({
    label: `E string with ${count} backslashes and an escaped quote`,
    expression: `E'${'\\'.repeat(count)}';not SQL'`, value: '\\'.repeat((count - 1) / 2) + "';not SQL",
  })),
  { label: 'ordinary doubled apostrophe', expression: "'can''t;not SQL'", value: "can't;not SQL" },
  { label: 'escaped doubled apostrophe', expression: "e'can''t;not SQL'", value: "can't;not SQL" },
  { label: 'E newline continuation', expression: String.raw`E'first'
    '\';not SQL'`, value: "first';not SQL" },
  { label: 'E line-comment continuation', expression: String.raw`E'first' -- continuation
    '\';not SQL'`, value: "first';not SQL" },
  { label: 'ordinary newline continuation', expression: String.raw`'first'
    '\'`, value: 'first\\' },
  { label: 'unicode string', expression: String.raw`U&'d\0061ta'`, value: 'data' },
  { label: 'dollar string', expression: '$body$; \' " -- /* $body$', value: '; \' " -- /* ' },
  { label: 'non-ASCII dollar tag', expression: '$cuerpoñ$; harmless$cuerpoñ$', value: '; harmless' },
];
const selects = [
  ...literals.map(({ label, expression, value }) => ({
    label, sql: `SELECT ${expression} AS value; SELECT 2 AS value;`, rows: [[{ value }], [{ value: 2 }]],
  })),
  ...['ends\\', 'double " quote', "Owner's -- /* $$ column", 'using (true)', 'política', 'e', 'name$body$'].map(name => ({
    label: `identifier ${name}`, sql: `SELECT 1 AS "${name.replace(/"/g, '""')}"; SELECT 2 AS value;`,
    rows: [[{ [name]: 1 }], [{ value: 2 }]],
  })),
  { label: 'unquoted dollar name', sql: 'SELECT 1 AS name$tag$; SELECT 2 AS value;',
    rows: [[{ name$tag$: 1 }], [{ value: 2 }]] },
  { label: 'CR line comment', sql: 'SELECT 1 AS value; -- comment\rSELECT 2 AS value;',
    rows: [[{ value: 1 }], [{ value: 2 }]] },
  { label: 'nested comment', sql: 'SELECT 1 AS value /* outer ; /* inner */ */; SELECT 2 AS value;',
    rows: [[{ value: 1 }], [{ value: 2 }]] },
];
const attacks = [
  String.raw`SELECT '\'; ALTER TABLE records DISABLE ROW LEVEL SECURITY; -- '`,
  String.raw`SELECT E'\\'; ALTER TABLE records DISABLE ROW LEVEL SECURITY; -- '`,
  String.raw`SELECT 1 AS "ends\"; ALTER TABLE records DISABLE ROW LEVEL SECURITY; -- "`,
  `SELECT 1 AS "Owner's -- /* column"; ALTER TABLE records DISABLE ROW LEVEL SECURITY;`,
];
const safeEscapes = [
  String.raw`SELECT E'can\'t; ALTER TABLE records DISABLE ROW LEVEL SECURITY;';`,
  String.raw`SELECT 'can''t; ALTER TABLE records DISABLE ROW LEVEL SECURITY;';`,
  String.raw`SELECT E'odd\\\'; ALTER TABLE records DISABLE ROW LEVEL SECURITY;';`,
  String.raw`SELECT E'first'
    '\'; ALTER TABLE records DISABLE ROW LEVEL SECURITY;';`,
  `SELECT $$'; ALTER TABLE records DISABLE ROW LEVEL SECURITY;$$;`,
];
const malformed = [
  "SELECT 'unterminated; SELECT 2;", 'SELECT "unterminated; SELECT 2;',
  '/* unterminated', '/* outer /* inner */', 'SELECT $body$unterminated;',
  'SELECT (1;', 'SELECT 1);', 'SELECT "";',
];

describe('defensive SQL text scanning', () => {
  it.each(selects)('keeps two executable statements for $label', ({ sql }) => {
    const statements = splitSqlStatements(sql).filter(stmt => stmt.code.trim());
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.parseError).toBeUndefined();
      expect(statement.code).toHaveLength(statement.text.length);
    }
    expect(lintMigration(input(sql)).ok).toBe(true);
  });

  it('preserves identifiers exactly while masking literal contents, including double quotes', () => {
    const identifier = `"Owner's -- /* $$ ""Name"""`;
    const [statement] = splitSqlStatements(`SELECT '"; not an identifier' AS ${identifier};`);
    expect(statement.code).toContain(identifier);
    expect(statement.code).not.toContain('not an identifier');
    expect(statement.code).not.toContain('";');
  });

  it('keeps line numbers and newlines while masking nested comments and literals', () => {
    const statements = splitSqlStatements("\nSELECT 'line\none';\n\n/* outer\n/* nested */ */ SELECT 2;\nSELECT 3;");
    expect(statements.map(stmt => stmt.line)).toEqual([2, 5, 7]);
    for (const stmt of statements) {
      expect(stmt.code.split('\n')).toHaveLength(stmt.text.split('\n').length);
    }
  });

  it('does not trim non-ASCII characters that belong to PostgreSQL identifiers', () => {
    expect(splitSqlStatements('SELECT records\u00a0;')[0].text).toBe('SELECT records\u00a0');
  });

  it.each(malformed)('marks malformed input rather than hiding it: %s', sql => {
    expect(splitSqlStatements(sql).some(stmt => stmt.parseError && stmt.code.trim())).toBe(true);
    expect(lintMigration(input(sql)).ok).toBe(false);
  });

  it('audits executable dollar bodies with the same quote rules', () => {
    const sql = String.raw`CREATE FUNCTION unsafe() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN PERFORM '\'; ALTER TABLE records DISABLE ROW LEVEL SECURITY; END; $$;`;
    expect(splitSqlStatements(sql)).toHaveLength(1);
    expect(splitSqlStatements(sql)[0].code).toContain('DISABLE ROW LEVEL SECURITY');
    expect(lintMigration(input(sql)).ok).toBe(false);
    expect(lintMigration(input(`CREATE FUNCTION broken() RETURNS text LANGUAGE sql AS $$ SELECT 'unclosed $$;`)).ok).toBe(false);
  });
});

describe('actual PostgreSQL lexer and RLS comparisons (in-memory PGlite only)', () => {
  let report: {
    settings: string;
    selects: { whole: unknown; split: unknown }[];
    malformed: string[];
    unsafeVisibility: number[];
    guardedVisibility: number[];
    safeVisibility: number[];
    repairedRows: { id: number }[];
    policy: { polname: string; polcmd: string; roles: string[] };
    quotedPolicy: { polname: string; table_name: string; polcmd: string; roles: string[] };
    quotedRows: { id: number }[];
    deniedInsert: string;
    enabled: boolean;
  };
  const original = 'CREATE POLICY política ON records FOR SELECT TO reader USING (true);';
  const repaired = original.replace('(true)', '(owner_name = current_user)');
  const quotedOriginal = `CREATE POLICY "Owner's -- /* ""Policy""" ON "Records  Private" FOR SELECT TO "Staff  Team" USING (true);`;
  const quotedRepair = quotedOriginal.replace('(true)', '(owner_name = current_user)');

  beforeAll(() => {
    // Follow the existing PGlite test pattern: isolate ESM/WASM in a child,
    // never load Next config, .env, a network client or a persistent data directory.
    const script = `
      import { PGlite } from '@electric-sql/pglite';
      const db = new PGlite();
      try {
        const settings = (await db.query('SHOW standard_conforming_strings')).rows[0].standard_conforming_strings;
        const selects = [];
        for (const fixture of ${JSON.stringify(selects.map(({ sql }) => ({ sql, split: splitSqlStatements(sql).map(s => s.text) })))}) {
          const whole = (await db.exec(fixture.sql)).map(result => result.rows);
          const split = [];
          for (const statement of fixture.split) split.push(...(await db.exec(statement)).map(result => result.rows));
          selects.push({ whole, split });
        }
        const malformed = [];
        for (const sql of ${JSON.stringify(malformed)}) {
          try { await db.exec(sql); malformed.push('accepted'); }
          catch (error) { malformed.push(error.code); }
        }
        await db.exec(\`
          CREATE ROLE reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
          CREATE TABLE records (id int PRIMARY KEY, owner_name text);
          INSERT INTO records VALUES (1, 'reader'), (2, 'another_reader');
          GRANT SELECT, INSERT ON records TO reader;
          ALTER TABLE records ENABLE ROW LEVEL SECURITY;
        \`);
        await db.exec(${JSON.stringify(repaired)});
        async function visible() {
          await db.exec('SET ROLE reader');
          try { return (await db.query('SELECT id FROM records ORDER BY id')).rows; }
          finally { await db.exec('RESET ROLE'); }
        }
        const unsafeVisibility = [], guardedVisibility = [];
        for (const attack of ${JSON.stringify(attacks.map(sql => ({ sql, allowed: lintMigration(input(sql)).ok })))}) {
          // Demonstrate that the raw SQL really does disable RLS in PostgreSQL.
          await db.exec('BEGIN');
          await db.exec(attack.sql);
          unsafeVisibility.push((await visible()).length);
          await db.exec('ROLLBACK');
          // Then exercise the boundary using the real linter's decision.
          if (attack.allowed) await db.exec(attack.sql);
          guardedVisibility.push((await visible()).length);
        }
        const safeVisibility = [];
        for (const sql of ${JSON.stringify(safeEscapes)}) {
          await db.exec(sql);
          safeVisibility.push((await visible()).length);
        }
        const repairedRows = await visible();
        let deniedInsert;
        await db.exec('SET ROLE reader');
        try { await db.exec("INSERT INTO records VALUES (3, 'another_reader')"); deniedInsert = 'accepted'; }
        catch (error) { deniedInsert = error.code; }
        finally { await db.exec('RESET ROLE'); }
        const policy = (await db.query(\`
          SELECT polname, polcmd, ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(polroles)) AS roles
          FROM pg_policy WHERE polrelid = 'records'::regclass
        \`)).rows[0];
        const enabled = (await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'records'::regclass")).rows[0].relrowsecurity;
        await db.exec(\`
          CREATE ROLE "Staff  Team" NOLOGIN NOSUPERUSER NOBYPASSRLS;
          CREATE TABLE "Records  Private" (id int, owner_name text);
          INSERT INTO "Records  Private" VALUES (1, 'Staff  Team'), (2, 'reader');
          GRANT SELECT ON "Records  Private" TO "Staff  Team";
          ALTER TABLE "Records  Private" ENABLE ROW LEVEL SECURITY;
        \`);
        await db.exec(${JSON.stringify(quotedRepair)});
        const quotedPolicy = (await db.query(\`
          SELECT polname, relname AS table_name, polcmd,
            ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(polroles)) AS roles
          FROM pg_policy JOIN pg_class ON pg_class.oid = polrelid
          WHERE relname = 'Records  Private'
        \`)).rows[0];
        await db.exec('SET ROLE "Staff  Team"');
        const quotedRows = (await db.query('SELECT id FROM "Records  Private" ORDER BY id')).rows;
        await db.exec('RESET ROLE');
        console.log(JSON.stringify({ settings, selects, malformed, unsafeVisibility, guardedVisibility, safeVisibility,
          repairedRows, policy, deniedInsert, enabled, quotedPolicy, quotedRows }));
      } finally { await db.close(); }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: resolve(__dirname, '../../../../../..'), encoding: 'utf8', timeout: 20_000,
    });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Offline PGlite comparison failed');
    report = JSON.parse(child.stdout.trim());
  }, 25_000);

  it('matches PostgreSQL results for whole versus split SQL with standard strings on', () => {
    expect(report.settings).toBe('on');
    expect(report.selects).toHaveLength(selects.length);
    for (let i = 0; i < selects.length; i++) {
      expect({ label: selects[i].label, ...report.selects[i] }).toEqual({
        label: selects[i].label, whole: selects[i].rows, split: selects[i].rows,
      });
    }
  });

  it('rejects lexical errors that PostgreSQL also rejects', () => {
    expect(report.malformed).toEqual(malformed.map(() => '42601'));
  });

  it('refuses real statement-hiding attempts, leaving row security enforced', () => {
    expect(report.unsafeVisibility).toEqual(attacks.map(() => 2));
    expect(report.guardedVisibility).toEqual(attacks.map(() => 1));
    expect(report.enabled).toBe(true);
  });

  it('accepts safe escape strings without executing the RLS changes in their literal contents', () => {
    for (const sql of safeEscapes) expect(lintMigration(input(sql)).ok).toBe(true);
    expect(report.safeVisibility).toEqual(safeEscapes.map(() => 1));
  });

  it('retains the Unicode policy identity, command and role and enforces the repaired predicate', () => {
    expect(canAutomaticallyReplaceMigration(original, repaired)).toBe(true);
    expect(lintMigration(input(repaired)).ok).toBe(true);
    expect(report.policy).toEqual({ polname: 'política', polcmd: 'r', roles: ['reader'] });
    expect(report.repairedRows).toEqual([{ id: 1 }]);
    expect(report.deniedInsert).toBe('42501');
  });

  it('preserves exact quoted names and role spacing in PostgreSQL, with RLS enforced', () => {
    expect(canAutomaticallyReplaceMigration(quotedOriginal, quotedRepair)).toBe(true);
    expect(lintMigration(input(quotedRepair)).ok).toBe(true);
    expect(report.quotedPolicy).toEqual({
      polname: `Owner's -- /* "Policy"`, table_name: 'Records  Private', polcmd: 'r', roles: ['Staff  Team'],
    });
    expect(report.quotedRows).toEqual([{ id: 1 }]);
  });
});