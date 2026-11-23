import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { freshPostgres, postgresBinDirectory } from '@/lib/procurement/__tests__/fixtures/workflow-postgres';

const execute = promisify(execFile);
const quote = (v: unknown) => `'${(typeof v === 'string' ? v : JSON.stringify(v)).replaceAll("'", "''")}'`;
const ident = (v: string) => {
  if (!/^[a-z_]+$/.test(v)) throw new Error('Unexpected test identifier');
  return `"${v}"`;
};
const field = (v: string) => {
  const parts = v.split('->>');
  return parts.length === 1 ? ident(v) : `${ident(parts[0])}->>${quote(parts[1])}`;
};

// Minimal translation of the writer's PostgREST calls. Independent psql
// processes run the actual SELECT/INSERT/RETURNING and observe their SQLSTATE.
// No PostgREST server, developer connection settings, TCP, or migrations.
export function askPostgres() {
  const db = freshPostgres();
  const socket = db.query('SHOW unix_socket_directories;');
  const psql = join(postgresBinDirectory(), 'psql');
  db.query(`CREATE TABLE sites (id uuid PRIMARY KEY, user_id uuid NOT NULL);
    CREATE TABLE remote_instances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid REFERENCES sites,
      user_id uuid, created_by uuid, status text, is_archived boolean DEFAULT false, name text, instance_type text, timeout_hours integer);
    CREATE TABLE instance_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), log_type text NOT NULL, level text,
      trusted_user_action boolean NOT NULL, site_id uuid REFERENCES sites, user_id uuid, message text NOT NULL, details jsonb,
      instance_id uuid REFERENCES remote_instances);
  `);
  let loseInsertAck = false;
  const from = (table: string) => {
    let columns = '*', inserted: Record<string, unknown> | undefined;
    const conditions: string[] = [];
    const read = async () => {
      const statement = inserted
        ? `INSERT INTO ${ident(table)} (${Object.keys(inserted).map(ident)}) VALUES (${Object.values(inserted).map(quote)}) RETURNING ${columns}`
        : `SELECT ${columns} FROM ${ident(table)} WHERE ${conditions.join(' AND ')}`;
      try {
        const { stdout } = await execute(psql, ['-XqwAt', '-h', socket, '-U', 'postgres', '-d', 'postgres',
          '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', `WITH r AS (${statement}) SELECT row_to_json(r) FROM r`],
          { env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: socket, LC_ALL: 'C' }, encoding: 'utf8', timeout: 5000 });
        if (inserted && table === 'instance_logs' && loseInsertAck) {
          loseInsertAck = false;
          return { data: null, error: { code: '', message: 'Acknowledgement unavailable' } };
        }
        return { data: stdout.trim() ? JSON.parse(stdout.trim()) : null, error: null };
      } catch (err) {
        const state = String((err as { stderr?: string }).stderr).match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
        if (state !== '23505') throw err;
        return { data: null, error: { code: state, message: 'Duplicate key' } };
      }
    };
    const q = {
      select: (names: string) => {
        columns = names.split(',').map(part => {
          const [left, right] = part.trim().split(':');
          return right ? `${field(right)} AS ${ident(left)}` : ident(left);
        }).join(',');
        return q;
      },
      abortSignal: () => q,
      eq: (name: string, value: unknown) => { conditions.push(`${field(name)}=${quote(value)}`); return q; },
      insert: (value: Record<string, unknown>) => { inserted = value; return q; }, single: read, maybeSingle: read,
    };
    return q;
  };
  return { ...db, from, loseNextActionAck: () => { loseInsertAck = true; } };
}
