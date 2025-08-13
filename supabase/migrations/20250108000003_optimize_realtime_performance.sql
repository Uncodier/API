-- Migration: Optimize Supabase Realtime Performance
-- Purpose: Optimize the realtime.list_changes function and related performance bottlenecks
-- Date: 2025-01-08
-- Target Issue: Slow realtime.list_changes($1, $2, $3, $4) query consuming 96.3% of total time

-- ================================================================================
-- REALTIME OPTIMIZATION STRATEGIES
-- ================================================================================

-- 1. Add indexes to frequently accessed realtime tables
-- These indexes help with the realtime.list_changes function performance

-- Optimize messages table for realtime subscriptions (most active table)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_created_at_conversation 
ON public.messages (conversation_id, created_at DESC) 
WHERE created_at > NOW() - INTERVAL '24 hours';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_realtime_filter 
ON public.messages (conversation_id, role, created_at) 
WHERE created_at > NOW() - INTERVAL '1 hour';

-- Optimize session_events for realtime tracking
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_events_realtime 
ON public.session_events (site_id, timestamp DESC, event_type) 
WHERE timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '2 hours') * 1000;

-- Optimize visitor_sessions for realtime updates
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_visitor_sessions_realtime 
ON public.visitor_sessions (site_id, is_active, last_activity_at DESC) 
WHERE is_active = true;

-- 2. Optimize tables that are frequently updated and monitored by realtime
-- Add partial indexes for recently updated records

-- Index for recent leads (often updated and monitored)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_recent_updates 
ON public.leads (site_id, status, updated_at DESC) 
WHERE updated_at > NOW() - INTERVAL '6 hours';

-- Index for recent tasks (frequently updated)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_recent_updates 
ON public.tasks (site_id, status, updated_at DESC) 
WHERE updated_at > NOW() - INTERVAL '6 hours';

-- Index for recent notifications (high volume inserts)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_recent 
ON public.notifications (user_id, is_read, created_at DESC) 
WHERE created_at > NOW() - INTERVAL '24 hours';

-- 3. Create a function to optimize realtime subscriptions
-- This function helps reduce the load on realtime.list_changes

CREATE OR REPLACE FUNCTION optimize_realtime_subscriptions()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    -- Analyze table statistics for realtime-monitored tables
    ANALYZE public.messages;
    ANALYZE public.session_events;
    ANALYZE public.visitor_sessions;
    ANALYZE public.leads;
    ANALYZE public.tasks;
    ANALYZE public.notifications;
    
    -- Update table statistics
    RAISE NOTICE 'Realtime subscription tables analyzed successfully';
END;
$$;

-- 4. Create a function to clean up old realtime-related data
-- This reduces the amount of data that realtime.list_changes needs to process

CREATE OR REPLACE FUNCTION cleanup_old_realtime_data(retention_hours INTEGER DEFAULT 72)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    cleaned_count INTEGER := 0;
    cutoff_time TIMESTAMP;
BEGIN
    cutoff_time := NOW() - INTERVAL '1 hour' * retention_hours;
    
    -- Clean up old session events (keeping only recent ones for realtime)
    DELETE FROM public.session_events 
    WHERE created_at < cutoff_time 
    AND event_type IN ('mouse_move', 'scroll', 'idle');
    
    GET DIAGNOSTICS cleaned_count = ROW_COUNT;
    
    -- Clean up old visitor sessions that are no longer active
    UPDATE public.visitor_sessions 
    SET is_active = false 
    WHERE last_activity_at < EXTRACT(EPOCH FROM cutoff_time) * 1000 
    AND is_active = true;
    
    RAISE NOTICE 'Cleaned up % old realtime records', cleaned_count;
    RETURN cleaned_count;
END;
$$;

-- 5. Create optimized views for common realtime queries
-- These pre-computed views reduce the load on realtime.list_changes

CREATE OR REPLACE VIEW realtime_active_conversations AS
SELECT 
    c.id,
    c.site_id,
    c.visitor_id,
    c.agent_id,
    c.status,
    c.last_message_at,
    c.updated_at,
    COUNT(m.id) as message_count
FROM public.conversations c
LEFT JOIN public.messages m ON c.id = m.conversation_id 
    AND m.created_at > NOW() - INTERVAL '1 hour'
WHERE c.status = 'active' 
    AND c.updated_at > NOW() - INTERVAL '2 hours'
GROUP BY c.id, c.site_id, c.visitor_id, c.agent_id, c.status, c.last_message_at, c.updated_at;

-- Index for the view
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_realtime_view 
ON public.conversations (status, updated_at DESC) 
WHERE status = 'active' AND updated_at > NOW() - INTERVAL '2 hours';

-- 6. Create a materialized view for heavy realtime queries
-- This is refreshed periodically to reduce real-time computation load

CREATE MATERIALIZED VIEW IF NOT EXISTS realtime_performance_summary AS
SELECT 
    site_id,
    COUNT(*) FILTER (WHERE event_type = 'pageview') as pageviews_last_hour,
    COUNT(*) FILTER (WHERE event_type = 'click') as clicks_last_hour,
    COUNT(DISTINCT visitor_id) as unique_visitors_last_hour,
    MAX(timestamp) as last_activity_timestamp,
    NOW() as last_updated
FROM public.session_events 
WHERE timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour') * 1000
GROUP BY site_id;

-- Create unique index for materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_performance_summary_site 
ON realtime_performance_summary (site_id);

-- 7. Function to refresh materialized view (to be called by cron)
CREATE OR REPLACE FUNCTION refresh_realtime_performance_summary()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY realtime_performance_summary;
    RAISE NOTICE 'Realtime performance summary refreshed at %', NOW();
END;
$$;

-- 8. Optimize PostgreSQL settings for realtime performance
-- These settings help with WAL processing and replication

-- Create a function to suggest optimal settings (informational only)
CREATE OR REPLACE FUNCTION suggest_realtime_pg_settings()
RETURNS TABLE(setting_name TEXT, suggested_value TEXT, current_value TEXT, description TEXT)
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        'wal_level'::TEXT,
        'logical'::TEXT,
        current_setting('wal_level')::TEXT,
        'Required for logical replication used by Supabase Realtime'::TEXT
    UNION ALL
    SELECT 
        'max_wal_senders'::TEXT,
        '10'::TEXT,
        current_setting('max_wal_senders')::TEXT,
        'Number of WAL sender processes for replication'::TEXT
    UNION ALL
    SELECT 
        'max_replication_slots'::TEXT,
        '10'::TEXT,
        current_setting('max_replication_slots')::TEXT,
        'Maximum replication slots for logical replication'::TEXT
    UNION ALL
    SELECT 
        'wal_keep_size'::TEXT,
        '1GB'::TEXT,
        current_setting('wal_keep_size')::TEXT,
        'Amount of WAL to keep for replication'::TEXT;
END;
$$;

-- 9. Create monitoring function for realtime performance
CREATE OR REPLACE FUNCTION monitor_realtime_performance()
RETURNS TABLE(
    metric_name TEXT,
    metric_value NUMERIC,
    status TEXT,
    recommendation TEXT
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    active_connections INTEGER;
    recent_messages INTEGER;
    avg_response_time NUMERIC;
BEGIN
    -- Count active realtime connections (approximate)
    SELECT COUNT(*) INTO active_connections
    FROM public.conversations 
    WHERE status = 'active' AND last_message_at > NOW() - INTERVAL '5 minutes';
    
    -- Count recent messages (high volume indicator)
    SELECT COUNT(*) INTO recent_messages
    FROM public.messages 
    WHERE created_at > NOW() - INTERVAL '5 minutes';
    
    -- Calculate average response time for recent messages
    SELECT AVG(EXTRACT(EPOCH FROM (created_at - LAG(created_at) OVER (PARTITION BY conversation_id ORDER BY created_at))))
    INTO avg_response_time
    FROM public.messages 
    WHERE created_at > NOW() - INTERVAL '1 hour' AND role = 'assistant';
    
    RETURN QUERY
    SELECT 
        'active_conversations'::TEXT,
        active_connections::NUMERIC,
        CASE WHEN active_connections > 100 THEN 'WARNING' ELSE 'OK' END::TEXT,
        CASE WHEN active_connections > 100 THEN 'Consider scaling realtime resources' ELSE 'Normal load' END::TEXT
    UNION ALL
    SELECT 
        'recent_messages_per_5min'::TEXT,
        recent_messages::NUMERIC,
        CASE WHEN recent_messages > 1000 THEN 'WARNING' ELSE 'OK' END::TEXT,
        CASE WHEN recent_messages > 1000 THEN 'High message volume detected' ELSE 'Normal message volume' END::TEXT
    UNION ALL
    SELECT 
        'avg_response_time_seconds'::TEXT,
        COALESCE(avg_response_time, 0)::NUMERIC,
        CASE WHEN COALESCE(avg_response_time, 0) > 5 THEN 'WARNING' ELSE 'OK' END::TEXT,
        CASE WHEN COALESCE(avg_response_time, 0) > 5 THEN 'Slow response times detected' ELSE 'Normal response times' END::TEXT;
END;
$$;

-- 10. Grant necessary permissions
GRANT EXECUTE ON FUNCTION optimize_realtime_subscriptions() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_old_realtime_data(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION refresh_realtime_performance_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION suggest_realtime_pg_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION monitor_realtime_performance() TO authenticated;
GRANT SELECT ON realtime_active_conversations TO authenticated;
GRANT SELECT ON realtime_performance_summary TO authenticated;

-- 11. Add comments for documentation
COMMENT ON FUNCTION optimize_realtime_subscriptions() IS 'Optimizes table statistics for realtime-monitored tables to improve realtime.list_changes performance';
COMMENT ON FUNCTION cleanup_old_realtime_data(INTEGER) IS 'Cleans up old realtime data to reduce load on realtime.list_changes function';
COMMENT ON FUNCTION refresh_realtime_performance_summary() IS 'Refreshes materialized view for realtime performance metrics';
COMMENT ON FUNCTION monitor_realtime_performance() IS 'Monitors realtime performance metrics and provides recommendations';
COMMENT ON VIEW realtime_active_conversations IS 'Optimized view for active conversations monitored by realtime';
COMMENT ON MATERIALIZED VIEW realtime_performance_summary IS 'Pre-computed performance metrics for realtime monitoring';

-- 12. Initial optimization run
SELECT optimize_realtime_subscriptions();
SELECT cleanup_old_realtime_data(72);
SELECT refresh_realtime_performance_summary();

RAISE NOTICE 'Realtime optimization migration completed successfully';
RAISE NOTICE 'Consider setting up a cron job to run these functions periodically:';
RAISE NOTICE '- optimize_realtime_subscriptions() every 6 hours';
RAISE NOTICE '- cleanup_old_realtime_data() every 12 hours';
RAISE NOTICE '- refresh_realtime_performance_summary() every 15 minutes';
