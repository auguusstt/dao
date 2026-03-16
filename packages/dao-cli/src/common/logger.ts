import pino from "pino";

/**
 * Global logger configuration using pino.
 * Provides a wrapped interface for tagged logging and TUI integration.
 */
export const logger = {
  pino: pino({
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        ignore: "pid,hostname,tag",
        translateTime: "HH:MM:ss",
      },
    },
    level: "debug",
  }),

  /**
   * Returns a tagged logger interface.
   * Uses 'any' for arguments to match pino's flexible logging overloads.
   */
  withTag(tag: string) {
    const child = this.pino.child({ tag });
    return {
      debug: (msg: string, ...args: any[]) => child.debug(`[${tag}] ${msg}`, ...args),
      info: (msg: string, ...args: any[]) => child.info(`[${tag}] ${msg}`, ...args),
      warn: (msg: string, ...args: any[]) => child.warn(`[${tag}] ${msg}`, ...args),
      error: (msg: string, ...args: any[]) => child.error(`[${tag}] ${msg}`, ...args),
      success: (msg: string, ...args: any[]) => child.info(`[${tag}] ${msg}`, ...args),
    };
  },
};
