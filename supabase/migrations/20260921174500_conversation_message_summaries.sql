-- Rollback:
-- DROP TRIGGER IF EXISTS messages_refresh_conversation_summary ON public.messages;
-- DROP FUNCTION IF EXISTS public.refresh_conversation_message_summary();
-- ALTER TABLE public.conversations
--   DROP COLUMN IF EXISTS last_message_preview,
--   DROP COLUMN IF EXISTS message_count;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_message_preview jsonb,
  ADD COLUMN IF NOT EXISTS message_count bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS messages_conversation_created_at_idx
  ON public.messages (conversation_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.refresh_conversation_message_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_conversation_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_conversation_id := OLD.conversation_id;
  ELSE
    target_conversation_id := NEW.conversation_id;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id
  THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        LEAST(OLD.conversation_id::text, NEW.conversation_id::text),
        0
      )
    );
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        GREATEST(OLD.conversation_id::text, NEW.conversation_id::text),
        0
      )
    );
  ELSE
    PERFORM pg_advisory_xact_lock(
      hashtextextended(target_conversation_id::text, 0)
    );
  END IF;

  UPDATE public.conversations AS conversation
  SET
    message_count = summary.total,
    last_message_preview = summary.latest,
    last_message_at = (summary.latest->>'created_at')::timestamptz
  FROM (
    SELECT
      COUNT(*)::bigint AS total,
      (
        SELECT jsonb_build_object(
          'id', latest.id,
          'content', latest.content,
          'role', latest.role,
          'created_at', latest.created_at
        )
        FROM public.messages AS latest
        WHERE latest.conversation_id = target_conversation_id
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      ) AS latest
    FROM public.messages
    WHERE conversation_id = target_conversation_id
  ) AS summary
  WHERE conversation.id = target_conversation_id;

  IF TG_OP = 'UPDATE' AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
    UPDATE public.conversations AS conversation
    SET
      message_count = summary.total,
      last_message_preview = summary.latest,
      last_message_at = (summary.latest->>'created_at')::timestamptz
    FROM (
      SELECT
        COUNT(*)::bigint AS total,
        (
          SELECT jsonb_build_object(
            'id', latest.id,
            'content', latest.content,
            'role', latest.role,
            'created_at', latest.created_at
          )
          FROM public.messages AS latest
          WHERE latest.conversation_id = OLD.conversation_id
          ORDER BY latest.created_at DESC, latest.id DESC
          LIMIT 1
        ) AS latest
      FROM public.messages
      WHERE conversation_id = OLD.conversation_id
    ) AS summary
    WHERE conversation.id = OLD.conversation_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_refresh_conversation_summary
  ON public.messages;
CREATE TRIGGER messages_refresh_conversation_summary
AFTER INSERT OR UPDATE OF content, role, created_at, conversation_id OR DELETE
ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.refresh_conversation_message_summary();

UPDATE public.conversations AS conversation
SET
  message_count = summary.total,
  last_message_preview = summary.latest,
  last_message_at = (summary.latest->>'created_at')::timestamptz
FROM (
  SELECT
    grouped.conversation_id,
    grouped.total,
    (
      SELECT jsonb_build_object(
        'id', latest.id,
        'content', latest.content,
        'role', latest.role,
        'created_at', latest.created_at
      )
      FROM public.messages AS latest
      WHERE latest.conversation_id = grouped.conversation_id
      ORDER BY latest.created_at DESC, latest.id DESC
      LIMIT 1
    ) AS latest
  FROM (
    SELECT conversation_id, COUNT(*)::bigint AS total
    FROM public.messages
    GROUP BY conversation_id
  ) AS grouped
) AS summary
WHERE conversation.id = summary.conversation_id;
