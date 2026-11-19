import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageBootstrap, imageMigration, root } from './image-reservation-bootstrap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migration = name => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');

// Reuse current annual/trial guards and production model + image protocols.
// Only unrelated harness execution state is reduced to the existing local fixture
// contract. The shared trial model replacement is a reviewed exact SQL snapshot.
export const walletReservationBootstrap = imageBootstrap + '\n' + [
  '20261009040000_one_monthly_credit_per_addon.sql',
  '20261009070000_preserve_paid_addon_credit_windows.sql',
].map(migration).join('\n') + `
CREATE TABLE public.requirements(id uuid PRIMARY KEY,site_id uuid REFERENCES public.sites(id),active boolean);
CREATE TABLE public.harness_sessions(id uuid PRIMARY KEY,site_id uuid REFERENCES public.sites(id),
  lease_owner text,lease_expires_at timestamptz,snapshot jsonb);
CREATE FUNCTION public.assert_agent_requirement_run(uuid,text,integer,uuid)
RETURNS boolean LANGUAGE sql AS $$
  SELECT coalesce((SELECT active FROM public.requirements WHERE id=$1),false) AND $2='owner';
$$;
` + migration('20261014230000_openrouter_actual_cost_ledger.sql') + '\n' +
  migration('20261014230001_agent_actual_cost_settlement.sql') + '\n' +
  readFileSync(resolve(here, 'wallet-reservation-model-trial-fixture.sql'), 'utf8') + '\n' + imageMigration;

export const walletCoreMigration = migration('20261118230000_withdrawable_credit_consumption.sql');
export const walletReservationMigration = migration('20261118230001_withdrawable_credit_reservations.sql');
// Consumers (including real PostgreSQL races) must run the latest core first.
export const walletReservationSchema = [walletReservationBootstrap, walletCoreMigration, walletReservationMigration].join('\n');