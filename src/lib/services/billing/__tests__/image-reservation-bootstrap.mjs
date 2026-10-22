import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
export const root=resolve(here,'../../../../..');
export const imageMigration=readFileSync(resolve(root,'supabase/migrations/20261022000000_image_generation_credit_reservations.sql'),'utf8');
export const imageBootstrap=readFileSync(resolve(here,'credit-fixture.sql'),'utf8')+
  ['20261003230000_credit_buckets_and_monthly_reset.sql','20261003230001_stripe_plan_credit_reset.sql',
    '20261003230002_classified_credit_operations.sql','20261005230000_exact_credit_accounting_precision.sql',
    '20261007003000_remove_signup_credit_bonus.sql','20261007180000_annual_subscription_credit_periods.sql',
    '20261007180001_subscription_checkout_leases.sql','20261008210000_preserve_canceled_subscription_credit_usage.sql']
    .map(n=>readFileSync(resolve(root,'supabase/migrations',n),'utf8')).join('\n')+
  readFileSync(resolve(here,'image-trial-fixture.sql'),'utf8');