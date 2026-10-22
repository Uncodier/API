const { tokenize, statements, canonical, functionDefinitions } = require('./sql.cjs');

test('does not split function bodies, quoted identifiers or strings at semicolons', () => {
  const source = `/* outer /* nested */ comment */ CREATE FUNCTION public."Mixed"(p text)
    RETURNS text LANGUAGE sql AS $body$ SELECT 'secret-shaped; synthetic' $body$;
    SELECT 'it''s;a;string'; -- trailing comment`;
  expect(statements(source)).toHaveLength(2);
  expect(functionDefinitions(source)).toMatchObject([{ schema: 'public', name: 'Mixed', body: " SELECT 'secret-shaped; synthetic' " }]);
});

test('preserves quoted strings and identifiers while ignoring whitespace and comments', () => {
  expect(canonical("SELECT foo /* x */ FROM public.bar")).toBe(canonical('select FOO from PUBLIC.BAR'));
  expect(canonical("SELECT 'Admin'")).not.toBe(canonical("SELECT 'admin'"));
  expect(canonical('SELECT "FOO"')).not.toBe(canonical('SELECT foo'));
});

test('does not interpret CREATE FUNCTION inside DO or comments as installed definitions', () => {
  const source = `-- CREATE FUNCTION public.fake() RETURNS text
    DO $x$ BEGIN EXECUTE 'CREATE FUNCTION public.fake() RETURNS text AS $$ text $$'; END $x$;
    CREATE OR REPLACE FUNCTION public.real(p_id uuid DEFAULT NULL) RETURNS boolean
      LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN RETURN true; END; $$;`;
  expect(functionDefinitions(source).map(f => f.name)).toEqual(['real']);
});

test.each(["SELECT 'open", '/* open', 'DO $tag$ never closed', 'SELECT "open'])('fails closed on malformed SQL: %s', source => {
  expect(() => tokenize(source)).toThrow(/Unterminated/);
});

test('supports doubled identifiers and escaped SQL strings', () => {
  expect(functionDefinitions('CREATE FUNCTION "Schema"."Fn""Name"() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;')[0])
    .toMatchObject({ schema: 'Schema', name: 'Fn"Name' });
  expect(statements("SELECT E'quote\\\';inside'; SELECT 1;")).toHaveLength(2);
});