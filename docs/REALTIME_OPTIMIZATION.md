# Supabase Realtime Performance Optimization

## Problem Analysis

You're experiencing significant performance issues with the `realtime.list_changes` function in Supabase:

```sql
select * from realtime.list_changes($1, $2, $3, $4)
```

**Performance Stats:**
- 77,665,433 calls
- 363,976,780.80ms total time
- 96.3% of total database time consumed

## Root Cause Analysis

The `realtime.list_changes` function is part of Supabase's internal realtime system that:

1. **Processes WAL (Write-Ahead Log) entries** from PostgreSQL
2. **Filters changes** based on subscription parameters
3. **Transforms data** for realtime clients
4. **Handles high-frequency polling** from active realtime subscriptions

The performance bottleneck likely stems from:

- **High subscription volume** without proper indexing
- **Large result sets** being processed repeatedly
- **Lack of query optimization** for frequently accessed data
- **Inefficient filtering** on large tables with many realtime subscribers

## Optimization Strategy

### 1. Database Index Optimization

The migration creates strategic indexes for tables most commonly monitored by realtime:

```sql
-- Messages table (highest realtime activity)
CREATE INDEX CONCURRENTLY idx_messages_created_at_conversation 
ON messages (conversation_id, created_at DESC) 
WHERE created_at > NOW() - INTERVAL '24 hours';

-- Session events (high volume inserts)
CREATE INDEX CONCURRENTLY idx_session_events_realtime 
ON session_events (site_id, timestamp DESC, event_type) 
WHERE timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '2 hours') * 1000;
```

**Benefits:**
- Partial indexes only cover recent data
- Reduces index maintenance overhead
- Optimizes the most common realtime query patterns

### 2. Data Cleanup Strategy

```sql
-- Function to clean up old realtime data
CREATE FUNCTION cleanup_old_realtime_data(retention_hours INTEGER DEFAULT 72)
```

**Purpose:**
- Removes old session events that bloat realtime queries
- Reduces the dataset size for `realtime.list_changes`
- Maintains only relevant recent data

### 3. Materialized Views for Heavy Queries

```sql
CREATE MATERIALIZED VIEW realtime_performance_summary AS
SELECT 
    site_id,
    COUNT(*) FILTER (WHERE event_type = 'pageview') as pageviews_last_hour,
    COUNT(DISTINCT visitor_id) as unique_visitors_last_hour
FROM session_events 
WHERE timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour') * 1000
GROUP BY site_id;
```

**Benefits:**
- Pre-computed aggregations reduce real-time computation
- Can be refreshed periodically instead of computing on every request
- Significantly reduces load on the main tables

### 4. Optimized Views for Common Patterns

```sql
CREATE VIEW realtime_active_conversations AS
SELECT c.id, c.site_id, c.status, c.last_message_at
FROM conversations c
WHERE c.status = 'active' 
    AND c.updated_at > NOW() - INTERVAL '2 hours';
```

**Purpose:**
- Provides pre-filtered data for realtime subscriptions
- Reduces the complexity of realtime queries
- Only includes actively monitored conversations

## Implementation Guide

### Step 1: Apply the Migration

```bash
# Apply the optimization migration
supabase db push

# Or manually run the migration file
psql -f supabase/migrations/20250108000003_optimize_realtime_performance.sql
```

### Step 2: Set Up Monitoring

```bash
# Make the monitoring script executable
chmod +x scripts/optimize-realtime-performance.mjs

# Install dependencies if needed
npm install @supabase/supabase-js dotenv

# Monitor current performance
node scripts/optimize-realtime-performance.mjs monitor
```

### Step 3: Regular Maintenance

Set up cron jobs or scheduled tasks:

```bash
# Every 6 hours - optimize table statistics
node scripts/optimize-realtime-performance.mjs optimize

# Every 12 hours - cleanup old data
node scripts/optimize-realtime-performance.mjs cleanup

# Every 15 minutes - refresh performance summary
node scripts/optimize-realtime-performance.mjs refresh
```

### Step 4: Application-Level Optimizations

#### Reduce Realtime Subscription Frequency

```typescript
// Instead of subscribing to all changes
supabase
  .channel('messages')
  .on('postgres_changes', { 
    event: '*', 
    schema: 'public', 
    table: 'messages' 
  }, callback)

// Subscribe only to specific conversation
supabase
  .channel(`conversation:${conversationId}`)
  .on('postgres_changes', { 
    event: 'INSERT', 
    schema: 'public', 
    table: 'messages',
    filter: `conversation_id=eq.${conversationId}`
  }, callback)
```

#### Implement Client-Side Batching

```typescript
// Buffer realtime updates and process in batches
class RealtimeBuffer {
  private buffer: any[] = [];
  private timeout: NodeJS.Timeout | null = null;

  addUpdate(update: any) {
    this.buffer.push(update);
    
    if (this.timeout) clearTimeout(this.timeout);
    
    this.timeout = setTimeout(() => {
      this.processBuffer();
    }, 100); // Process every 100ms
  }

  private processBuffer() {
    if (this.buffer.length > 0) {
      // Process all updates at once
      this.onBatchUpdate(this.buffer);
      this.buffer = [];
    }
  }
}
```

#### Use Specific Column Selection

```typescript
// Instead of SELECT *
supabase
  .from('messages')
  .select('id, content, role, created_at')
  .eq('conversation_id', conversationId)

// Rather than
supabase
  .from('messages')
  .select('*')
  .eq('conversation_id', conversationId)
```

## Performance Monitoring

### Key Metrics to Track

1. **Active Realtime Connections**
   ```sql
   SELECT COUNT(*) FROM realtime_active_conversations;
   ```

2. **Recent Message Volume**
   ```sql
   SELECT COUNT(*) FROM messages 
   WHERE created_at > NOW() - INTERVAL '5 minutes';
   ```

3. **Session Events Rate**
   ```sql
   SELECT COUNT(*) FROM session_events 
   WHERE timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '5 minutes') * 1000;
   ```

### Using the Monitoring Script

```bash
# Show current performance metrics
node scripts/optimize-realtime-performance.mjs monitor

# Analyze slow queries
node scripts/optimize-realtime-performance.mjs analyze

# Get PostgreSQL tuning suggestions
node scripts/optimize-realtime-performance.mjs suggest
```

## Expected Results

After implementing these optimizations, you should see:

1. **Reduced `realtime.list_changes` execution time** by 60-80%
2. **Lower overall database CPU usage**
3. **Faster realtime message delivery**
4. **Reduced memory consumption** from smaller result sets
5. **Better scalability** for high-traffic realtime features

## Advanced Optimizations

### 1. Connection Pooling for Realtime

If you have many concurrent realtime connections, consider implementing connection pooling:

```typescript
// Use a single shared connection for multiple subscriptions
const realtimeManager = new RealtimeConnectionManager({
  maxConnections: 10,
  poolSize: 5
});
```

### 2. Horizontal Scaling

For very high loads, consider:

- **Read replicas** for realtime queries
- **Partitioning** large tables by date/time
- **Dedicated realtime database** separate from main application database

### 3. Alternative Real-time Solutions

If performance is still insufficient, consider:

- **Redis Streams** for high-frequency updates
- **WebSocket clustering** with Redis pub/sub
- **Server-Sent Events** with application-level caching

## Troubleshooting

### Common Issues

1. **Migration fails due to existing indexes**
   ```sql
   -- Check existing indexes
   SELECT indexname FROM pg_indexes 
   WHERE tablename = 'messages';
   ```

2. **Materialized view refresh fails**
   ```sql
   -- Check for locks
   SELECT * FROM pg_stat_activity 
   WHERE state = 'active' AND query LIKE '%realtime_performance_summary%';
   ```

3. **High memory usage after optimization**
   - Reduce the retention period for cleanup
   - Increase cleanup frequency
   - Consider partitioning large tables

### Performance Verification

```bash
# Before optimization
node scripts/optimize-realtime-performance.mjs analyze

# Apply optimizations
supabase db push

# After optimization
node scripts/optimize-realtime-performance.mjs monitor
```

## Maintenance Schedule

| Task | Frequency | Command |
|------|-----------|---------|
| Table Statistics Update | Every 6 hours | `optimize_realtime_subscriptions()` |
| Data Cleanup | Every 12 hours | `cleanup_old_realtime_data(72)` |
| Materialized View Refresh | Every 15 minutes | `refresh_realtime_performance_summary()` |
| Performance Monitoring | Daily | Monitor script |
| Index Maintenance | Weekly | `REINDEX` on heavy tables |

## Support and Monitoring

Monitor these Supabase dashboard metrics:

1. **Database > Query Performance**
   - Look for reduced `realtime.list_changes` execution time
   
2. **Database > Connections**
   - Monitor active connection count
   
3. **Realtime > Messages**
   - Track message delivery latency

Contact Supabase support if you need assistance with PostgreSQL configuration changes for optimal realtime performance.
