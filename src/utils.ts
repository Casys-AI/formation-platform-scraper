import pino from 'pino';
import slugifyLib from 'slugify';
import { resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';

// Ensure logs directory exists
const logsDir = resolve(process.cwd(), 'output', 'logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

// Generate log filename with date
const logFile = resolve(logsDir, `scraper-${new Date().toISOString().slice(0, 10)}.log`);

/**
 * Create a logger instance with triple output: console + file + Loki
 */
export function createLogger(name: string) {
  const targets: any[] = [
    // Console output (pretty for humans)
    {
      target: 'pino-pretty',
      level: 'info',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
    // File output (JSON for analysis)
    {
      target: 'pino/file',
      level: 'info',
      options: {
        destination: logFile,
        mkdir: true,
      },
    },
  ];

  // Add Loki transport if enabled (default: true)
  if (process.env.LOKI_ENABLED !== 'false') {
    targets.push({
      target: 'pino-loki',
      level: 'info',
      options: {
        batching: true,
        interval: 5,
        host: process.env.LOKI_URL || 'http://localhost:3100',
        labels: { application: 'scraper-formation' },
      },
    });
  }

  return pino({
    level: process.env.LOG_LEVEL || 'info',
    name,
  }, pino.transport({ targets }));
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number;
    delay?: number;
    backoff?: number;
  } = {}
): Promise<T> {
  const { retries = 3, delay = 1000, backoff = 2 } = options;

  let lastError: Error | undefined;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (i < retries - 1) {
        const waitTime = delay * Math.pow(backoff, i);
        await sleep(waitTime);
      }
    }
  }

  throw lastError;
}

/**
 * Slugify a string for use in filenames
 */
export function slugify(text: string): string {
  return slugifyLib(text, {
    lower: true,
    strict: true,
    remove: /[*+~.()'"!:@]/g,
  });
}

/**
 * Format a duration in milliseconds as HH:MM:SS
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const h = hours.toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');

  return `${h}:${m}:${s}`;
}

/**
 * Redact email address for safe logging (GDPR compliance)
 * Shows first 2 characters of local part and full domain
 *
 * @param email Email address to redact
 * @returns Redacted email (e.g., "us***@example.com")
 *
 * @example
 * redactEmail('user@example.com') // → "us***@example.com"
 * redactEmail('a@test.com') // → "a***@test.com"
 */
export function redactEmail(email: string): string {
  if (!email || !email.includes('@')) {
    return '***';
  }

  const [local, domain] = email.split('@');
  const visibleChars = Math.min(2, local.length);
  return `${local.slice(0, visibleChars)}***@${domain}`;
}
