type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m",  // green
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function getTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

function serializeContext(context: LogContext): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      parts.push(`${DIM}${key}${RESET}=${JSON.stringify(value)}`);
    } else {
      parts.push(`${DIM}${key}${RESET}=${value}`);
    }
  }
  return parts.join("  ");
}

const formatLog = (level: LogLevel, message: string, context?: LogContext) => {
  if (process.env.NODE_ENV === "development") {
    const color = LEVEL_COLORS[level];
    const levelLabel = level.toUpperCase().padEnd(5);
    const time = getTime();
    const contextStr = context ? serializeContext(context) : "";
    const line = `${DIM}[${time}]${RESET} ${color}${BOLD}${levelLabel}${RESET}  ${message.padEnd(38)}  ${contextStr}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  } else {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      ...context,
    };
    console.log(JSON.stringify(logEntry));
  }
};

export const logger = {
  debug: (message: string, context?: LogContext) =>
    formatLog("debug", message, context),
  info: (message: string, context?: LogContext) =>
    formatLog("info", message, context),
  warn: (message: string, context?: LogContext) =>
    formatLog("warn", message, context),
  error: (message: string, context?: LogContext) =>
    formatLog("error", message, context),

  request: (method: string, path: string, context?: LogContext) => {
    formatLog("info", `→ ${method} ${path}`, context);
  },

  response: (
    method: string,
    path: string,
    statusCode: number,
    durationMs: number,
    context?: LogContext
  ) => {
    const level: LogLevel =
      statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";
    formatLog(level, `← ${method} ${path} ${statusCode} (${durationMs}ms)`, context);
  },
};

export default logger;
