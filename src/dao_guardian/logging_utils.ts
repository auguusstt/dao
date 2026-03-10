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
