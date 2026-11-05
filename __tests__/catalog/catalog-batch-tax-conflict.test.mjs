import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('tax conflict preserves concurrent attachment and inserts the rest of the batch', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE catalog_item_taxes (
      site_id uuid NOT NULL, catalog_item_id uuid NOT NULL, tax_id uuid NOT NULL,
      UNIQUE (catalog_item_id, tax_id)
    )`);
    const site = randomUUID(), first = randomUUID(), second = randomUUID(), tax = randomUUID();
    // Batch observes no attachments, then another writer wins before the insert.
    assert.equal((await db.query('SELECT * FROM catalog_item_taxes')).rows.length, 0);
    await db.query('INSERT INTO catalog_item_taxes VALUES ($1,$2,$3)', [site, first, tax]);
    const insert = `INSERT INTO catalog_item_taxes VALUES ($1,$2,$4),($1,$3,$4)
      ON CONFLICT (catalog_item_id,tax_id) DO NOTHING`;
    await db.query(insert, [site, first, second, tax]);
    await db.query(insert, [site, first, second, tax]);
    const { rows } = await db.query('SELECT * FROM catalog_item_taxes');
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map(row => row.catalog_item_id)), new Set([first, second]));
    assert.ok(rows.every(row => row.site_id === site && row.tax_id === tax));
  } finally {
    await db.close();
  }
});