-- Fix update_conversation_last_message_time function and performance issues
-- 1. Fix schema reference issue when search_path is empty
-- 2. Clean up duplicate triggers that cause severe performance problems
-- 3. Optimize the function for better performance
-- Date: 2025-01-13

-- First, drop ALL existing triggers to clean up duplicates
DROP TRIGGER IF EXISTS on_message_insert ON public.messages;

-- Recreate the function with proper schema reference and performance optimizations
CREATE OR REPLACE FUNCTION public.update_conversation_last_message_time()
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Update the conversation's last_message_at timestamp
    -- Use explicit public schema reference since search_path is empty for security
    -- Only update if conversation_id is not null for performance
    IF NEW.conversation_id IS NOT NULL THEN
        UPDATE public.conversations 
        SET 
            last_message_at = NEW.created_at,  -- Use message timestamp instead of NOW() for consistency
            updated_at = NEW.created_at
        WHERE id = NEW.conversation_id;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Create a SINGLE trigger (avoid duplicates that cause performance issues)
CREATE TRIGGER on_message_insert
    AFTER INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.update_conversation_last_message_time();

-- Ensure optimal index exists for the update operation
CREATE INDEX IF NOT EXISTS idx_conversations_id_optimized 
ON public.conversations (id) 
WHERE last_message_at IS NOT NULL;

-- Add comments explaining the fixes
COMMENT ON FUNCTION public.update_conversation_last_message_time() IS 'Updates conversation last_message_at when a new message is inserted. Fixed schema reference and optimized for performance. Only one trigger should exist to avoid duplicates.';

-- Verify trigger count (should be exactly 1 for on_message_insert)
DO $$
DECLARE
    trigger_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO trigger_count
    FROM information_schema.triggers 
    WHERE trigger_name = 'on_message_insert' 
    AND event_object_table = 'messages'
    AND event_object_schema = 'public';
    
    RAISE NOTICE 'on_message_insert triggers found: %', trigger_count;
    
    IF trigger_count > 1 THEN
        RAISE WARNING 'Multiple on_message_insert triggers detected! This will cause severe performance issues.';
    END IF;
END $$;
