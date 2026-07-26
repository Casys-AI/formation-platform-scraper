/**
 * Constants for the Formation Platform Scraper
 * Centralized configuration values and magic numbers
 */

/**
 * Timeout values (in milliseconds)
 */
export const TIMEOUTS = {
  /** Standard page load timeout */
  PAGE_LOAD: 5000,
  /** Wait for dynamic content to load */
  DYNAMIC_CONTENT: 2000,
  /** Wait for new browser tab to open */
  NEW_TAB_OPEN: 10000,
  /** Maximum time for authentication flow */
  AUTHENTICATION: 30000,
  /** Default timeout for evaluate() execution */
  EVALUATE_DEFAULT: 30000,
} as const;

/**
 * Retry configuration
 */
export const RETRY_CONFIG = {
  /** Number of retry attempts */
  ATTEMPTS: 2,
  /** Initial delay between retries (ms) */
  DELAY: 3000,
  /** Backoff multiplier for exponential backoff */
  BACKOFF: 2,
} as const;

/**
 * Validation constants
 */
export const VALIDATION = {
  /** Expected total number of lessons in the course */
  EXPECTED_LESSONS: 259,
  /** Tolerance for lesson count validation (±) */
  LESSON_COUNT_TOLERANCE: 10,
} as const;

/**
 * Lesson type emojis
 */
export const LESSON_EMOJIS = {
  /** Video lesson */
  VIDEO: '📚',
  /** Exercise */
  EXERCISE: '✍️',
  /** Quiz/QCM */
  QUIZ: '🧠',
  /** Important content */
  IMPORTANT: '🔥',
  /** Documentation */
  DOCUMENTATION: '📔',
} as const;

/**
 * Regex pattern for extracting lesson emojis
 * Uses explicit alternation to avoid Unicode surrogate pair issues
 */
export const EMOJI_PATTERN = /(📚|✍️|🧠|🔥|📔)/;

/**
 * Expected URL format for lesson pages
 */
export const LESSON_URL_PATTERN = /^https?:\/\/[^/]+\/.*\/elements\/\d+$/;

/**
 * Media processing constants (Story 6)
 */
export const MEDIA = {
  /** Maximum file size for downloads (in bytes) - 2 hours @ 128kbps = ~112MB */
  MAX_AUDIO_SIZE_BYTES: 120 * 1024 * 1024, // 120MB with buffer
  /** Maximum file size for videos (in bytes) - 2 hours @ 1Mbps = ~900MB */
  MAX_VIDEO_SIZE_BYTES: 1024 * 1024 * 1024, // 1GB
  /** Maximum file size for Whisper API (MB) - Reduced to 20MB to avoid network timeouts */
  WHISPER_MAX_SIZE_MB: 20,
  /** Target chunk size for audio splitting (MB) - stay well below 20MB limit */
  WHISPER_CHUNK_SIZE_MB: 18,
  /** Timeout for media downloads (ms) - 5 minutes */
  DOWNLOAD_TIMEOUT: 300000,
  /** Timeout for thumbnail extraction (ms) - 2 minutes (increased for HD videos) */
  THUMBNAIL_TIMEOUT: 120000,
  /** Timeout for transcription (ms) - 15 minutes (increased for long videos) */
  TRANSCRIPTION_TIMEOUT: 900000,
  /** Video timestamp ratio for thumbnail extraction (30% into video) */
  THUMBNAIL_TIMESTAMP_RATIO: 0.3,
  /** Number of retry attempts for downloads */
  DOWNLOAD_RETRY_ATTEMPTS: 1,
  /** Delay between retries (ms) */
  DOWNLOAD_RETRY_DELAY: 2000,
} as const;
