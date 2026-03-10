import pino from "pino";

export function setupLogger(name: string) {
  const logger = pino({
    name,
    level: process.env.DAO_LOG_LEVEL?.toLowerCase() || "info",
    timestamp: pino.stdTimeFunctions.isoTime
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
