/**
 * Main extraction script using configuration file
 * Orchestrates content extraction based on config mode
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { authenticate } from '../auth.js';
import { loadConfig, describeConfig, ExtractionConfig } from '../config.js';
import { loadCourseStructure } from '../discovery.js';
import { extractLessonContent, extractChapterLessons, extractLessonsByType } from '../extractor.js';
import { processLessonMedia, assembleFullContent, createMediaStats, logMediaStats } from '../media-handler.js';
import { formatLessonContent, createFormattingStats } from '../content-formatter.js';
import { createLogger, sleep } from '../utils.js';
import { sanitizeFilename, sanitizeLessonId } from '../sanitizer.js';
import { LESSON_EMOJIS } from '../constants.js';
import { markLessonComplete, isLessonAlreadyComplete } from '../lesson-completion.js';
import { autoCompleteQuiz } from '../quiz-validator.js';
import type { CompleteLesson, CourseStructure, LessonMetadata } from '../types.js';

const logger = createLogger('extract');

/**
 * Check if a lesson is a quiz/QCM
 * Detects quizzes by emoji type OR by title containing "quiz" or "qcm"
 */
function isQuiz(lesson: LessonMetadata): boolean {
  const lowerTitle = lesson.title.toLowerCase();
  return lesson.type === LESSON_EMOJIS.QUIZ || lowerTitle.includes('quiz') || lowerTitle.includes('qcm');
}

/**
 * Process lessons in stream mode (one by one with immediate save)
 * This is the common function used by all extraction modes
 */
async function processLessonStream(
  lessons: LessonMetadata[],
  context: {
    mcpClient: any;
    structure: CourseStructure;
    config: ExtractionConfig;
    outputDir: string;
    chapterNum?: number;
    mediaStats: any;
    formattingStats: any;
    extractedLessons: CompleteLesson[];
    progressLabel?: string; // e.g., "Chapter 2" or "Type 📝" for logging
  }
): Promise<void> {
  const { mcpClient, structure, config, outputDir, chapterNum, mediaStats, formattingStats, extractedLessons, progressLabel } = context;
  const totalLessons = lessons.length;

  logger.info({ totalLessons, progressLabel }, `🔄 Starting stream processing of ${totalLessons} lessons${progressLabel ? ` (${progressLabel})` : ''}`);

  for (const [index, lessonMeta] of lessons.entries()) {
    const lessonIdx = index + 1;
    const startTime = Date.now();

    logger.info(
      { lessonId: lessonMeta.id, progress: `${lessonIdx}/${totalLessons}`, progressLabel },
      `📄 [${lessonIdx}/${totalLessons}] Extracting: ${lessonMeta.title}`
    );

    // Handle quiz skipping with marking
    if (config.filters?.skipQuizzes && isQuiz(lessonMeta)) {
      logger.info({ lessonId: lessonMeta.id, title: lessonMeta.title }, '⏭️ Skipping quiz (will be auto-completed)');

      // Auto-complete quiz by answering questions and submitting
      if (config.lessonCompletion?.autoValidate) {
        const quizUrl = `${config.formationUrl}/elements/${lessonMeta.id}`;
        logger.info({ lessonId: lessonMeta.id }, '🎯 Auto-completing quiz...');

        const result = await autoCompleteQuiz(mcpClient, quizUrl);

        if (result.success) {
          logger.info({ lessonId: lessonMeta.id, questionCount: result.questionCount }, '✅ Quiz auto-completed successfully');
        } else {
          logger.error({ lessonId: lessonMeta.id, error: result.error }, '❌ Failed to auto-complete quiz');
        }
      }

      // Rate limiting (longer delay after quiz to let platform unlock next lessons)
      if (config.rateLimit?.enableRateLimit && lessonIdx < totalLessons) {
        await sleep(config.rateLimit.delayMs + 5000); // Extra 5s delay after quiz
      }

      continue;
    }

    // Resume mode: Skip already extracted lessons (only if fully complete)
    if (config.media.resumeMode) {
      // Determine chapter number (from context or by finding in structure)
      let lessonChapterNum = chapterNum;
      if (!lessonChapterNum) {
        // Find which chapter contains this lesson
        const foundChapter = structure.chapters.find(ch => ch.lessons.some(l => l.id === lessonMeta.id));
        lessonChapterNum = foundChapter?.number;
      }

      if (lessonChapterNum) {
        // Check JSON file for completion status (not just .md existence)
        const existingLesson = await loadExistingLesson(lessonMeta.id, lessonChapterNum, outputDir);

        if (existingLesson) {
          // Check if media is complete (same logic as checkLessonsCompletion)
          const mediaComplete = config.media.skipMedia ||
            (existingLesson.media?.length === 0) ||
            (existingLesson.media?.every(m => m.downloaded && (config.media.skipTranscribe || m.transcribed)) ?? false);

          // Check if formatting is complete (same logic as checkLessonsCompletion)
          const formattingComplete = config.formatting.skipFormatting ||
            !!(existingLesson.fullContentFormatted && existingLesson.summary && existingLesson.keywords);

          // Only skip if BOTH media and formatting are complete
          if (mediaComplete && formattingComplete) {
            logger.info({
              lessonId: lessonMeta.id,
              title: lessonMeta.title,
              chapter: lessonChapterNum,
              mediaComplete,
              formattingComplete
            }, '⏭️ Skipping (already complete in resume mode)');

            // Check if already marked complete, only re-mark if needed (Story 10 optimization)
            if (config.lessonCompletion?.autoValidate) {
              const lessonUrl = `${config.formationUrl}/elements/${lessonMeta.id}`;

              // Check completion status on platform
              const alreadyComplete = await isLessonAlreadyComplete(mcpClient, lessonUrl);

              if (alreadyComplete) {
                logger.info({ lessonId: lessonMeta.id }, '✅ Lesson already marked as complete (skipping re-mark)');
              } else {
                logger.info({ lessonId: lessonMeta.id }, '🔘 Re-marking skipped lesson as complete');
                await markLessonComplete(mcpClient, lessonUrl, config.lessonCompletion?.waitAfterConfirm || 2000);
                logger.info({ lessonId: lessonMeta.id }, '✅ Lesson re-marked as complete');
              }
            }

            // Rate limiting
            if (config.rateLimit?.enableRateLimit && lessonIdx < totalLessons) {
              await sleep(config.rateLimit.delayMs);
            }

            continue;
          } else {
            logger.info({
              lessonId: lessonMeta.id,
              title: lessonMeta.title,
              chapter: lessonChapterNum,
              mediaComplete,
              formattingComplete
            }, '🔄 Re-processing lesson (incomplete in resume mode)');
          }
        }
      }
    }

    // Extract ONE lesson at a time (stream processing)
    try {
      logger.info({ lessonId: lessonMeta.id }, '📥 Extracting lesson content...');
      const lesson = await extractLessonContent(lessonMeta.id, mcpClient, structure);
      logger.info({ lessonId: lessonMeta.id, contentLength: lesson.content.mainContent.length }, '✅ Lesson content extracted');

      // Check if lesson is locked (indicates quiz completion failed)
      // This prevents scraping dozens of lessons with the same "locked" message instead of real content
      if (lesson.content.mainContent.includes('Vous devez finir toutes les leçons précédentes avant d\'accéder à celle-ci')) {
        const errorMsg = `🔒 LOCKED LESSON DETECTED: "${lessonMeta.title}" (ID: ${lessonMeta.id})\n\nThis means a previous quiz was not properly completed, blocking access to subsequent lessons.\nHalting extraction immediately to prevent scraping empty content.\n\nPlease:\n1. Check the logs for quiz auto-completion failures\n2. Manually complete any failed quizzes\n3. Re-run the extraction`;

        logger.error({
          lessonId: lessonMeta.id,
          title: lessonMeta.title,
          chapter: lesson.chapter.number,
          progress: `${lessonIdx}/${totalLessons}`
        }, errorMsg);

        throw new Error(errorMsg);
      }

      // Resume mode: Load existing lesson and merge media info
      if (config.media.resumeMode) {
        const lessonChapterNum = chapterNum || lesson.chapter.number;
        const existingLesson = await loadExistingLesson(lesson.metadata.id, lessonChapterNum, outputDir);
        if (existingLesson) {
          logger.info({ lessonId: lessonMeta.id }, '🔄 Merging with existing lesson (resume mode)');
          await mergeMediaInfo(lesson, existingLesson, config.media.verifyDiskFiles || false, outputDir);
        }
      }

      // Story 6: Process media (download, screenshot, transcribe)
      if (!config.media.skipMedia) {
        const lessonChapterNum = chapterNum || lesson.chapter.number;
        logger.info({ lessonId: lessonMeta.id, mediaCount: lesson.media.length }, '🎬 Processing media...');
        await processLessonMedia(
          lesson,
          lessonChapterNum,
          structure.slug,
          {
            skipTranscribe: config.media.skipTranscribe,
            skipScreenshots: config.media.skipScreenshots,
            dryRun: config.dryRun,
            stats: mediaStats,
            proxy: config.proxy,
            antiDetection: config.antiDetection,
            resumeMode: config.media.resumeMode,
            verifyDiskFiles: config.media.verifyDiskFiles
          }
        );
        assembleFullContent(lesson);
        logger.info({ lessonId: lessonMeta.id, fullContentLength: lesson.fullContent?.length || 0 }, '✅ Media processed');
      }

      // Story 6.5: Format content + generate summary
      if (!config.formatting.skipFormatting && lesson.fullContent) {
        logger.info({ lessonId: lessonMeta.id }, '✨ Formatting content and generating summary...');
        await formatLessonContent(lesson, {
          model: config.formatting.model,
          stats: formattingStats
        });
        logger.info({ lessonId: lessonMeta.id, summaryLength: lesson.summary?.length || 0 }, '✅ Content formatted');
      }

      // Save immediately (STREAM PROCESSING)
      logger.info({ lessonId: lessonMeta.id }, '💾 Saving lesson files...');
      await saveLessonImmediately(lesson, config, outputDir);
      extractedLessons.push(lesson);
      const elapsed = Date.now() - startTime;
      logger.info(
        { lessonId: lessonMeta.id, elapsedMs: elapsed, progress: `${lessonIdx}/${totalLessons}` },
        `✅ Lesson saved (took ${(elapsed / 1000).toFixed(1)}s)`
      );

      // Story 10: Mark lesson as complete after extraction if auto-validation is enabled
      if (config.lessonCompletion?.autoValidate) {
        const lessonUrl = `${config.formationUrl}/elements/${lessonMeta.id}`;
        logger.info({ lessonId: lessonMeta.id }, '🔘 Marking lesson as complete');
        await markLessonComplete(mcpClient, lessonUrl, config.lessonCompletion?.waitAfterConfirm || 2000);
        logger.info({ lessonId: lessonMeta.id }, '✅ Lesson marked as complete');
      }
    } catch (error) {
      // Log error but continue with next lesson instead of crashing entire extraction
      logger.warn({
        lessonId: lessonMeta.id,
        lessonTitle: lessonMeta.title,
        error: error instanceof Error ? error.message : String(error),
        progress: `${lessonIdx}/${totalLessons}`
      }, `⚠️ Failed to extract lesson "${lessonMeta.title}" - skipping and continuing with next lesson`);

      // Don't add to extractedLessons array (lesson failed)
    }

    // Rate limiting between lessons (always apply, even after errors)
    if (config.rateLimit.enableRateLimit && lessonIdx < totalLessons) {
      await sleep(config.rateLimit.delayMs);
    }
  }

  logger.info({ totalLessons, progressLabel }, `🎉 Completed stream processing of ${totalLessons} lessons${progressLabel ? ` (${progressLabel})` : ''}`);
}

async function main() {
  try {
    // 1. Load configuration
    const configPath = process.argv[2] || 'extraction-config.json';
    const config = loadConfig(configPath);

    logger.info('================================================================================');
    logger.info('📦 CONTENT EXTRACTION');
    logger.info('================================================================================');
    logger.info(`\n📋 ${describeConfig(config)}`);
    logger.info(`⏱️ Rate limit: ${config.rateLimit.enableRateLimit ? config.rateLimit.delayMs + 'ms' : 'disabled'}`);
    if (config.dryRun) {
      logger.info('🔍 DRY-RUN MODE: Estimation only, no downloads/transcription');
    }
    logger.info('');

    // 2. Validate OPENAI_API_KEY if transcription is enabled (fail-fast)
    if (!config.media.skipMedia && !config.media.skipTranscribe) {
      if (!process.env.OPENAI_API_KEY) {
        logger.error('❌ OPENAI_API_KEY environment variable is required for transcription');
        logger.info('💡 Either set OPENAI_API_KEY or disable transcription with "skipTranscribe": true in config\n');
        throw new Error('Missing OPENAI_API_KEY - transcription cannot proceed');
      }
      logger.info('✅ OPENAI_API_KEY found - transcription enabled\n');
    }

    // 2b. Validate proxy is accessible if enabled (fail-fast for YouTube)
    if (config.proxy?.enabled && config.proxy.url) {
      logger.info({ proxyUrl: config.proxy.url }, '🔍 Testing proxy connection...');
      try {
        const { execa } = await import('execa');
        await execa('curl', [
          '--proxy',
          config.proxy.url,
          '--connect-timeout',
          '5',
          '--max-time',
          '10',
          '-I',
          'https://www.youtube.com',
        ]);
        logger.info('✅ Proxy connection test successful\n');
      } catch (error: any) {
        logger.error({ proxyUrl: config.proxy.url, error }, '❌ Proxy connection test FAILED');
        throw new Error(`Proxy connection failed: ${config.proxy.url}`);
      }
    }

    // 3. Load course structure from disk (extracting slug from formation URL)
    // Extract slug directly from formation URL (last segment of the path)
    const slug = config.formationUrl.split('/').pop() || '';

    const structure = await loadCourseStructure(slug);
    const allLessons = structure.chapters.flatMap(c => c.lessons);
    logger.info({ slug: structure.slug, chapters: structure.chapters.length, totalLessons: allLessons.length }, '📚 Course structure loaded');

    // 3.5. Pre-check: Skip auth if all lessons are already complete (resume mode optimization)
    const outputDir = resolve(process.cwd(), 'output', structure.slug, 'lessons');
    await mkdir(outputDir, { recursive: true });

    let needsAuth = true;
    if (config.media.resumeMode || !config.formatting.skipFormatting) {
      const lessonsToCheck = await getLessonsToExtract(config, structure);
      const completionStatus = await checkLessonsCompletion(lessonsToCheck, outputDir, config);

      if (completionStatus.allComplete) {
        needsAuth = false;
        logger.info({
          total: completionStatus.total,
          complete: completionStatus.complete,
          incomplete: completionStatus.incomplete
        }, '✅ All lessons already complete - skipping authentication');
      } else {
        logger.info({
          total: completionStatus.total,
          complete: completionStatus.complete,
          incomplete: completionStatus.incomplete
        }, '📊 Pre-check: Some lessons need processing');
      }
    }

    // 4. Authenticate (dual auth: Teachizy + tenant) - only if needed
    let mcpClient: any = null;

    if (needsAuth) {
      logger.info('🔐 Authenticating...');

      const email = process.env.FORMATION_EMAIL;
      const password = process.env.FORMATION_PASSWORD;

      if (!email || !password) {
        throw new Error('Missing credentials in .env file (FORMATION_EMAIL, FORMATION_PASSWORD)');
      }

      mcpClient = await authenticate({ email, password }, config.formationUrl);

      logger.info('✅ Authentication successful\n');
    }

    // 5. Initialize statistics tracking
    const mediaStats = createMediaStats();
    const formattingStats = createFormattingStats();

    // 6. Output directory already created in pre-check
    logger.info({ outputDir, slug: structure.slug }, '📂 Output directory ready\n');

    // 7. Extract based on mode (skip if all complete)
    const extractedLessons: CompleteLesson[] = [];

    if (!needsAuth) {
      // All lessons are already complete - no extraction needed
      logger.info('\n================================================================================');
      logger.info('✅ EXTRACTION COMPLETE (NO NEW WORK NEEDED)');
      logger.info('================================================================================');
      logger.info('📊 All lessons already complete - nothing to extract');
      logger.info(`📂 Output directory: ${outputDir}`);
      logger.info('');
      return; // Exit early
    }

    switch (config.mode) {
      case 'chapters': {
        for (const chapterNum of config.chapters) {
          logger.info({ chapterNum }, `\n📖 Extracting Chapter ${chapterNum}...`);

          // Find the chapter in structure
          const chapter = structure.chapters.find(c => c.number === chapterNum);
          if (!chapter) {
            logger.error({ chapterNum }, 'Chapter not found in structure');
            continue;
          }

          // Apply skipAncChapters filter (skip entire chapter if ANC)
          if (config.filters?.skipAncChapters && chapter.title.includes('ANC')) {
            logger.info({ chapterNum, title: chapter.title }, `⏭️ Skipping ANC chapter`);
            continue;
          }

          // Get lessons for this chapter
          const filteredLessons = chapter.lessons;
          logger.info({ chapterNum, totalLessons: filteredLessons.length, title: chapter.title },
            `📊 Chapter ${chapterNum}: "${chapter.title}" - ${filteredLessons.length} lessons`);

          // Use common stream processing function
          await processLessonStream(filteredLessons, {
            mcpClient,
            structure,
            config,
            outputDir,
            chapterNum,
            mediaStats,
            formattingStats,
            extractedLessons,
            progressLabel: `Chapter ${chapterNum}`
          });

          logger.info({ chapterNum }, `✅ Chapter ${chapterNum} completed\n`);
        }
        break;
      }

      case 'types': {
        for (const type of config.types) {
          logger.info({ type }, `\n${type} Extracting Type ${type}...`);

          // Get all lessons of this type across all chapters
          let filteredLessons: LessonMetadata[] = [];
          for (const chapter of structure.chapters) {
            // Apply skipAncChapters filter
            if (config.filters?.skipAncChapters && chapter.title.includes('ANC')) {
              continue;
            }

            // Filter lessons by type
            const typedLessons = chapter.lessons.filter(l => l.type === type);
            filteredLessons.push(...typedLessons);
          }

          logger.info({ type, totalLessons: filteredLessons.length },
            `📊 Type ${type} - ${filteredLessons.length} lessons across all chapters`);

          // Use common stream processing function
          await processLessonStream(filteredLessons, {
            mcpClient,
            structure,
            config,
            outputDir,
            mediaStats,
            formattingStats,
            extractedLessons,
            progressLabel: `Type ${type}`
          });

          logger.info({ type }, `✅ Type ${type} completed\n`);
        }
        break;
      }

      case 'specific-lessons': {
        logger.info('\n📚 Extracting specific lessons...');

        // Convert lessonIds to LessonMetadata
        const specificLessons = config.lessonIds
          .map(id => allLessons.find((l: any) => l.id === id))
          .filter((l): l is LessonMetadata => l !== undefined);

        logger.info({ totalLessons: specificLessons.length, requestedIds: config.lessonIds.length },
          `📊 Found ${specificLessons.length} lessons out of ${config.lessonIds.length} requested IDs`);

        // Use common stream processing function
        await processLessonStream(specificLessons, {
          mcpClient,
          structure,
          config,
          outputDir,
          mediaStats,
          formattingStats,
          extractedLessons,
          progressLabel: 'Specific Lessons'
        });

        logger.info('✅ Specific lessons extraction completed\n');
        break;
      }

      case 'all': {
        logger.info('\n📚 Extracting ALL lessons...');

        // Apply filters (skipQuizzes, skipAncChapters)
        let filteredLessons = allLessons;

        if (config.filters?.skipQuizzes) {
          const beforeCount = filteredLessons.length;
          filteredLessons = filteredLessons.filter(l => !isQuiz(l));
          const skippedQuizzes = beforeCount - filteredLessons.length;
          if (skippedQuizzes > 0) {
            logger.info({ skippedQuizzes }, `⏭️ Skipped ${skippedQuizzes} quiz lessons (config.filters.skipQuizzes = true)`);
          }
        }

        if (config.filters?.skipAncChapters) {
          const beforeCount = filteredLessons.length;
          filteredLessons = filteredLessons.filter(l => {
            const chapter = structure.chapters.find(c => c.lessons.some(cl => cl.id === l.id));
            return chapter && !chapter.title.includes('ANC');
          });
          const skippedAnc = beforeCount - filteredLessons.length;
          if (skippedAnc > 0) {
            logger.info({ skippedAnc }, `⏭️ Skipped ${skippedAnc} ANC chapter lessons (config.filters.skipAncChapters = true)`);
          }
        }

        logger.info({ totalLessons: filteredLessons.length, originalCount: allLessons.length },
          `📊 Processing ${filteredLessons.length} lessons (filtered from ${allLessons.length})`);

        // Use common stream processing function
        await processLessonStream(filteredLessons, {
          mcpClient,
          structure,
          config,
          outputDir,
          mediaStats,
          formattingStats,
          extractedLessons,
          progressLabel: 'All Lessons'
        });

        logger.info('✅ All lessons extraction completed\n');
        break;
      }
    }

    // 8. Save extraction summary (like discover.ts does for structure)
    logger.info('\n💾 Saving extraction summary...');
    const summaryPath = resolve(outputDir, 'extraction-summary.json');
    const summary = {
      slug: structure.slug,
      mode: config.mode,
      extractedAt: new Date().toISOString(),
      totalLessons: extractedLessons.length,
      mediaStats,
      formattingStats,
    };
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    logger.info({ path: summaryPath }, '📄 Saved extraction summary');

    // 9. Close MCP connection (if we opened one)
    if (mcpClient) {
      await mcpClient.disconnect();
    }

    // 10. Log final media stats
    logger.info('\n================================================================================');
    logger.info('✅ EXTRACTION COMPLETE');
    logger.info('================================================================================');
    logger.info(`📊 Total lessons extracted: ${extractedLessons.length}`);
    logger.info(`📂 Output directory: ${outputDir}`);
    logger.info('');

    logMediaStats(mediaStats);

  } catch (error) {
    logger.error({ error }, '❌ Extraction failed');
    throw error;
  }
}

main();

/**
 * Save a single lesson immediately after extraction
 * Includes path traversal protection via filename sanitization
 */
async function saveLessonImmediately(
  lesson: CompleteLesson,
  config: ExtractionConfig,
  outputDir: string
): Promise<void> {
  // C2 FIX: Sanitize lesson ID to prevent path traversal attacks
  let sanitizedId: string;
  try {
    sanitizedId = sanitizeLessonId(lesson.content.id);
  } catch (error) {
    logger.error(
      { lessonId: lesson.content.id, error: error instanceof Error ? error.message : String(error) },
      '❌ Failed to sanitize lesson ID - skipping save'
    );
    throw new Error(`Invalid lesson ID: ${lesson.content.id}`);
  }

  const baseName = `lesson-${sanitizedId}`;

  // Additional protection: sanitize the complete filename
  let safeJsonFilename: string;
  let safeMdFilename: string;

  try {
    safeJsonFilename = sanitizeFilename(`${baseName}.json`);
    safeMdFilename = sanitizeFilename(`${baseName}.md`);
  } catch (error) {
    logger.error(
      { baseName, error: error instanceof Error ? error.message : String(error) },
      '❌ Failed to sanitize filename - skipping save'
    );
    throw new Error(`Failed to create safe filename for lesson ${lesson.content.id}`);
  }

  // Create chapter subdirectory (like media organization)
  const chapterDir = resolve(outputDir, `chapter-${lesson.chapter.number}`);
  await mkdir(chapterDir, { recursive: true });

  // Save JSON
  if (config.output.saveJson) {
    const jsonPath = resolve(chapterDir, safeJsonFilename);
    await writeFile(jsonPath, JSON.stringify(lesson, null, 2), 'utf-8');
    logger.debug({ path: jsonPath, originalId: lesson.content.id, chapter: lesson.chapter.number }, '💾 Saved JSON');
  }

  // Save Markdown
  if (config.output.saveMarkdown) {
    // Use formatted content if available (Story 6.5), otherwise raw fullContent (Story 6), otherwise mainContent (Story 5)
    const contentToExport = lesson.fullContentFormatted || lesson.fullContent || lesson.content.mainContent;
    const mdPath = resolve(chapterDir, safeMdFilename);
    await writeFile(mdPath, contentToExport, 'utf-8');
    logger.debug({ path: mdPath, originalId: lesson.content.id, chapter: lesson.chapter.number }, '💾 Saved Markdown');
  }
}

/**
 * Load existing lesson JSON if it exists (for resume mode)
 */
async function loadExistingLesson(
  lessonId: string,
  chapterNumber: number,
  outputDir: string
): Promise<CompleteLesson | null> {
  try {
    const { readFile } = await import('fs/promises');
    const { existsSync } = await import('fs');

    const sanitizedId = sanitizeLessonId(lessonId);
    const safeJsonFilename = sanitizeFilename(`lesson-${sanitizedId}.json`);
    const chapterDir = resolve(outputDir, `chapter-${chapterNumber}`);
    const jsonPath = resolve(chapterDir, safeJsonFilename);

    if (!existsSync(jsonPath)) {
      return null;
    }

    const content = await readFile(jsonPath, 'utf-8');
    const lesson = JSON.parse(content) as CompleteLesson;

    logger.debug(
      { lessonId, jsonPath, mediaCount: lesson.media?.length || 0 },
      '📂 Loaded existing lesson JSON'
    );

    return lesson;
  } catch (error) {
    logger.warn(
      { lessonId, error: error instanceof Error ? error.message : String(error) },
      '⚠️ Failed to load existing lesson - will extract fresh'
    );
    return null;
  }
}

/**
 * Merge media information from existing lesson into freshly extracted lesson
 * Preserves downloaded/transcribed flags and file paths
 */
async function mergeMediaInfo(
  freshLesson: CompleteLesson,
  existingLesson: CompleteLesson,
  verifyDiskFiles: boolean,
  outputDir: string
): Promise<void> {
  if (!existingLesson.media || existingLesson.media.length === 0) {
    return;
  }

  const { existsSync } = await import('fs');
  const { resolve: resolvePath } = await import('path');
  let mergedCount = 0;
  let recoveredCount = 0; // Files found on disk even though JSON says downloaded:false
  let missingFiles = 0;

  // Build expected media directory path
  // outputDir = "output/{slug}/lessons", we need "output/{slug}/media/chapter-X"
  const basePath = dirname(outputDir); // Remove "/lessons" -> "output/{slug}"
  const mediaDir = resolve(basePath, 'media', `chapter-${freshLesson.chapter.number}`);

  for (const freshMedia of freshLesson.media) {
    const existingMedia = existingLesson.media.find(
      m => {
        // Match by mediaId if both have one (YouTube, Vimeo)
        if (m.mediaId && freshMedia.mediaId) {
          return m.mediaId === freshMedia.mediaId && m.type === freshMedia.type;
        }
        // Fallback to URL matching for S3 videos (no mediaId)
        return m.url === freshMedia.url && m.type === freshMedia.type;
      }
    );

    if (!existingMedia) {
      continue;
    }

    // Try to recover file from disk even if JSON says downloaded:false
    let localPath = existingMedia.localPath;
    let fileExists = false;

    if (verifyDiskFiles) {
      // If we have a path from existing JSON, check it first
      if (localPath && existsSync(localPath)) {
        fileExists = true;
      } else {
        // Reconstruct expected path and check if file exists
        const lessonId = freshLesson.metadata.id;
        let expectedFilename = '';

        if (freshMedia.type === 'youtube') {
          expectedFilename = `lesson-${lessonId}-youtube-${freshMedia.mediaId}.mp3`;
        } else if (freshMedia.type === 'vimeo') {
          expectedFilename = `lesson-${lessonId}-vimeo-${freshMedia.mediaId}.mp3`;
        } else if (freshMedia.type === 'audio_mp3') {
          expectedFilename = `lesson-${lessonId}-audio.mp3`;
        } else if (freshMedia.type === 'video_s3') {
          // Extract URL hash same way as downloadS3Media (media-handler.ts:620)
          const urlHash = freshMedia.url.split('/').pop()?.split('.')[0]?.substring(0, 8) || 'unknown';
          expectedFilename = `lesson-${lessonId}-video_s3-${urlHash}.mp3`;
        }

        if (expectedFilename) {
          const expectedPath = resolvePath(mediaDir, expectedFilename);
          if (existsSync(expectedPath)) {
            localPath = expectedPath;
            fileExists = true;

            // Recovered file that JSON said wasn't downloaded!
            if (!existingMedia.downloaded) {
              logger.info(
                { mediaId: freshMedia.mediaId, path: expectedPath },
                '🔍 Recovered downloaded file from disk (JSON was wrong)'
              );
              recoveredCount++;
            }
          }
        }
      }
    }

    // Merge downloaded flag and path
    if (fileExists || (existingMedia.downloaded && existingMedia.localPath)) {
      if (fileExists) {
        freshMedia.downloaded = true;
        freshMedia.localPath = localPath;
        mergedCount++;
      } else if (existingMedia.downloaded && existingMedia.localPath) {
        // Trust the JSON if we're not verifying disk
        freshMedia.downloaded = true;
        freshMedia.localPath = existingMedia.localPath;
        mergedCount++;
      }
    } else if (existingMedia.downloaded && verifyDiskFiles) {
      logger.warn(
        { mediaId: freshMedia.mediaId, localPath: existingMedia.localPath },
        '⚠️ Media marked as downloaded but file missing - will re-download'
      );
      missingFiles++;
    }

    // Merge transcription
    if (existingMedia.transcribed && existingMedia.transcription) {
      freshMedia.transcribed = true;
      freshMedia.transcription = existingMedia.transcription;
    }

    // Merge screenshots
    if (existingMedia.screenshots && existingMedia.screenshots.length > 0) {
      // Verify screenshot files if requested
      if (verifyDiskFiles) {
        const validScreenshots = existingMedia.screenshots.filter(path => existsSync(path));
        if (validScreenshots.length < existingMedia.screenshots.length) {
          logger.warn(
            { mediaId: freshMedia.mediaId, missing: existingMedia.screenshots.length - validScreenshots.length },
            '⚠️ Some screenshots missing from disk'
          );
        }
        freshMedia.screenshots = validScreenshots;
      } else {
        freshMedia.screenshots = existingMedia.screenshots;
      }
    }
  }

  if (mergedCount > 0 || recoveredCount > 0) {
    logger.info(
      {
        lessonId: freshLesson.metadata.id,
        mergedCount,
        recoveredCount: recoveredCount > 0 ? recoveredCount : undefined,
        missingFiles: missingFiles > 0 ? missingFiles : undefined
      },
      '🔄 Merged media info from existing lesson'
    );
  }
}

/**
 * Get lessons to extract based on config mode
 */
async function getLessonsToExtract(
  config: ExtractionConfig,
  structure: CourseStructure
): Promise<LessonMetadata[]> {
  const allLessons = structure.chapters.flatMap(c => c.lessons);
  let filteredLessons = allLessons;

  // 1. Apply mode-specific filtering
  switch (config.mode) {
    case 'chapters':
      filteredLessons = allLessons.filter(l => {
        const chapter = structure.chapters.find(c => c.lessons.some(cl => cl.id === l.id));
        return chapter && config.chapters.includes(chapter.number);
      });
      break;

    case 'types':
      filteredLessons = allLessons.filter(l => config.types.includes(l.type));
      break;

    case 'specific-lessons':
      filteredLessons = allLessons.filter(l => config.lessonIds.includes(l.id));
      break;

    case 'all':
      // No mode-specific filtering for 'all'
      break;
  }

  // 2. Apply global filters (skipQuizzes, skipAncChapters) to ALL modes
  if (config.filters?.skipQuizzes) {
    filteredLessons = filteredLessons.filter(l => l.type !== LESSON_EMOJIS.QUIZ);
  }
  if (config.filters?.skipAncChapters) {
    filteredLessons = filteredLessons.filter(l => {
      const chapter = structure.chapters.find(c => c.lessons.some(cl => cl.id === l.id));
      return chapter && !chapter.title.includes('ANC');
    });
  }

  return filteredLessons;
}

/**
 * Check if lessons are already complete (media + formatting)
 */
async function checkLessonsCompletion(
  lessons: LessonMetadata[],
  outputDir: string,
  config: ExtractionConfig
): Promise<{ total: number; complete: number; incomplete: number; allComplete: boolean }> {
  let complete = 0;
  let incomplete = 0;

  for (const lessonMeta of lessons) {
    // Find chapter for this lesson
    const { readFile } = await import('fs/promises');
    const { existsSync } = await import('fs');

    try {
      const sanitizedId = sanitizeLessonId(lessonMeta.id);
      const safeJsonFilename = sanitizeFilename(`lesson-${sanitizedId}.json`);

      // Determine chapter number (need to find it from structure)
      // For now, let's check all possible chapter dirs
      let lessonComplete = false;

      for (let chapterNum = 1; chapterNum <= 30; chapterNum++) {
        const chapterDir = resolve(outputDir, `chapter-${chapterNum}`);
        const jsonPath = resolve(chapterDir, safeJsonFilename);

        if (existsSync(jsonPath)) {
          const content = await readFile(jsonPath, 'utf-8');
          const lesson = JSON.parse(content) as CompleteLesson;

          // Check if media is complete (if needed)
          const mediaComplete = config.media.skipMedia ||
            (lesson.media?.length === 0) ||
            (lesson.media?.every(m => m.downloaded && (config.media.skipTranscribe || m.transcribed)) ?? false);

          // Check if formatting is complete (if needed)
          const formattingComplete = config.formatting.skipFormatting ||
            !!(lesson.fullContentFormatted && lesson.summary && lesson.keywords);

          lessonComplete = mediaComplete && formattingComplete;
          break;
        }
      }

      if (lessonComplete) {
        complete++;
      } else {
        incomplete++;
      }
    } catch (error) {
      // If we can't check, assume incomplete
      incomplete++;
    }
  }

  return {
    total: lessons.length,
    complete,
    incomplete,
    allComplete: incomplete === 0 && complete > 0
  };
}

/**
 * Save extraction summary to disk
 * Individual lessons are saved immediately during extraction
 */
async function saveExtractionSummary(
  lessons: CompleteLesson[],
  config: ExtractionConfig,
  structure: CourseStructure,
  outputDir: string
): Promise<void> {

  // Save summary index
  const summary = {
    extractedAt: new Date().toISOString(),
    totalLessons: lessons.length,
    mode: config.mode,
    structure: {
      courseTitle: structure.title,
      totalChapters: structure.chapters.length,
    },
    lessons: lessons.map((l) => ({
      id: l.content.id,
      title: l.content.title,
      type: l.content.type,
      chapterNumber: l.chapter.number,
      chapterTitle: l.chapter.title,
      mediaCount: l.media.length,
      linksCount: l.content.links.length,
    })),
  };

  const summaryPath = resolve(outputDir, 'extraction-summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  logger.info({ path: summaryPath }, '📄 Saved extraction summary');
}

main();
