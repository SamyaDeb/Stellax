import pino, { type Logger, type LoggerOptions } from "pino";

let rootLogger: Logger | null = null;

export function initLogger(level: string = "info"): Logger {
  if (rootLogger) return rootLogger;
  const opts: LoggerOptions = {
    level,
    base: { service: "stellax-keeper" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  // Use pretty transport in dev if TTY; otherwise plain JSON.
  if (process.stdout.isTTY && process.env.NODE_ENV !== "production") {
    try {
      rootLogger = pino({
        ...opts,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      });
      return rootLogger;
    } catch {
      // pino-pretty not installed; fall through to plain
    }
  }
  rootLogger = pino(opts);
  return rootLogger;
}

export function getLogger(component?: string): Logger {
  const base = rootLogger ?? initLogger();
  return component ? base.child({ component }) : base;
}
