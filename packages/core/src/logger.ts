// @celsian/core — Structured JSON logger (pino-style)

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
  level: LogLevel;
}

const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** Override output for testing — default: process.stdout.write */
  destination?: (line: string) => void;
  /** Static bindings merged into every log line */
  bindings?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = LEVEL_VALUES[options.level ?? 'info'];
  const write = options.destination ?? ((line: string) => {
    // Use console.log for cross-runtime compatibility (Edge, Node, Bun, Deno)
    console.log(line);
  });
  const baseBindings = options.bindings ?? {};

  function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_VALUES[level] < minLevel) return;

    const entry: Record<string, unknown> = {
      level,
      time: Date.now(),
      ...baseBindings,
      msg,
    };

    if (data) {
      for (const [key, value] of Object.entries(data)) {
        entry[key] = value;
      }
    }

    write(JSON.stringify(entry));
  }

  const logger: Logger = {
    get level() { return options.level ?? 'info'; },
    set level(l: LogLevel) { options.level = l; },

    trace(msg, data) { log('trace', msg, data); },
    debug(msg, data) { log('debug', msg, data); },
    info(msg, data) { log('info', msg, data); },
    warn(msg, data) { log('warn', msg, data); },
    error(msg, data) { log('error', msg, data); },
    fatal(msg, data) { log('fatal', msg, data); },

    child(bindings: Record<string, unknown>): Logger {
      return createLogger({
        level: options.level ?? 'info',
        destination: write,
        bindings: { ...baseBindings, ...bindings },
      });
    },
  };

  return logger;
}

let _idCounter = 0;

export function generateRequestId(): string {
  _idCounter = (_idCounter + 1) % 0x7FFFFFFF;
  return Date.now().toString(36) + '-' + _idCounter.toString(36);
}
