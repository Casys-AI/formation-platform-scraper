/**
 * Media processing for lesson content
 * Handles download, screenshot extraction, and Whisper transcription
 */

import { mkdir, readFile, stat, readdir, rename, unlink } from 'fs/promises';
import { resolve } from 'path';
import { execa } from 'execa';
import OpenAI from 'openai';
import { createLogger, sleep } from './utils.js';
import { sanitizeLessonId } from './sanitizer.js';
import { MEDIA } from './constants.js';
import type { CompleteLesson, MediaContent, MediaStats, ProxyConfig, AntiDetectionConfig } from './types.js';

const logger = createLogger('media-handler');

// Initialize OpenAI client
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required for transcription');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Circuit breaker for YouTube download failures
 * Tracks consecutive errors and stops scraping if threshold exceeded
 */
class YouTubeCircuitBreaker {
  private consecutiveErrors = 0;
  private readonly threshold: number;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  recordSuccess(): void {
    this.consecutiveErrors = 0;
  }

  recordError(): void {
    this.consecutiveErrors++;
    logger.warn(
      { consecutiveErrors: this.consecutiveErrors, threshold: this.threshold },
      `⚠️ YouTube download error (${this.consecutiveErrors}/${this.threshold})`
    );

    if (this.consecutiveErrors >= this.threshold) {
      throw new Error(
        `Circuit breaker triggered: ${this.consecutiveErrors} consecutive YouTube errors. ` +
        `Stopping to avoid ban. Check proxy, cookies, and wait before retrying.`
      );
    }
  }

  getStatus(): { consecutiveErrors: number; threshold: number } {
    return {
      consecutiveErrors: this.consecutiveErrors,
      threshold: this.threshold,
    };
  }
}

// Global circuit breaker instance (shared across all downloads)
let youtubeCircuitBreaker: YouTubeCircuitBreaker | null = null;

/**
 * Get or create circuit breaker with given threshold
 */
function getCircuitBreaker(threshold: number): YouTubeCircuitBreaker | null {
  if (threshold <= 0) {
    return null; // Circuit breaker disabled
  }

  if (!youtubeCircuitBreaker || youtubeCircuitBreaker.getStatus().threshold !== threshold) {
    youtubeCircuitBreaker = new YouTubeCircuitBreaker(threshold);
  }

  return youtubeCircuitBreaker;
}

/**
 * Add random jitter to a delay (±40% variation)
 * Prevents predictable request patterns that trigger bot detection
 */
function addJitter(delayMs: number, enabled: boolean): number {
  if (!enabled) {
    return delayMs;
  }

  // Add ±40% random variation
  const jitterRange = 0.4;
  const minDelay = delayMs * (1 - jitterRange);
  const maxDelay = delayMs * (1 + jitterRange);
  const jitteredDelay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));

  logger.debug(
    { originalMs: delayMs, jitteredMs: jitteredDelay },
    '🎲 Applied random jitter to delay'
  );

  return jitteredDelay;
}

export interface MediaProcessingOptions {
  skipTranscribe: boolean;
  skipScreenshots: boolean;
  dryRun?: boolean;        // If true, only estimate costs without downloads/transcription
  stats?: MediaStats;      // Optional stats object to track metrics
  proxy?: ProxyConfig;     // Optional proxy for YouTube downloads (residential IP bypass)
  antiDetection?: AntiDetectionConfig;  // Optional anti-detection measures
  resumeMode?: boolean;    // Resume incomplete downloads/transcriptions (skip already completed)
  verifyDiskFiles?: boolean; // Verify files exist on disk before skipping (for resume mode)
}

/**
 * Create empty MediaStats object
 */
export function createMediaStats(): MediaStats {
  return {
    totalMedia: 0,
    downloaded: 0,
    transcribed: 0,
    totalMinutes: 0,
    estimatedCost: 0,
    errors: 0,
    skipped: 0,
    resumedSkipped: 0,
    byType: {
      youtube: 0,
      vimeo: 0,
      audio_mp3: 0,
      video_s3: 0,
    },
  };
}

/**
 * Estimate media duration in minutes (for dry-run mode)
 * These are conservative estimates based on typical lesson patterns
 */
function estimateMediaDuration(media: MediaContent): number {
  // Default estimates per media type (in minutes)
  const estimates = {
    youtube: 15,      // Typical YouTube lesson: 10-20 minutes
    vimeo: 12,        // Vimeo private videos: 8-15 minutes
    audio_mp3: 10,    // Audio lessons: 5-15 minutes
    video_s3: 20,     // S3 video lessons: 15-25 minutes (longer tutorials)
  };

  return estimates[media.type] || 10; // Default to 10 minutes if unknown
}

/**
 * Update MediaStats with processing results
 */
function updateMediaStats(
  stats: MediaStats,
  media: MediaContent,
  downloaded: boolean,
  transcribed: boolean,
  error: boolean,
  skipped: boolean,
  durationMinutes?: number
): void {
  stats.totalMedia++;
  stats.byType[media.type]++;

  if (error) {
    stats.errors++;
    return;
  }

  if (skipped) {
    stats.skipped++;
    return;
  }

  if (downloaded) {
    stats.downloaded++;
  }

  if (transcribed) {
    stats.transcribed++;
    const duration = durationMinutes || estimateMediaDuration(media);
    stats.totalMinutes += duration;
    stats.estimatedCost += duration * 0.006; // Whisper API: $0.006/minute
  }
}

/**
 * Check file size before download
 * Returns true if file is within acceptable size limits
 */
async function checkFileSize(url: string, maxSizeBytes: number): Promise<boolean> {
  try {
    const { stdout } = await execa('curl', ['-sI', url], {
      timeout: 10000 // 10s timeout for HEAD request
    });

    const sizeMatch = stdout.match(/content-length:\s*(\d+)/i);
    if (!sizeMatch) {
      logger.warn({ url }, '⚠️ Could not determine file size, proceeding anyway');
      return true;
    }

    const sizeBytes = parseInt(sizeMatch[1]);
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
    const maxSizeMB = (maxSizeBytes / (1024 * 1024)).toFixed(2);

    if (sizeBytes > maxSizeBytes) {
      logger.error(
        { url, sizeMB, maxSizeMB },
        `❌ File too large (${sizeMB}MB > ${maxSizeMB}MB), skipping`
      );
      return false;
    }

    logger.debug({ url, sizeMB }, `✅ File size OK (${sizeMB}MB)`);
    return true;
  } catch (error) {
    logger.warn({ error, url }, '⚠️ File size check failed, proceeding anyway');
    return true; // Fail open: proceed if can't check
  }
}

/**
 * Retry a function with exponential backoff and jitter
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  options?: {
    maxAttempts?: number;
    exponentialBackoff?: boolean;
    enableJitter?: boolean;
  }
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? MEDIA.DOWNLOAD_RETRY_ATTEMPTS;
  const useExponentialBackoff = options?.exponentialBackoff ?? false;
  const useJitter = options?.enableJitter ?? false;

  let lastError: Error | unknown;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts) {
        // Calculate delay: exponential backoff or fixed
        const baseDelay = useExponentialBackoff
          ? MEDIA.DOWNLOAD_RETRY_DELAY * Math.pow(2, attempt)
          : MEDIA.DOWNLOAD_RETRY_DELAY;

        // Apply jitter if enabled
        const delay = addJitter(baseDelay, useJitter);

        logger.warn(
          {
            context,
            attempt: attempt + 1,
            maxAttempts: maxAttempts + 1,
            delayMs: delay,
            exponentialBackoff: useExponentialBackoff,
          },
          `⚠️ Attempt ${attempt + 1} failed, retrying in ${delay}ms...`
        );

        await sleep(delay);
      }
    }
  }

  logger.warn({ context, error: lastError }, `⚠️ All ${maxAttempts + 1} attempts failed (retry system will handle)`);
  throw lastError;
}

/**
 * Deduplicate media - Remove MP3 audio if a video exists
 * Common case: MP3 is just the audio track from the video
 *
 * Benefits:
 * - Saves transcription costs (no double transcription)
 * - Saves download time
 * - Keeps video which has thumbnail for preview
 */
export function deduplicateMedia(media: MediaContent[]): MediaContent[] {
  // DEBUG: Log input media
  logger.info(
    {
      inputCount: media.length,
      urls: media.map(m => ({ type: m.type, url: m.url?.split('/').pop()?.substring(0, 20) }))
    },
    '🔍 [DEBUG] deduplicateMedia() - INPUT'
  );

  const hasVideo = media.some(m =>
    m.type === 'youtube' || m.type === 'vimeo' || m.type === 'video_s3'
  );

  // Step 1: Remove redundant MP3 if video exists
  let filtered = hasVideo ? media.filter(m => m.type !== 'audio_mp3') : media;

  const mp3Removed = media.length - filtered.length;
  if (mp3Removed > 0) {
    logger.info(
      {
        original: media.length,
        deduplicated: filtered.length,
        skipped: mp3Removed
      },
      '🔍 Skipping redundant MP3 (video exists)'
    );
  }

  // Step 2: Deduplicate by URL (same URL = same media, even if duplicated in DOM)
  const uniqueByUrl = new Map<string, MediaContent>();
  for (const item of filtered) {
    const key = item.url || item.mediaId || JSON.stringify(item);
    if (!uniqueByUrl.has(key)) {
      uniqueByUrl.set(key, item);
    } else {
      logger.info(
        { url: item.url, type: item.type },
        '🔍 [DEBUG] DUPLICATE DETECTED - Skipping duplicate media URL'
      );
    }
  }

  const urlDeduped = Array.from(uniqueByUrl.values());
  const urlRemoved = filtered.length - urlDeduped.length;

  if (urlRemoved > 0) {
    logger.info(
      {
        beforeUrlDedup: filtered.length,
        afterUrlDedup: urlDeduped.length,
        duplicatesRemoved: urlRemoved
      },
      '🔍 Removed duplicate media URLs'
    );
  }

  // DEBUG: Log output media
  logger.info(
    {
      outputCount: urlDeduped.length,
      urls: urlDeduped.map(m => ({ type: m.type, url: m.url?.split('/').pop()?.substring(0, 20) }))
    },
    '🔍 [DEBUG] deduplicateMedia() - OUTPUT'
  );

  return urlDeduped;
}

/**
 * Check if a file exists on disk
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine if a media item needs processing (for resume mode)
 * Returns true if media needs download or transcription
 */
async function shouldProcessMedia(
  media: MediaContent,
  options: MediaProcessingOptions
): Promise<{ needsProcessing: boolean; reason?: string }> {
  // Check if download is needed
  if (!media.downloaded) {
    return { needsProcessing: true, reason: 'not downloaded' };
  }

  // Verify file exists on disk if requested
  if (options.verifyDiskFiles && media.localPath) {
    const exists = await fileExists(media.localPath);
    if (!exists) {
      logger.warn(
        { localPath: media.localPath, mediaId: media.mediaId },
        '⚠️ Media marked as downloaded but file missing - will re-download'
      );
      return { needsProcessing: true, reason: 'file missing on disk' };
    }
  }

  // Check if transcription is needed
  if (!options.skipTranscribe) {
    const isTranscribed = media.transcribed === true || !!media.transcription;
    if (!isTranscribed) {
      return { needsProcessing: true, reason: 'not transcribed' };
    }
  }

  // Check if screenshot is needed (for media types that support screenshots)
  if (!options.skipScreenshots) {
    const supportsScreenshot = media.type === 'youtube' || media.type === 'vimeo' || media.type === 'video_s3';
    if (supportsScreenshot && (!media.screenshots || media.screenshots.length === 0)) {
      return { needsProcessing: true, reason: 'missing screenshot' };
    }
  }

  // All checks passed - media is complete
  return { needsProcessing: false };
}

/**
 * Filter out already-completed media (for resume mode)
 * Returns only media that needs processing
 */
async function filterIncompleteMedia(
  mediaList: MediaContent[],
  lessonId: string,
  options: MediaProcessingOptions
): Promise<MediaContent[]> {
  const incomplete: MediaContent[] = [];

  for (const media of mediaList) {
    const { needsProcessing, reason } = await shouldProcessMedia(media, options);

    if (needsProcessing) {
      logger.debug(
        { lessonId, mediaId: media.mediaId, reason },
        '🔄 Media needs processing'
      );
      incomplete.push(media);
    } else {
      logger.debug(
        { lessonId, mediaId: media.mediaId },
        '⏩ Skipping completed media'
      );
    }
  }

  // Log summary
  const skipped = mediaList.length - incomplete.length;
  if (skipped > 0) {
    logger.info(
      {
        lessonId,
        total: mediaList.length,
        incomplete: incomplete.length,
        skipped,
      },
      `🔄 Resume mode: Processing ${incomplete.length} incomplete, skipping ${skipped} completed`
    );
  }

  return incomplete;
}

/**
 * Download YouTube audio using yt-dlp with anti-detection measures
 */
async function downloadYouTubeAudio(
  media: MediaContent,
  outputDir: string,
  lessonId: string,
  proxy?: ProxyConfig,
  antiDetection?: AntiDetectionConfig
): Promise<string> {
  // Sanitize lesson ID for filesystem
  const safeId = sanitizeLessonId(lessonId);
  const outputPath = resolve(outputDir, `lesson-${safeId}-youtube-${media.mediaId}.mp3`);

  // Get circuit breaker if enabled
  const circuitBreaker = antiDetection?.circuitBreakerThreshold
    ? getCircuitBreaker(antiDetection.circuitBreakerThreshold)
    : null;

  // DEBUG: Log what we received
  logger.debug(
    {
      mediaId: media.mediaId,
      hasProxy: !!proxy,
      proxyEnabled: proxy?.enabled,
      proxyUrl: proxy?.url,
      hasAntiDetection: !!antiDetection,
    },
    '🔍 downloadYouTubeAudio called with options'
  );

  return withRetry(
    async () => {
      try {
        // Check file size before download
        const sizeOk = await checkFileSize(media.url, MEDIA.MAX_AUDIO_SIZE_BYTES);
        if (!sizeOk) {
          throw new Error(`File too large: ${media.url}`);
        }

        const args = [
          '--extract-audio',
          '--audio-format', 'mp3',
          '--output', outputPath,
        ];

        // Add proxy for YouTube downloads to bypass datacenter IP bot detection
        if (proxy?.enabled && proxy.url) {
          args.push('--proxy', proxy.url);
          logger.info({ mediaId: media.mediaId, proxy: proxy.url }, '🌐 Using proxy for YouTube download');
        }

        // Add cookies from browser (helps bypass bot detection)
        if (antiDetection?.cookiesFrom) {
          args.push('--cookies-from-browser', antiDetection.cookiesFrom);
          logger.info(
            { mediaId: media.mediaId, browser: antiDetection.cookiesFrom },
            '🍪 Using cookies from browser'
          );
        }

        // Add custom User-Agent
        if (antiDetection?.customHeaders?.userAgent) {
          args.push('--user-agent', antiDetection.customHeaders.userAgent);
        }

        // Add Accept-Language header
        if (antiDetection?.customHeaders?.acceptLanguage) {
          args.push('--add-header', `Accept-Language:${antiDetection.customHeaders.acceptLanguage}`);
        }

        // Add Referer header
        if (antiDetection?.customHeaders?.referer) {
          args.push('--add-header', `Referer:${antiDetection.customHeaders.referer}`);
        }

        // Add video URL as last argument
        args.push(media.url);

        await execa('yt-dlp', args, {
          timeout: MEDIA.DOWNLOAD_TIMEOUT,
        });

        logger.info({ mediaId: media.mediaId, path: outputPath }, '✅ YouTube audio downloaded');

        // Record success in circuit breaker
        if (circuitBreaker) {
          circuitBreaker.recordSuccess();
        }

        return outputPath;
      } catch (error) {
        // Record error in circuit breaker (may throw if threshold exceeded)
        if (circuitBreaker) {
          circuitBreaker.recordError();
        }
        throw error;
      }
    },
    `YouTube download ${media.mediaId}`,
    {
      exponentialBackoff: antiDetection?.exponentialBackoff ?? false,
      enableJitter: antiDetection?.enableRandomJitter ?? false,
    }
  );
}

/**
 * Download Vimeo audio using yt-dlp
 */
async function downloadVimeoAudio(
  media: MediaContent,
  outputDir: string,
  lessonId: string
): Promise<string> {
  // Sanitize lesson ID for filesystem
  const safeId = sanitizeLessonId(lessonId);
  const outputPath = resolve(outputDir, `lesson-${safeId}-vimeo-${media.mediaId}.mp3`);

  return withRetry(async () => {
    // Check file size before download
    const sizeOk = await checkFileSize(media.url, MEDIA.MAX_AUDIO_SIZE_BYTES);
    if (!sizeOk) {
      throw new Error(`File too large: ${media.url}`);
    }

    await execa('yt-dlp', [
      '--extract-audio',
      '--audio-format', 'mp3',
      '--output', outputPath,
      media.url
    ], {
      timeout: MEDIA.DOWNLOAD_TIMEOUT
    });

    logger.info({ mediaId: media.mediaId, path: outputPath }, '✅ Vimeo audio downloaded');
    return outputPath;
  }, `Vimeo download ${media.mediaId}`);
}

/**
 * Download S3 media (video or audio) using curl
 */
async function downloadS3Media(
  media: MediaContent,
  outputDir: string,
  lessonId: string
): Promise<string> {
  // Sanitize lesson ID for filesystem
  const safeId = sanitizeLessonId(lessonId);
  const extension = media.type === 'audio_mp3' ? 'mp3' : 'mp4';

  // Generate unique identifier from URL to avoid collisions when multiple S3 media in same lesson
  // Extract filename hash from URL (e.g., "9fd2e57f471d2d3f9c927a1fea8266d4.mp4" → "9fd2e57f")
  const urlHash = media.url.split('/').pop()?.split('.')[0]?.substring(0, 8) || media.mediaId || 'unknown';
  const outputPath = resolve(outputDir, `lesson-${safeId}-${media.type}-${urlHash}.${extension}`);

  return withRetry(async () => {
    // Check file size before download
    const maxSize = media.type === 'audio_mp3'
      ? MEDIA.MAX_AUDIO_SIZE_BYTES
      : MEDIA.MAX_VIDEO_SIZE_BYTES;

    const sizeOk = await checkFileSize(media.url, maxSize);
    if (!sizeOk) {
      throw new Error(`File too large: ${media.url}`);
    }

    await execa('curl', [
      '-L',  // Follow redirects
      '-o', outputPath,
      media.url
    ], {
      timeout: MEDIA.DOWNLOAD_TIMEOUT
    });

    logger.info({ url: media.url, path: outputPath }, '✅ S3 media downloaded');
    return outputPath;
  }, `S3 download ${media.type}`);
}

/**
 * Extract YouTube thumbnail using free thumbnail API
 */
async function extractYouTubeThumbnail(
  media: MediaContent,
  outputDir: string,
  lessonId: string
): Promise<string> {
  // Sanitize lesson ID for filesystem
  const safeId = sanitizeLessonId(lessonId);
  const thumbnailUrl = `https://img.youtube.com/vi/${media.mediaId}/maxresdefault.jpg`;
  const fallbackUrl = `https://img.youtube.com/vi/${media.mediaId}/hqdefault.jpg`;
  const outputPath = resolve(outputDir, `lesson-${safeId}-youtube-thumb.jpg`);

  try {
    // Try maxresdefault (1920x1080) first
    await execa('curl', ['-L', '-o', outputPath, thumbnailUrl], {
      timeout: MEDIA.THUMBNAIL_TIMEOUT
    });

    // Check if file is valid (not 404 placeholder)
    const stats = await stat(outputPath);
    if (stats.size < 1000) {
      // Fallback to hqdefault (480x360)
      await execa('curl', ['-L', '-o', outputPath, fallbackUrl], {
        timeout: MEDIA.THUMBNAIL_TIMEOUT
      });
    }

    logger.info({ mediaId: media.mediaId, path: outputPath }, '✅ YouTube thumbnail downloaded');
    return outputPath;
  } catch (error) {
    logger.warn({ error }, '⚠️ YouTube thumbnail download failed');
    return '';
  }
}

/**
 * Extract Vimeo thumbnail using yt-dlp (works with private videos)
 */
async function extractVimeoThumbnail(
  media: MediaContent,
  outputDir: string,
  lessonId: string
): Promise<string> {
  try {
    // Sanitize lesson ID for filesystem
    const safeId = sanitizeLessonId(lessonId);
    const outputPath = resolve(outputDir, `lesson-${safeId}-vimeo-thumb.jpg`);

    // Use yt-dlp to extract thumbnail (works with private/protected videos)
    // --write-thumbnail: Download thumbnail
    // --skip-download: Don't download the video
    // --convert-thumbnails jpg: Convert to JPG format
    await execa('yt-dlp', [
      '--write-thumbnail',
      '--skip-download',
      '--convert-thumbnails', 'jpg',
      '--output', outputPath.replace('.jpg', ''),  // yt-dlp will add extension
      media.url
    ], {
      timeout: MEDIA.THUMBNAIL_TIMEOUT
    });

    // yt-dlp creates files like "output.jpg", find the actual file using fs
    const files = await readdir(outputDir);
    const thumbnailFile = files.find(f =>
      f.includes(`lesson-${safeId}-vimeo-thumb`) && f.endsWith('.jpg')
    );

    if (thumbnailFile && thumbnailFile !== `lesson-${safeId}-vimeo-thumb.jpg`) {
      // Rename to expected name
      await rename(
        resolve(outputDir, thumbnailFile),
        outputPath
      );
    }

    logger.info({ mediaId: media.mediaId, path: outputPath }, '✅ Vimeo thumbnail downloaded');
    return outputPath;
  } catch (error) {
    logger.warn({ error, mediaId: media.mediaId }, '⚠️ Vimeo thumbnail extraction failed');
    return '';
  }
}

/**
 * Extract S3 video thumbnail using ffmpeg
 */
async function extractS3VideoThumbnail(
  videoPath: string,
  outputDir: string,
  lessonId: string
): Promise<string> {
  try {
    // Sanitize lesson ID for filesystem
    const safeId = sanitizeLessonId(lessonId);

    // Get video duration first
    const { stdout } = await execa('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ], {
      timeout: MEDIA.THUMBNAIL_TIMEOUT
    });

    const duration = parseFloat(stdout);
    const timestamp = Math.floor(duration * MEDIA.THUMBNAIL_TIMESTAMP_RATIO);

    // Extract hash from video path to match the video file naming
    // videoPath format: "lesson-1027365-video_s3-9fd2e57f.mp4" → extract "9fd2e57f"
    const videoHash = videoPath.split('-').pop()?.split('.')[0] || 'unknown';
    const outputPath = resolve(outputDir, `lesson-${safeId}-video_s3-${videoHash}-thumb.jpg`);

    // Extract frame at timestamp
    await execa('ffmpeg', [
      '-y',  // Force overwrite without prompting
      '-i', videoPath,
      '-ss', timestamp.toString(),
      '-vframes', '1',
      '-q:v', '2',  // High quality JPEG
      outputPath
    ], {
      timeout: MEDIA.THUMBNAIL_TIMEOUT
    });

    logger.info({ timestamp, path: outputPath }, '✅ S3 video thumbnail extracted');
    return outputPath;
  } catch (error) {
    logger.warn({ error }, '⚠️ S3 video thumbnail extraction failed');
    return '';
  }
}

/**
 * Convert MP4 video to MP3 audio for Whisper transcription
 * Always convert to reduce file size (typically 70-80% reduction)
 * and ensure compatibility with Whisper API
 *
 * @param mp4Path - Path to MP4 file
 * @returns Path to converted MP3 file
 */
async function convertMp4ToMp3(mp4Path: string): Promise<string> {
  const mp3Path = mp4Path.replace(/\.mp4$/, '.mp3');

  try {
    logger.info({ mp4Path, mp3Path }, '🔄 Converting MP4 → MP3 for Whisper...');

    await execa('ffmpeg', [
      '-y',                    // Force overwrite
      '-i', mp4Path,           // Input MP4
      '-vn',                   // No video (audio only)
      '-acodec', 'libmp3lame', // MP3 codec
      '-b:a', '128k',          // 128kbps bitrate
      mp3Path
    ], {
      timeout: MEDIA.DOWNLOAD_TIMEOUT  // 5 min timeout
    });

    logger.info({ mp4Path, mp3Path }, '✅ Converted MP4 → MP3 for transcription');

    // NOTE: Do NOT delete MP4 here! It will be deleted after transcription completes (including retries)
    // This prevents race conditions where a transcription retry fails because the MP4 is gone

    return mp3Path;
  } catch (error) {
    logger.warn({ error, mp4Path }, '⚠️ MP4 → MP3 conversion failed (possibly corrupted download)');

    // Delete corrupted MP4 to force re-download on retry
    try {
      await unlink(mp4Path);
      logger.info({ mp4Path }, '🗑️ Deleted corrupted MP4 to allow retry with fresh download');
    } catch (unlinkError) {
      logger.debug({ error: unlinkError, mp4Path }, '⚠️ Failed to delete corrupted MP4');
    }

    throw error;
  }
}

/**
 * Split audio file into chunks using ffmpeg (for files > 25MB)
 * Returns array of chunk file paths
 */
async function splitAudioIntoChunks(
  audioPath: string,
  targetSizeMB: number
): Promise<string[]> {
  const stats = await stat(audioPath);
  const fileSizeMB = stats.size / (1024 * 1024);

  // Calculate chunk duration based on file size and target chunk size
  // Estimate: if file is 29MB and we want 23MB chunks, we need ~1.26 chunks
  const numChunks = Math.ceil(fileSizeMB / targetSizeMB);

  logger.info(
    { audioPath, fileSizeMB: fileSizeMB.toFixed(2), targetSizeMB, numChunks },
    `✂️ Splitting audio into ${numChunks} chunks`
  );

  // Get audio duration using ffprobe
  const { stdout } = await execa('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath
  ]);

  const totalDurationSeconds = parseFloat(stdout.trim());
  const chunkDurationSeconds = Math.ceil(totalDurationSeconds / numChunks);

  logger.debug(
    { totalDurationSeconds, chunkDurationSeconds },
    'Calculated chunk duration'
  );

  // Create chunks using ffmpeg
  const chunkPaths: string[] = [];
  const baseDir = audioPath.substring(0, audioPath.lastIndexOf('/'));
  const baseName = audioPath.substring(audioPath.lastIndexOf('/') + 1, audioPath.lastIndexOf('.'));

  // Add unique ID to prevent collisions when multiple processes run in parallel
  const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  for (let i = 0; i < numChunks; i++) {
    const startTime = i * chunkDurationSeconds;
    const chunkPath = `${baseDir}/${baseName}_${uniqueId}_chunk${i + 1}.mp3`;

    await execa('ffmpeg', [
      '-y',
      '-i', audioPath,
      '-ss', startTime.toString(),
      '-t', chunkDurationSeconds.toString(),
      '-acodec', 'copy',
      chunkPath
    ]);

    // Verify chunk was created
    const chunkStats = await stat(chunkPath);
    const chunkSizeMB = chunkStats.size / (1024 * 1024);
    logger.debug(
      { chunkPath, chunkSizeMB: chunkSizeMB.toFixed(2) },
      `✅ Created chunk ${i + 1}/${numChunks}`
    );

    chunkPaths.push(chunkPath);
  }

  return chunkPaths;
}

/**
 * Clean up temporary chunk files
 */
async function cleanupChunks(chunkPaths: string[]): Promise<void> {
  for (const chunkPath of chunkPaths) {
    try {
      await unlink(chunkPath);
      logger.debug({ chunkPath }, '🗑️ Cleaned up chunk file');
    } catch (error) {
      logger.warn({ chunkPath, error }, '⚠️ Failed to clean up chunk file');
    }
  }
}

/**
 * Transcribe audio using OpenAI Whisper API
 * Automatically splits files > 25MB into chunks
 */
async function transcribeAudio(
  audioPath: string
): Promise<{
  text: string;
  language: string;
  confidence?: number;
}> {
  try {
    logger.info({ audioPath }, '🎤 Transcribing audio with Whisper...');

    // Check file size (should already be MP3 from processLessonMedia)
    const stats = await stat(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    const openai = getOpenAIClient();
    let chunkPaths: string[] = [];

    try {
      // If file is too large, split into chunks
      if (fileSizeMB > MEDIA.WHISPER_MAX_SIZE_MB) {
        logger.info(
          { audioPath, fileSizeMB: fileSizeMB.toFixed(2), limit: MEDIA.WHISPER_MAX_SIZE_MB },
          `✂️ Audio file exceeds ${MEDIA.WHISPER_MAX_SIZE_MB}MB limit - splitting into chunks`
        );

        chunkPaths = await splitAudioIntoChunks(audioPath, MEDIA.WHISPER_CHUNK_SIZE_MB);

        // Transcribe each chunk
        const chunkTranscriptions: string[] = [];
        let detectedLanguage = 'fr';

        for (let i = 0; i < chunkPaths.length; i++) {
          const chunkPath = chunkPaths[i];
          logger.info({ chunkPath, progress: `${i + 1}/${chunkPaths.length}` }, `🎤 Transcribing chunk ${i + 1}/${chunkPaths.length}`);

          const chunkFile = await readFile(chunkPath);
          const transcription = await openai.audio.transcriptions.create({
            file: new File([chunkFile], chunkPath.split('/').pop() || `chunk${i + 1}.mp3`),
            model: 'whisper-1',
            language: 'fr',
            response_format: 'verbose_json'
          });

          chunkTranscriptions.push(transcription.text);
          if (i === 0) {
            detectedLanguage = transcription.language || 'fr';
          }

          logger.info(
            { chunk: i + 1, textLength: transcription.text.length },
            `✅ Chunk ${i + 1}/${chunkPaths.length} transcribed`
          );
        }

        // Combine all chunk transcriptions
        const combinedText = chunkTranscriptions.join(' ');

        logger.info(
          { numChunks: chunkPaths.length, totalTextLength: combinedText.length },
          '✅ All chunks transcribed and combined'
        );

        return {
          text: combinedText,
          language: detectedLanguage,
          confidence: undefined
        };

      } else {
        // File is small enough - transcribe directly
        const audioFile = await readFile(audioPath);
        const finalFileSizeMB = (audioFile.length / (1024 * 1024)).toFixed(2);

        logger.info(
          { audioPath, fileSizeMB: `${finalFileSizeMB}MB`, fileSizeBytes: audioFile.length },
          `📊 Audio file loaded`
        );

        const transcriptionPromise = openai.audio.transcriptions.create({
          file: new File([audioFile], audioPath.split('/').pop() || 'audio.mp3'),
          model: 'whisper-1',
          language: 'fr',
          response_format: 'verbose_json'
        });

        // Manual timeout wrapper
        const transcription = await Promise.race([
          transcriptionPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Transcription timeout')), MEDIA.TRANSCRIPTION_TIMEOUT)
          )
        ]);

        logger.info(
          {
            duration: transcription.duration,
            language: transcription.language,
            textLength: transcription.text.length
          },
          '✅ Transcription complete'
        );

        return {
          text: transcription.text,
          language: transcription.language || 'fr',
          confidence: undefined
        };
      }
    } finally {
      // Always cleanup chunks if they were created
      if (chunkPaths.length > 0) {
        await cleanupChunks(chunkPaths);
      }
    }
  } catch (error) {
    // Enhanced error logging for debugging
    const errorDetails: Record<string, unknown> = {
      audioPath,
      errorType: error?.constructor?.name || 'Unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
    };

    // Add stack trace if available
    if (error instanceof Error && error.stack) {
      errorDetails.stack = error.stack.split('\n').slice(0, 5).join('\n'); // First 5 lines
    }

    // Add OpenAI-specific error details if available
    if (error && typeof error === 'object' && 'status' in error) {
      errorDetails.status = (error as any).status;
      errorDetails.code = (error as any).code;
      errorDetails.type = (error as any).type;
    }

    logger.error(errorDetails, '❌ Transcription failed');
    throw error;
  }
}

/**
 * Process all media in a lesson (download, screenshot, transcribe)
 */
export async function processLessonMedia(
  lesson: CompleteLesson,
  chapterNumber: number,
  courseSlug: string,
  options: MediaProcessingOptions
): Promise<void> {
  if (lesson.media.length === 0) {
    logger.debug({ lessonId: lesson.metadata.id }, '⏭️ No media to process');
    return;
  }

  const outputDir = resolve(process.cwd(), 'output', courseSlug, 'media', `chapter-${chapterNumber}`);
  
  // Skip directory creation in dry-run mode
  if (!options.dryRun) {
    await mkdir(outputDir, { recursive: true });
  }

  // 1. Deduplicate media first (skip redundant MP3 if video exists)
  let mediaToProcess = deduplicateMedia(lesson.media);
  const dedupedCount = lesson.media.length - mediaToProcess.length;

  if (dedupedCount > 0) {
    logger.debug({ lessonId: lesson.metadata.id, skipped: dedupedCount }, '🔄 Media deduplicated');
    // Track skipped deduped media in stats
    if (options.stats) {
      for (let i = 0; i < dedupedCount; i++) {
        updateMediaStats(options.stats, lesson.media[i], false, false, false, true);
      }
    }
  }

  // 2. Resume mode: Filter out already-completed media
  if (options.resumeMode) {
    const originalCount = mediaToProcess.length;
    mediaToProcess = await filterIncompleteMedia(
      mediaToProcess,
      lesson.metadata.id,
      options
    );

    const resumedSkipped = originalCount - mediaToProcess.length;
    if (resumedSkipped > 0 && options.stats) {
      options.stats.resumedSkipped += resumedSkipped;
    }
  }

  // DRY-RUN MODE: Only estimate, don't download/transcribe
  if (options.dryRun) {
    logger.info(
      { lessonId: lesson.metadata.id, mediaCount: mediaToProcess.length },
      '🔍 [DRY-RUN] Estimating media costs'
    );

    for (const media of mediaToProcess) {
      const estimatedDuration = estimateMediaDuration(media);
      logger.debug(
        { lessonId: lesson.metadata.id, mediaType: media.type, estimatedMinutes: estimatedDuration },
        '📊 [DRY-RUN] Media detected'
      );

      // Update stats with estimation (will be transcribed in real run)
      if (options.stats) {
        updateMediaStats(options.stats, media, true, !options.skipTranscribe, false, false, estimatedDuration);
      }
    }

    return; // Exit early for dry-run
  }

  // NORMAL MODE: Download and transcribe
  logger.info(
    { lessonId: lesson.metadata.id, mediaCount: mediaToProcess.length },
    '🎬 Processing lesson media'
  );

  for (const media of mediaToProcess) {
    let downloaded = false;
    let transcribed = false;
    let hasError = false;

    // DEBUG: Log which media we're processing
    const urlHash = media.url?.split('/').pop()?.split('.')[0]?.substring(0, 8) || 'no-url';
    logger.info(
      {
        type: media.type,
        urlHash,
        url: media.url
      },
      `🎬 [DEBUG] Processing media ${urlHash}`
    );

    try {
      // 1. Download media
      let audioPath: string;

      if (media.type === 'youtube') {
        audioPath = await downloadYouTubeAudio(
          media,
          outputDir,
          lesson.metadata.id,
          options.proxy,
          options.antiDetection
        );
      } else if (media.type === 'vimeo') {
        audioPath = await downloadVimeoAudio(media, outputDir, lesson.metadata.id);
      } else if (media.type === 'audio_mp3' || media.type === 'video_s3') {
        audioPath = await downloadS3Media(media, outputDir, lesson.metadata.id);
      } else {
        logger.warn({ type: media.type }, '⚠️ Unknown media type - skipping');
        if (options.stats) {
          updateMediaStats(options.stats, media, false, false, false, true);
        }
        continue;
      }

      media.downloaded = true;
      downloaded = true;

      // 2. Extract screenshot BEFORE conversion (needs MP4 for video_s3)
      if (!options.skipScreenshots) {
        let screenshotPath: string = '';

        if (media.type === 'youtube') {
          screenshotPath = await extractYouTubeThumbnail(media, outputDir, lesson.metadata.id);
        } else if (media.type === 'vimeo') {
          screenshotPath = await extractVimeoThumbnail(media, outputDir, lesson.metadata.id);
        } else if (media.type === 'video_s3') {
          screenshotPath = await extractS3VideoThumbnail(audioPath, outputDir, lesson.metadata.id);
        } else {
          logger.debug({ type: media.type }, '⏭️ Skipping screenshot for audio');
        }

        if (screenshotPath) {
          media.screenshots = [screenshotPath];
        }
      }

      // 3. Convert MP4 to MP3 for S3 videos (AFTER screenshot extraction)
      if (media.type === 'video_s3' && audioPath.endsWith('.mp4')) {
        logger.info({ audioPath }, '🔄 Converting MP4 → MP3 for Whisper compatibility');
        audioPath = await convertMp4ToMp3(audioPath);
      }

      // Store final path (MP3 for video_s3, original for others)
      media.localPath = audioPath;

      // 3. Transcribe (if not skipped)
      if (!options.skipTranscribe) {
        const transcription = await withRetry(
          async () => await transcribeAudio(audioPath),
          `Whisper transcription (lesson ${lesson.metadata.id})`,
          {
            maxAttempts: 4,  // 4 retries = 5 total attempts (better for network issues)
            exponentialBackoff: true,  // Always use exponential backoff for transcriptions
            enableJitter: true,  // Add jitter to avoid thundering herd
          }
        );
        media.transcription = transcription.text;
        media.transcriptionLanguage = transcription.language;
        media.transcriptionConfidence = transcription.confidence;
        media.transcribed = true; // Mark as transcribed for resume logic
        transcribed = true;

        // 4. Now that transcription is complete (including all retries), safe to delete MP4
        if (media.type === 'video_s3' && audioPath.endsWith('.mp3')) {
          const mp4Path = audioPath.replace(/\.mp3$/, '.mp4');
          try {
            await unlink(mp4Path);
            logger.info({ mp3Path: audioPath }, '🗑️ Deleted original MP4 after successful transcription');
          } catch (unlinkError) {
            // Don't fail if MP4 is already deleted (e.g., from previous run)
            logger.debug({ error: unlinkError, mp4Path }, '⚠️ Failed to delete original MP4 (may already be deleted)');
          }
        }
      }

      logger.info(
        {
          lessonId: lesson.metadata.id,
          mediaType: media.type,
          transcriptionLength: media.transcription?.length || 0,
          hasScreenshot: media.screenshots.length > 0
        },
        '✅ Media processed'
      );

      // Update stats on success
      if (options.stats) {
        updateMediaStats(options.stats, media, downloaded, transcribed, false, false);
      }

      // Rate limiting between media (with random jitter to avoid predictable patterns)
      const delay = addJitter(1000, options.antiDetection?.enableRandomJitter ?? false);
      await sleep(delay);

    } catch (error) {
      hasError = true;
      logger.warn(
        { error, lessonId: lesson.metadata.id, mediaType: media.type },
        '⚠️ Media processing failed - continuing with next media (may succeed in resume mode)'
      );

      // Track error in stats
      if (options.stats) {
        updateMediaStats(options.stats, media, downloaded, transcribed, hasError, false);
      }
      // Continue with next media (don't fail entire lesson)
    }
  }
}

/**
 * Log final media processing statistics
 */
export function logMediaStats(stats: MediaStats, dryRun: boolean = false): void {
  const mode = dryRun ? '[DRY-RUN] ESTIMATION' : 'FINAL';
  const title = `📊 ${mode} - Media Processing Statistics`;
  const separator = '━'.repeat(title.length);

  logger.info('\n');
  logger.info(title);
  logger.info(separator);

  logger.info(`Total Media Detected: ${stats.totalMedia}`);
  logger.info(`  ├─ YouTube: ${stats.byType.youtube}`);
  logger.info(`  ├─ Vimeo: ${stats.byType.vimeo}`);
  logger.info(`  ├─ Audio MP3: ${stats.byType.audio_mp3}`);
  logger.info(`  └─ Video S3: ${stats.byType.video_s3}`);

  logger.info('');
  logger.info(`Downloaded: ${stats.downloaded}`);
  logger.info(`Transcribed: ${stats.transcribed}`);
  logger.info(`Skipped (deduped): ${stats.skipped}`);
  if (stats.resumedSkipped > 0) {
    logger.info(`Skipped (resumed): ${stats.resumedSkipped}`);
  }
  logger.info(`Errors: ${stats.errors}`);

  logger.info('');
  const minutes = Math.round(stats.totalMinutes);
  const hours = (minutes / 60).toFixed(1);
  logger.info(`Total Duration: ${minutes} minutes (~${hours} hours)`);
  logger.info(`Estimated Whisper Cost: $${stats.estimatedCost.toFixed(2)}`);

  // Storage estimation (approximate)
  const storageGB = ((stats.downloaded * 15) / 1024).toFixed(2); // ~15MB per media file
  logger.info(`Estimated Storage: ~${storageGB} GB`);

  logger.info(separator);
  logger.info('');
}

/**
 * Assemble fullContent from mainContent + media thumbnails + transcriptions
 */
export function assembleFullContent(lesson: CompleteLesson): void {
  const parts: string[] = [lesson.content.mainContent];

  // Add media content (thumbnails + transcriptions)
  for (const media of lesson.media) {
    // Add thumbnail if available
    if (media.screenshots && media.screenshots.length > 0) {
      const thumbnailPath = media.screenshots[0];
      parts.push(`\n\n![Video Thumbnail](${thumbnailPath})`);
    }

    // Add transcription if available
    if (media.transcription) {
      parts.push(`\n\n## 🎥 Transcription: ${media.type}\n\n${media.transcription}`);
    }
  }

  lesson.fullContent = parts.join('');

  logger.info(
    {
      lessonId: lesson.metadata.id,
      mainContentLength: lesson.content.mainContent.length,
      fullContentLength: lesson.fullContent.length,
      mediaCount: lesson.media.length,
      transcribedCount: lesson.media.filter(m => m.transcription).length,
      thumbnailCount: lesson.media.filter(m => m.screenshots?.length > 0).length
    },
    '✅ Full content assembled'
  );
}
