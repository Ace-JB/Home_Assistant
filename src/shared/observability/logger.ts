export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

const isProduction = process.env.NODE_ENV === 'production';

export function createLogger(namespace: string): Logger {
  const write = (level: LogLevel, message: string, meta?: unknown) => {
    if (isProduction && level === 'debug') return;
    const payload = meta === undefined ? '' : meta;
    console[level](`[${namespace}] ${message}`, payload);
  };

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}
