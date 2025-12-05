/**
 * Simple structured logger for API debugging
 * Outputs JSON format for easy parsing in production
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

const formatLog = (level: LogLevel, message: string, context?: LogContext) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level: level.toUpperCase(),
    message,
    ...context,
  };

  // In development, pretty print. In production, use JSON.
  if (process.env.NODE_ENV === 'development') {
    const levelColors: Record<LogLevel, string> = {
      debug: '\x1b[36m', // cyan
      info: '\x1b[32m',  // green
      warn: '\x1b[33m',  // yellow
      error: '\x1b[31m', // red
    };
    const reset = '\x1b[0m';
    const color = levelColors[level];
    
    console.log(
      `${color}[${timestamp}] [${level.toUpperCase()}]${reset} ${message}`,
      context ? `\n${JSON.stringify(context, null, 2)}` : ''
    );
  } else {
    console.log(JSON.stringify(logEntry));
  }
};

export const logger = {
  debug: (message: string, context?: LogContext) => formatLog('debug', message, context),
  info: (message: string, context?: LogContext) => formatLog('info', message, context),
  warn: (message: string, context?: LogContext) => formatLog('warn', message, context),
  error: (message: string, context?: LogContext) => formatLog('error', message, context),

  // Helper for request logging
  request: (method: string, path: string, context?: LogContext) => {
    formatLog('info', `→ ${method} ${path}`, context);
  },

  // Helper for response logging
  response: (method: string, path: string, statusCode: number, durationMs: number, context?: LogContext) => {
    const level: LogLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    formatLog(level, `← ${method} ${path} ${statusCode} (${durationMs}ms)`, context);
  },
};

export default logger;

