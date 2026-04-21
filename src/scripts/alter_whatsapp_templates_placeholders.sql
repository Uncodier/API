-- Additive migration: add columns needed to support Twilio ContentVariables.
--
-- templated_body: the template body where {{lead.name}}, {{site.name}}, ...
--   have been replaced with Twilio numeric placeholders {{1}}, {{2}}, ...
-- placeholder_map: ordered array of canonical merge tokens. The i-th element
--   corresponds to the {{i+1}} placeholder in templated_body.
--
-- Both columns are nullable so that existing rows (plain-text templates without
-- variables) keep working unchanged.

ALTER TABLE public.whatsapp_templates
  ADD COLUMN IF NOT EXISTS templated_body text,
  ADD COLUMN IF NOT EXISTS placeholder_map jsonb;

COMMENT ON COLUMN public.whatsapp_templates.templated_body IS
  'Template body with numeric Twilio placeholders ({{1}}, {{2}}, ...). NULL for legacy templates that do not use variables.';

COMMENT ON COLUMN public.whatsapp_templates.placeholder_map IS
  'Ordered array of canonical merge tokens (e.g. ["lead.name","site.name"]). Position i maps to placeholder {{i+1}} in templated_body. NULL or empty array means the template has no variables.';

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_templated_body
  ON public.whatsapp_templates (site_id, account_sid, templated_body);
