import fs from 'node:fs';
import path from 'node:path';
import { lintMigration } from '../migration-linter';

describe('Visualgv user organization repair migration', () => {
  const schema = 'app_7f146ebd26a84d478ce5f17d';
  const organizationSql = fs.readFileSync(
    path.join(
      process.cwd(),
      'supabase/tenant-migrations/app_7f146ebd26a84d478ce5f17d/0016_add_users_organization_id.sql',
    ),
    'utf8',
  );
  const consolidationSql = fs.readFileSync(
    path.join(
      process.cwd(),
      'supabase/tenant-migrations/app_7f146ebd26a84d478ce5f17d/0017_consolidate_demo_users.sql',
    ),
    'utf8',
  );

  it.each([
    ['organization', organizationSql],
    ['consolidation', consolidationSql],
  ])('passes the tenant migration linter for %s', (_name, sql) => {
    expect(
      lintMigration({
        schema,
        tenant_id: '89cd819c-acff-4f2a-936d-b8d65689bb57',
        sql,
      }),
    ).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('backfills a required organization foreign key', () => {
    expect(organizationSql).toContain('ALTER COLUMN organization_id SET NOT NULL');
    expect(organizationSql).toContain('ADD CONSTRAINT users_organization_id_fkey');
    expect(organizationSql).toContain(
      'REFERENCES app_7f146ebd26a84d478ce5f17d.organizations(id)',
    );
  });

  it('repoints dependent demo data before enforcing unique emails', () => {
    expect(consolidationSql).toContain('UPDATE app_7f146ebd26a84d478ce5f17d.evidences');
    expect(consolidationSql).toContain('UPDATE app_7f146ebd26a84d478ce5f17d.work_orders');
    expect(consolidationSql).toContain('DELETE FROM app_7f146ebd26a84d478ce5f17d.users');
    expect(consolidationSql).toContain('CREATE UNIQUE INDEX users_email_lower_key');
  });

  it('keeps destructive demo cleanup out of the organization migration', () => {
    expect(organizationSql).not.toContain('DELETE FROM');
    expect(organizationSql).not.toContain('users_email_lower_key');
  });
});