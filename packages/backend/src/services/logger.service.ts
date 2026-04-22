type LogLevel = "debug" | "info" | "warn" | "error";

type LogMeta = unknown;

type LogColors = {
  debug: string;
  info: string;
  warn: string;
  error: string;
  reset: string;
};

export type ScopedLogger = {
  debug: (message: string, meta?: LogMeta) => void;
  info: (message: string, meta?: LogMeta) => void;
  warn: (message: string, meta?: LogMeta) => void;
  error: (message: string, meta?: LogMeta) => void;
  scoped: (childScope: string, meta?: LogMeta) => ScopedLogger;
};

/**
 * Minimal, dependency-free logger with scopes and high-resolution timings.
 * Output format is single-line JSON for easy ingestion by log platforms.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: matches pulse project pattern, intentional singleton
export class LoggerService {
  private static colors: LogColors = {
    debug: "\x1b[36m", // Cyan
    info: "\x1b[32m", // Green
    warn: "\x1b[33m", // Yellow
    error: "\x1b[31m", // Red
    reset: "\x1b[0m", // Reset
  };

  private static jsonReplacer(_key: string, value: unknown): unknown {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
        ...Object.fromEntries(Object.entries(value)),
      };
    }
    return value;
  }

  private static isColorEnabled(): boolean {
    return process.env.NODE_ENV !== "production";
  }

  private static isLogLevelEnabled(level: LogLevel): boolean {
    const envLevels = process.env.LOG_LEVEL;
    if (!envLevels) {
      return true;
    }

    const enabledLevels = envLevels
      .toLowerCase()
      .split(",")
      .map((l) => l.trim());
    return enabledLevels.includes(level);
  }

  private static write(
    level: LogLevel,
    scope: string | undefined,
    message: string,
    meta?: LogMeta,
  ): void {
    if (!LoggerService.isLogLevelEnabled(level)) {
      return;
    }

    const ts = new Date().toISOString();
    const levelStr = level.toUpperCase();
    const scopeStr = scope ? ` (${scope})` : "";

    const colorEnabled = LoggerService.isColorEnabled();
    const color = colorEnabled ? LoggerService.colors[level] : "";
    const reset = colorEnabled ? LoggerService.colors.reset : "";

    const line = `${color}${levelStr} [${ts}]${scopeStr} -> ${message}${reset}`;
    const output =
      meta !== undefined
        ? `${line} ${JSON.stringify(meta, LoggerService.jsonReplacer)}\n`
        : `${line}\n`;
    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
    stream.write(output);
  }

  private static mergeMeta(
    defaultMeta: LogMeta | undefined,
    meta: LogMeta | undefined,
  ): LogMeta | undefined {
    if (meta === undefined) return defaultMeta;
    if (defaultMeta === undefined) return meta;

    if (
      typeof defaultMeta === "object" &&
      defaultMeta !== null &&
      typeof meta === "object" &&
      meta !== null &&
      !Array.isArray(defaultMeta) &&
      !Array.isArray(meta)
    ) {
      return { ...defaultMeta, ...meta };
    }

    return meta;
  }

  public static scoped(scope: string, defaultMeta?: LogMeta): ScopedLogger {
    const write = (level: LogLevel, message: string, meta?: LogMeta) =>
      LoggerService.write(level, scope, message, LoggerService.mergeMeta(defaultMeta, meta));

    const scoped = (childScope: string, meta?: LogMeta): ScopedLogger => {
      const combinedScope = `${scope}::${childScope}`;
      const mergedMeta = LoggerService.mergeMeta(defaultMeta, meta);
      return LoggerService.scoped(combinedScope, mergedMeta);
    };

    return {
      debug: (message: string, meta?: LogMeta) => write("debug", message, meta),
      info: (message: string, meta?: LogMeta) => write("info", message, meta),
      warn: (message: string, meta?: LogMeta) => write("warn", message, meta),
      error: (message: string, meta?: LogMeta) => write("error", message, meta),
      scoped,
    };
  }

  public static debug(message: string, meta?: LogMeta): void {
    LoggerService.write("debug", undefined, message, meta);
  }
  public static info(message: string, meta?: LogMeta): void {
    LoggerService.write("info", undefined, message, meta);
  }
  public static warn(message: string, meta?: LogMeta): void {
    LoggerService.write("warn", undefined, message, meta);
  }
  public static error(message: string, meta?: LogMeta): void {
    LoggerService.write("error", undefined, message, meta);
  }
}
