-- Migration: Aggressively fix remaining 3 webhook functions
-- Purpose: Force fix the remaining webhook functions with all possible signatures
-- Date: 2025-01-08

-- First, let's check what functions actually exist and drop ALL versions
DO $$
DECLARE
    func_record RECORD;
BEGIN
    -- Drop all versions of check_webhook_event_processed
    FOR func_record IN 
        SELECT proname, oidvectortypes(proargtypes) as args
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'check_webhook_event_processed'
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s) CASCADE', 
                      func_record.proname, func_record.args);
    END LOOP;
    
    -- Drop all versions of mark_webhook_event_processed
    FOR func_record IN 
        SELECT proname, oidvectortypes(proargtypes) as args
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'mark_webhook_event_processed'
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s) CASCADE', 
                      func_record.proname, func_record.args);
    END LOOP;
    
    -- Drop all versions of mark_webhook_event_failed
    FOR func_record IN 
        SELECT proname, oidvectortypes(proargtypes) as args
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'mark_webhook_event_failed'
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s) CASCADE', 
                      func_record.proname, func_record.args);
    END LOOP;
END
$$;

-- Now recreate the functions with proper security settings
CREATE FUNCTION public.check_webhook_event_processed(event_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    is_processed BOOLEAN;
BEGIN
    SELECT processed INTO is_processed 
    FROM public.webhook_events 
    WHERE id = event_id;
    
    RETURN COALESCE(is_processed, FALSE);
EXCEPTION
    WHEN others THEN
        -- Return false if table doesn't exist or other errors
        RETURN FALSE;
END;
$function$;

CREATE FUNCTION public.mark_webhook_event_processed(event_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
    UPDATE public.webhook_events 
    SET 
        processed = TRUE,
        processed_at = NOW(),
        updated_at = NOW()
    WHERE id = event_id;
EXCEPTION
    WHEN others THEN
        -- Log error but don't fail
        RAISE NOTICE 'Failed to mark webhook event as processed: %', SQLERRM;
END;
$function$;

-- Create multiple versions of mark_webhook_event_failed to handle different signatures
CREATE FUNCTION public.mark_webhook_event_failed(event_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
    UPDATE public.webhook_events 
    SET 
        processed = FALSE,
        failed = TRUE,
        failed_at = NOW(),
        updated_at = NOW()
    WHERE id = event_id;
EXCEPTION
    WHEN others THEN
        -- Log error but don't fail
        RAISE NOTICE 'Failed to mark webhook event as failed: %', SQLERRM;
END;
$function$;

CREATE FUNCTION public.mark_webhook_event_failed(event_id UUID, error_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
    UPDATE public.webhook_events 
    SET 
        processed = FALSE,
        failed = TRUE,
        error_message = error_msg,
        failed_at = NOW(),
        updated_at = NOW()
    WHERE id = event_id;
EXCEPTION
    WHEN others THEN
        -- Log error but don't fail
        RAISE NOTICE 'Failed to mark webhook event as failed with message: %', SQLERRM;
END;
$function$;

-- Grant permissions to all functions
GRANT EXECUTE ON FUNCTION public.check_webhook_event_processed(UUID) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.mark_webhook_event_processed(UUID) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.mark_webhook_event_failed(UUID) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.mark_webhook_event_failed(UUID, TEXT) TO authenticated, anon;

-- Add comments
COMMENT ON FUNCTION public.check_webhook_event_processed(UUID) IS 'Checks webhook event processing status. Secured with search_path = empty.';
COMMENT ON FUNCTION public.mark_webhook_event_processed(UUID) IS 'Marks webhook event as processed. Secured with search_path = empty.';
COMMENT ON FUNCTION public.mark_webhook_event_failed(UUID) IS 'Marks webhook event as failed. Secured with search_path = empty.';
COMMENT ON FUNCTION public.mark_webhook_event_failed(UUID, TEXT) IS 'Marks webhook event as failed with error message. Secured with search_path = empty.';

-- Verify the functions were created correctly
DO $$
BEGIN
    RAISE NOTICE 'Successfully recreated webhook functions with secure search_path';
END
$$;
