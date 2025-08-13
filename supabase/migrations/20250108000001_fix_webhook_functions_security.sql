-- Migration: Fix remaining webhook function search_path security issues
-- Purpose: Specifically target the 4 remaining webhook functions with search_path vulnerabilities
-- Date: 2025-01-08

-- Drop and recreate check_webhook_event_processed function with proper security
DROP FUNCTION IF EXISTS public.check_webhook_event_processed(UUID);

CREATE OR REPLACE FUNCTION public.check_webhook_event_processed(event_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    is_processed BOOLEAN;
BEGIN
    SELECT processed INTO is_processed 
    FROM public.webhook_events 
    WHERE id = event_id;
    
    RETURN COALESCE(is_processed, FALSE);
END;
$$;

-- Drop and recreate mark_webhook_event_processed function with proper security
DROP FUNCTION IF EXISTS public.mark_webhook_event_processed(UUID);

CREATE OR REPLACE FUNCTION public.mark_webhook_event_processed(event_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE public.webhook_events 
    SET 
        processed = TRUE,
        processed_at = NOW(),
        updated_at = NOW()
    WHERE id = event_id;
END;
$$;

-- Drop and recreate mark_webhook_event_failed function with proper security
DROP FUNCTION IF EXISTS public.mark_webhook_event_failed(UUID, TEXT);
DROP FUNCTION IF EXISTS public.mark_webhook_event_failed(UUID);

CREATE OR REPLACE FUNCTION public.mark_webhook_event_failed(
    event_id UUID, 
    error_msg TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE public.webhook_events 
    SET 
        processed = FALSE,
        failed = TRUE,
        error_message = COALESCE(error_msg, error_message),
        failed_at = NOW(),
        updated_at = NOW()
    WHERE id = event_id;
END;
$$;

-- Drop and recreate cleanup_old_webhook_events function with proper security
DROP FUNCTION IF EXISTS public.cleanup_old_webhook_events(INTEGER);
DROP FUNCTION IF EXISTS public.cleanup_old_webhook_events();

CREATE OR REPLACE FUNCTION public.cleanup_old_webhook_events(days_old INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM public.webhook_events 
    WHERE created_at < NOW() - (days_old || ' days')::INTERVAL
    AND processed = TRUE;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION public.check_webhook_event_processed(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_webhook_event_processed(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_webhook_event_failed(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_webhook_events(INTEGER) TO authenticated;

-- Add security comments
COMMENT ON FUNCTION public.check_webhook_event_processed(UUID) IS 'Checks if webhook event has been processed. Secured with search_path = empty string and SECURITY DEFINER.';
COMMENT ON FUNCTION public.mark_webhook_event_processed(UUID) IS 'Marks webhook event as processed. Secured with search_path = empty string and SECURITY DEFINER.';
COMMENT ON FUNCTION public.mark_webhook_event_failed(UUID, TEXT) IS 'Marks webhook event as failed with optional error message. Secured with search_path = empty string and SECURITY DEFINER.';
COMMENT ON FUNCTION public.cleanup_old_webhook_events(INTEGER) IS 'Cleans up old processed webhook events. Secured with search_path = empty string and SECURITY DEFINER.';
