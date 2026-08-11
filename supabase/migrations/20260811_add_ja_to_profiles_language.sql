-- Migration to add 'ja' to profiles.language CHECK constraint

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_language_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_language_check
  CHECK (language = ANY (ARRAY['es'::text, 'en'::text, 'fr'::text, 'de'::text, 'ja'::text]));
