import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getReviewedTool } from '../reviewed-tools';

// Existing policies retain their pre-mode explicit selections after migration.
test('legacy workspace seed selected only the two approved reads for their own toolkit', () => {
  const sql = readFileSync(join(__dirname, '../../../../supabase/migrations/20261119223011_connector_workspace_access.sql'), 'utf8');
  const seed = sql.match(/v_allowed_tools\s*:=\s*CASE v_attempt\.toolkit_slug([\s\S]*?)END;/)?.[1];
  expect(seed?.trim().replace(/\s+/g, ' ')).toBe(
    "WHEN 'gmail' THEN ARRAY['GMAIL_FETCH_EMAILS'] WHEN 'hubspot' THEN ARRAY['HUBSPOT_LIST_CONTACTS'] ELSE ARRAY[]::text[]",
  );
  expect(getReviewedTool('GMAIL_FETCH_EMAILS', 'gmail').requiredScopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
  expect(getReviewedTool('HUBSPOT_LIST_CONTACTS', 'hubspot').requiredScopes).toContain('crm.objects.contacts.read');
});
