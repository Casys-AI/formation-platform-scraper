/**
 * Configuration management for content extraction
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from './utils.js';
import type { ProxyConfig, AntiDetectionConfig } from './types.js';

const logger = createLogger('config');

export interface ExtractionConfig {
  formationUrl: string;        // URL of the formation to scrape
  mode: 'chapters' | 'types' | 'all' | 'specific-lessons';
  chapters: number[];
  types: string[];
  lessonIds: string[];
  rateLimit: {
    delayMs: number;
    enableRateLimit: boolean;
  };
  output: {
    saveJson: boolean;
    saveMarkdown: boolean;
  };
  filters: {
    skipQuizzes: boolean;
    skipAncChapters: boolean;
    allowedTypes: string[];
  };
  media: {
    skipMedia: boolean;        // Skip all media processing (download + transcription)
    skipTranscribe: boolean;   // Download but don't transcribe
    skipScreenshots: boolean;  // Skip thumbnail/screenshot extraction
    resumeMode?: boolean;      // Resume incomplete downloads/transcriptions (skip already completed)
    verifyDiskFiles?: boolean; // Verify files exist on disk before skipping (for resume mode)
  };
  formatting: {
    skipFormatting: boolean;      // Skip AI formatting/summarization
    formattingOnlyMode?: boolean; // Skip extraction if fullContent exists (only apply formatting)
    model: 'gpt-4.1' | 'gpt-5';    // AI model for formatting
  };
  lessonCompletion?: {
    autoValidate: boolean;     // Automatically mark all lessons as complete after extraction
    waitAfterConfirm?: number; // Wait time after confirming completion (default: 2000ms)
  };
  proxy?: ProxyConfig;         // Optional proxy for YouTube access (residential IP bypass)
  antiDetection?: AntiDetectionConfig;  // Optional anti-detection measures for YouTube scraping
  dryRun?: boolean;            // Estimation mode: count media, estimate costs, no downloads/transcription
}

const DEFAULT_CONFIG: Partial<ExtractionConfig> = {
  // formationUrl is REQUIRED - no default (must be in extraction-config.json)
  mode: 'all',
  chapters: [],
  types: [],
  lessonIds: [],
  rateLimit: {
    delayMs: 2000,
    enableRateLimit: true,
  },
  output: {
    saveJson: true,
    saveMarkdown: true,
  },
  filters: {
    skipQuizzes: true,
    skipAncChapters: true,
    allowedTypes: ['📚', '✍️', '📔', '🧠', '🔥'],
  },
  media: {
    skipMedia: false,
    skipTranscribe: false,
    skipScreenshots: false,
    resumeMode: true,        // Default: resume incomplete downloads
    verifyDiskFiles: false,  // Default: trust JSON flags (opt-in for disk verification)
  },
  formatting: {
    skipFormatting: false,   // Default: enable AI formatting
    model: 'gpt-4.1',         // Default: gpt-4.1 (bon équilibre)
  },
  lessonCompletion: {
    autoValidate: true,      // Default: enable auto-validation
    waitAfterConfirm: 2000,  // Default: 2 seconds wait after confirmation
  },
  antiDetection: {
    enableRandomJitter: true,
    exponentialBackoff: true,
    circuitBreakerThreshold: 5,
    customHeaders: {
      acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8',
    },
  },
  dryRun: false,
};

/**
 * Load extraction configuration from file
 */
export function loadConfig(configPath: string = 'extraction-config.json'): ExtractionConfig {
  try {
    const fullPath = resolve(process.cwd(), configPath);
    logger.info({ configPath: fullPath }, 'Loading extraction config');

    const fileContent = readFileSync(fullPath, 'utf-8');
    const config = JSON.parse(fileContent) as ExtractionConfig;

    // Normalize formationUrl: remove trailing slash to prevent double slashes in URL construction
    if (config.formationUrl) {
      config.formationUrl = config.formationUrl.replace(/\/$/, '');
    }

    // Validate and merge with defaults
    const mergedConfig = { ...DEFAULT_CONFIG, ...config } as ExtractionConfig;

    // Apply optional environment-variable overrides (env takes precedence over
    // the config file — handy for one-off runs without editing the JSON).
    applyEnvOverrides(mergedConfig);

    validateConfig(mergedConfig);

    logger.info({ config: mergedConfig }, '✅ Config loaded and validated');
    return mergedConfig;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      logger.error({ configPath }, '❌ Config file not found - extraction-config.json is REQUIRED');
      throw new Error(`Config file not found: ${configPath}. Please create extraction-config.json with formationUrl and other settings.`);
    }
    throw error;
  }
}

/**
 * Apply environment-variable overrides on top of the loaded config.
 *
 * Only options that map cleanly onto an ExtractionConfig field are wired here;
 * finer-grained behavior stays in extraction-config.json (single source of
 * truth). Objects are copied rather than mutated so shared DEFAULT_CONFIG
 * sub-objects are never altered.
 *
 * Recognized: DELAY_BETWEEN_PAGES_MS, DOWNLOAD_MEDIA, TRANSCRIBE_MEDIA.
 * (PLAYWRIGHT_HEADLESS and LOG_LEVEL are handled by the MCP server / logger.)
 */
export function applyEnvOverrides(config: ExtractionConfig): void {
  const { DELAY_BETWEEN_PAGES_MS, DOWNLOAD_MEDIA, TRANSCRIBE_MEDIA } = process.env;

  if (DELAY_BETWEEN_PAGES_MS !== undefined) {
    const delayMs = Number(DELAY_BETWEEN_PAGES_MS);
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(
        `Invalid DELAY_BETWEEN_PAGES_MS: "${DELAY_BETWEEN_PAGES_MS}" (expected a non-negative number)`
      );
    }
    config.rateLimit = { ...config.rateLimit, delayMs };
    logger.info({ delayMs }, 'Env override: rateLimit.delayMs (from DELAY_BETWEEN_PAGES_MS)');
  }

  // DOWNLOAD_MEDIA / TRANSCRIBE_MEDIA are opt-out toggles: "false" disables the step.
  if (DOWNLOAD_MEDIA !== undefined) {
    const skipMedia = DOWNLOAD_MEDIA === 'false';
    config.media = { ...config.media, skipMedia };
    logger.info({ skipMedia }, 'Env override: media.skipMedia (from DOWNLOAD_MEDIA)');
  }

  if (TRANSCRIBE_MEDIA !== undefined) {
    const skipTranscribe = TRANSCRIBE_MEDIA === 'false';
    config.media = { ...config.media, skipTranscribe };
    logger.info({ skipTranscribe }, 'Env override: media.skipTranscribe (from TRANSCRIBE_MEDIA)');
  }
}

/**
 * Validate configuration
 */
function validateConfig(config: ExtractionConfig): void {
  // Validate formation URL
  if (!config.formationUrl || typeof config.formationUrl !== 'string' || config.formationUrl.trim().length === 0) {
    throw new Error('formationUrl is required and must be a non-empty string');
  }

  const validModes = ['chapters', 'types', 'all', 'specific-lessons'];
  if (!validModes.includes(config.mode)) {
    throw new Error(`Invalid mode: ${config.mode}. Must be one of: ${validModes.join(', ')}`);
  }

  if (config.mode === 'chapters' && config.chapters.length === 0) {
    throw new Error('Mode "chapters" requires at least one chapter number');
  }

  if (config.mode === 'types' && config.types.length === 0) {
    throw new Error('Mode "types" requires at least one type emoji');
  }

  if (config.mode === 'specific-lessons' && config.lessonIds.length === 0) {
    throw new Error('Mode "specific-lessons" requires at least one lesson ID');
  }

  if (config.rateLimit.delayMs < 0) {
    throw new Error('rateLimit.delayMs must be >= 0');
  }

  // Validate mutually exclusive options
  if (config.dryRun && config.media.resumeMode) {
    throw new Error('Cannot use resumeMode with dryRun (mutually exclusive)');
  }

  // Validate emoji types
  const validEmojis = ['📚', '✍️', '📔', '🧠', '🔥'];
  for (const type of config.types) {
    if (!validEmojis.includes(type)) {
      logger.warn({ type }, `⚠️ Unknown emoji type: ${type}`);
    }
  }
}

/**
 * Get a user-friendly description of the current config
 */
export function describeConfig(config: ExtractionConfig): string {
  switch (config.mode) {
    case 'chapters':
      return `Extracting chapters: ${config.chapters.join(', ')}`;
    case 'types':
      return `Extracting types: ${config.types.join(', ')}`;
    case 'specific-lessons':
      return `Extracting specific lessons: ${config.lessonIds.length} lesson(s)`;
    case 'all':
      return 'Extracting ALL lessons from the course';
    default:
      return 'Unknown extraction mode';
  }
}
