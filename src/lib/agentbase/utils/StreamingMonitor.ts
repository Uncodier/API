/**
 * StreamingMonitor - Utility for monitoring streaming performance and detecting issues
 */

export interface StreamingMetrics {
  commandId: string;
  startTime: number;
  endTime?: number;
  totalChunks: number;
  totalCharacters: number;
  averageChunkSize: number;
  maxChunkDelay: number;
  timeouts: number;
  errors: string[];
  status: 'active' | 'completed' | 'failed' | 'timeout';
}

export class StreamingMonitor {
  private static activeStreams = new Map<string, StreamingMetrics>();
  private static completedStreams: StreamingMetrics[] = [];
  private static readonly MAX_COMPLETED_HISTORY = 50;

  /**
   * Start monitoring a stream
   */
  static startMonitoring(commandId: string): void {
    const metrics: StreamingMetrics = {
      commandId,
      startTime: Date.now(),
      totalChunks: 0,
      totalCharacters: 0,
      averageChunkSize: 0,
      maxChunkDelay: 0,
      timeouts: 0,
      errors: [],
      status: 'active'
    };

    this.activeStreams.set(commandId, metrics);
    console.log(`[StreamingMonitor] Started monitoring stream ${commandId}`);
  }

  /**
   * Record a chunk received
   */
  static recordChunk(commandId: string, chunkSize: number, chunkDelay: number): void {
    const metrics = this.activeStreams.get(commandId);
    if (!metrics) return;

    metrics.totalChunks++;
    metrics.totalCharacters += chunkSize;
    metrics.averageChunkSize = metrics.totalCharacters / metrics.totalChunks;
    metrics.maxChunkDelay = Math.max(metrics.maxChunkDelay, chunkDelay);

    // Log performance warnings
    if (chunkDelay > 10000) { // 10 seconds
      console.warn(`[StreamingMonitor] Slow chunk detected for ${commandId}: ${chunkDelay}ms delay`);
    }
  }

  /**
   * Record a timeout
   */
  static recordTimeout(commandId: string): void {
    const metrics = this.activeStreams.get(commandId);
    if (!metrics) return;

    metrics.timeouts++;
    console.warn(`[StreamingMonitor] Timeout recorded for ${commandId}. Total timeouts: ${metrics.timeouts}`);
  }

  /**
   * Record an error
   */
  static recordError(commandId: string, error: string): void {
    const metrics = this.activeStreams.get(commandId);
    if (!metrics) return;

    metrics.errors.push(error);
    console.error(`[StreamingMonitor] Error recorded for ${commandId}: ${error}`);
  }

  /**
   * Complete monitoring for a stream
   */
  static completeMonitoring(commandId: string, status: 'completed' | 'failed' | 'timeout'): StreamingMetrics | null {
    const metrics = this.activeStreams.get(commandId);
    if (!metrics) return null;

    metrics.endTime = Date.now();
    metrics.status = status;

    // Move to completed streams
    this.activeStreams.delete(commandId);
    this.completedStreams.unshift(metrics);

    // Keep only recent history
    if (this.completedStreams.length > this.MAX_COMPLETED_HISTORY) {
      this.completedStreams = this.completedStreams.slice(0, this.MAX_COMPLETED_HISTORY);
    }

    const duration = metrics.endTime - metrics.startTime;
    console.log(`[StreamingMonitor] Completed monitoring for ${commandId}: ${status} in ${duration}ms`);
    console.log(`[StreamingMonitor] Final metrics: ${metrics.totalChunks} chunks, ${metrics.totalCharacters} chars, ${metrics.timeouts} timeouts, ${metrics.errors.length} errors`);

    return metrics;
  }

  /**
   * Get current performance summary
   */
  static getPerformanceSummary(): {
    activeStreams: number;
    recentCompletions: number;
    averageDuration: number;
    successRate: number;
    commonErrors: string[];
  } {
    const recentCompletions = this.completedStreams.slice(0, 20);
    const successful = recentCompletions.filter(s => s.status === 'completed').length;
    const totalDuration = recentCompletions.reduce((sum, s) => sum + ((s.endTime || 0) - s.startTime), 0);
    const averageDuration = recentCompletions.length > 0 ? totalDuration / recentCompletions.length : 0;

    // Get most common errors
    const allErrors = recentCompletions.flatMap(s => s.errors);
    const errorCounts = allErrors.reduce((acc, error) => {
      acc[error] = (acc[error] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const commonErrors = Object.entries(errorCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([error]) => error);

    return {
      activeStreams: this.activeStreams.size,
      recentCompletions: recentCompletions.length,
      averageDuration,
      successRate: recentCompletions.length > 0 ? successful / recentCompletions.length : 0,
      commonErrors
    };
  }

  /**
   * Check for streams that might be stuck
   */
  static checkForStuckStreams(): string[] {
    const now = Date.now();
    const stuckThreshold = 5 * 60 * 1000; // 5 minutes
    const stuckStreams: string[] = [];

    for (const [commandId, metrics] of this.activeStreams.entries()) {
      const elapsed = now - metrics.startTime;
      if (elapsed > stuckThreshold) {
        stuckStreams.push(commandId);
        console.warn(`[StreamingMonitor] Potentially stuck stream detected: ${commandId} (${elapsed}ms elapsed)`);
      }
    }

    return stuckStreams;
  }
}
