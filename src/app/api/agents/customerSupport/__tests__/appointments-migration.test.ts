import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260928220000_customer_support_appointments.sql'),
  'utf8',
);

describe('Customer Support appointments migration', () => {
  it('is repeatable and restricts appointments to site members', () => {
    const script = `
      import { PGlite } from '@electric-sql/pglite';
      const db = new PGlite();
      const owner = '00000000-0000-4000-8000-000000000001';
      const siteId = '00000000-0000-4000-8000-000000000002';
      const otherSiteId = '00000000-0000-4000-8000-000000000003';
      try {
        await db.exec(\`
          CREATE ROLE anon;
          CREATE ROLE authenticated;
          CREATE ROLE service_role;
          CREATE SCHEMA auth;
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
          $$;
          CREATE TABLE public.sites (id uuid PRIMARY KEY, user_id uuid NOT NULL);
          CREATE TABLE public.site_members (
            site_id uuid, user_id uuid, status text, restrict_to_assigned_only boolean
          );
          GRANT SELECT ON public.sites, public.site_members TO authenticated;
          INSERT INTO public.sites (id, user_id) VALUES
            ('\${siteId}', '\${owner}'),
            ('\${otherSiteId}', '00000000-0000-4000-8000-000000000004');
        \`);
        await db.exec(${JSON.stringify(migration)});
        await db.exec(${JSON.stringify(migration)});
        const security = await db.query(\`
          SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.appointments'::regclass) AS rls,
            has_table_privilege('service_role', 'public.appointments', 'INSERT') AS service_insert,
            has_table_privilege('anon', 'public.appointments', 'SELECT') AS anon_select
        \`);
        await db.exec(\`
          INSERT INTO public.appointments
            (site_id, context_id, title, start_datetime, end_datetime, duration, timezone)
          VALUES ('\${siteId}', '\${owner}', 'My meeting', now() + interval '1 day',
            now() + interval '1 day 1 hour', 60, 'America/Mexico_City'),
            ('\${otherSiteId}', '\${owner}', 'Other meeting', now() + interval '1 day',
            now() + interval '1 day 1 hour', 60, 'America/Mexico_City');
          SET request.jwt.claim.sub = '\${owner}';
          SET ROLE authenticated;
        \`);
        const own = await db.query('SELECT title FROM public.appointments ORDER BY title');
        let blockedOtherSite = false;
        try {
          await db.exec(\`
            INSERT INTO public.appointments
              (site_id, context_id, title, start_datetime, end_datetime, duration, timezone)
            VALUES ('\${otherSiteId}', '\${owner}', 'Blocked', now() + interval '1 day',
              now() + interval '1 day 1 hour', 60, 'America/Mexico_City')
          \`);
        } catch (error) {
          blockedOtherSite = /row-level security/i.test(String(error));
        }
        console.log(JSON.stringify({ ...security.rows[0], own: own.rows, blockedOtherSite }));
      } finally {
        await db.close();
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr?.slice(-3_000) || 'Appointments migration check failed');
    }
    expect(JSON.parse(result.stdout.trim())).toEqual({
      rls: true,
      service_insert: true,
      anon_select: false,
      own: [{ title: 'My meeting' }],
      blockedOtherSite: true,
    });
  }, 25_000);
});