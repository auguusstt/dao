import pino from "pino";

let globalCorrelationId: string | undefined;

export function setGlobalCorrelationId(corrId: string): void {
  globalCorrelationId = corrId;
}

export function getGlobalCorrelationId(): string | undefined {
  return globalCorrelationId;
}

export function setupLogger(name: string) {
  const logger = pino({
    name,
    level: process.env.DAO_LOG_LEVEL?.toLowerCase() || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { pid: process.pid }
  });
  return logger;
}

export function logMetrics(logger: pino.Logger, metrics: Record<string, any>, level: string = "info") {
  if (!metrics) return;
  const l = level.toLowerCase();
  const msg = Object.entries(metrics)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  if (l === "debug") logger.debug({ metrics }, msg);
  else if (l === "warn" || l === "warning") logger.warn({ metrics }, msg);
  else if (l === "error") logger.error({ metrics }, msg);
  else logger.info({ metrics }, msg);
}

export function logSummary(logger: pino.Logger, summary: {
  cycle: number;
  status: string;
  score: number;
  tool: string;
  reason?: string;
  changed_count?: number;
}) {
  const { cycle, status, score, tool, reason, changed_count } = summary;
  const level = status === "PROMOTED" ? "info" : (score > 0.5 ? "warn" : "error");
  const msg = `Cycle ${cycle} ${status}: tool=${tool} score=${score.toFixed(2)} changed=${changed_count ?? 0}`;
  
  const payload = { 
    cycle, 
    status, 
    score, 
    tool, 
    reason, 
    changed_count,
    timestamp: new Date().toISOString()
  };

  if (level === "error") logger.error(payload, msg);
  else if (level === "warn") logger.warn(payload, msg);
  else logger.info(payload, msg);
}

export function logException(logger: pino.Logger, err: any, msg: string, context: Record<string, any> = {}) {
  const payload: Record<string, any> = {
    ...context,
    corr_id: getGlobalCorrelationId(),
    err: err instanceof Error 
      ? { 
          message: err.message, 
          stack: err.stack,
          name: err.name,
          code: (err as any).code
        } 
      : { message: String(err) },
    timestamp: new Date().toISOString()
  };
  logger.error(payload, `${msg}: ${payload.err.message}`);
}

export function safeLog(logger: pino.Logger, level: string, msg: string, ...args: any[]): boolean {
  try {
    const l = level.toLowerCase();
    const fn = (logger as any)[l] ?? logger.info.bind(logger);
    fn(msg, ...(args as any));
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a short correlation ID for tracing requests across logs
 */
export function generateCorrelationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Wrap an async operation with automatic error logging and correlation ID tracking.
 * Returns [success, result, error] tuple.
 */
export async function withErrorContext<T>(
  logger: pino.Logger,
  operation: () => Promise<T>,
  context: { name: string; corrId?: string; details?: Record<string, any> }
): Promise<[boolean, T | null, Error | null]> {
  const corrId = context.corrId ?? generateCorrelationId();
  const prevCorrId = getGlobalCorrelationId();
  setGlobalCorrelationId(corrId);
  
  try {
    logger.info({ corrId, op: context.name, ...context.details }, `Starting operation: ${context.name}`);
    const result = await operation();
    logger.info({ corrId, op: context.name }, `Completed operation: ${context.name}`);
    return [true, result, null];
  } catch (err) {
    logException(logger, err, `Operation failed: ${context.name}`, { corrId, ...context.details });
    return [false, null, err instanceof Error ? err : new Error(String(err))];
  } finally {
    setGlobalCorrelationId(prevCorrId ?? "");
  }
}

/**
 * Health check summary for evolution cycle monitoring.
 * Tracks key metrics for observability and recovery analysis.
 */
export interface HealthCheckResult {
  timestamp: string;
  total_cycles: number;
  successful_promotions: number;
  failed_cycles: number;
  success_rate: number;
  consecutive_failures: number;
  last_tool: string;
  status: "healthy" | "degraded" | "critical";
  message: string;
  suggestion?: string;
}

/**
 * Calculate health status based on evolution metrics.
 * Returns health check result for observability tracking.
 * Flexible enough to handle both evolution status and simulation states.
 */
export function checkEvolutionHealth(history: Array<any>): HealthCheckResult {
  const timestamp = new Date().toISOString();
  const total = history.length;
  
  // Successful items: PROMOTED (evolution) or RUNNING (simulation)
  const successful = history.filter(h => h.status === "PROMOTED" || h.state === "RUNNING").length;
  
  // Failure indicators: FAIL (evolution) or DEGRADED/RECOVERY (simulation)
  const failed = history.filter(h => h.status === "FAIL" || h.state === "DEGRADED" || h.state === "RECOVERY").length;
  
  const successRate = total > 0 ? successful / total : 0;
  
  // Count consecutive failures from the end
  let consecutiveFailures = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const isFailure = item.status === "FAIL" || item.state === "DEGRADED" || item.state === "RECOVERY";
    if (isFailure) {
      consecutiveFailures++;
    } else {
      break;
    }
  }
  
  const lastTool = history.length > 0 ? (history[history.length - 1].tool || "simulation") : "none";
  
  // Determine status
  let status: HealthCheckResult["status"];
  let message: string;
  let suggestion: string | undefined;
  
  if (consecutiveFailures >= 5) {
    status = "critical";
    message = `系统健康度告警: 连续故障 ${consecutiveFailures} 次`;
    suggestion = "考虑重置 evolution_plan.json 或切换更强大的模型工具";
  } else if (consecutiveFailures >= 3 || (total > 5 && successRate < 0.3)) {
    status = "degraded";
    message = `系统性能下降，健康度 ${ (successRate * 100).toFixed(1)}%`;
    suggestion = "优先修复当前验证失败项，避免引入新功能";
  } else {
    status = "healthy";
    message = `系统运行正常，健康度 ${ (successRate * 100).toFixed(1)}%`;
    suggestion = "继续按照计划推进最小化改进";
  }
  
  return {
    timestamp,
    total_cycles: total,
    successful_promotions: successful,
    failed_cycles: failed,
    success_rate: Number(successRate.toFixed(4)),
    consecutive_failures: consecutiveFailures,
    last_tool: lastTool,
    status,
    message,
    suggestion
  };
}

/**
 * Log health check result for observability.
 */
export function logHealthCheck(logger: pino.Logger, health: HealthCheckResult): void {
  const level = health.status === "healthy" ? "info" :
                health.status === "degraded" ? "warn" : "error";
  const fn = (logger as any)[level] ?? logger.info.bind(logger);
  fn.call(logger, health, `[HealthCheck] ${health.status.toUpperCase()}: ${health.message}`);
}

/**
 * Tool failure analysis for debugging failed evolution cycles.
 * Captures tool output patterns to help diagnose recurring failures.
 */
export interface ToolFailureAnalysis {
  timestamp: string;
  cycle: number;
  tool: string;
  failure_mode: "timeout" | "no_changes" | "validation_failed" | "guard_blocked" | "unknown";
  output_preview: string;
  changed_files: string[];
  suggestion?: string;
}

/**
 * Analyze and log tool failure for recoverability.
 * Helps identify patterns in failed cycles.
 */
export function logToolFailure(
  logger: pino.Logger,
  analysis: ToolFailureAnalysis
): void {
  const { cycle, tool, failure_mode, output_preview, changed_files } = analysis;
  
  let suggestion = analysis.suggestion;
  if (!suggestion) {
    if (failure_mode === "no_changes") {
      suggestion = "Tool produced no code changes; consider adjusting objective or tool prompt";
    } else if (failure_mode === "validation_failed") {
      suggestion = "Code changes failed TypeScript validation; review type errors";
    } else if (failure_mode === "guard_blocked") {
      suggestion = "Changes violated guard rules (protected paths or allowed roots)";
    } else if (failure_mode === "timeout") {
      suggestion = "Tool execution timed out; consider reducing scope or increasing timeout";
    }
  }

  const payload = {
    ...analysis,
    suggestion,
    corr_id: getGlobalCorrelationId(),
    timestamp: new Date().toISOString()
  };

  logger.warn(payload, `[ToolFailure] Cycle ${cycle} ${tool} failed: ${failure_mode}`);
}
