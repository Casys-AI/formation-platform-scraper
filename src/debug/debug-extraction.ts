/**
 * Debug script for Story 5 - Quick extraction test
 *
 * Usage: npm run dev src/debug/debug-extraction.ts [lessonId]
 * Example: npm run dev src/debug/debug-extraction.ts 1021159
 */

import 'dotenv/config';
import { authenticate } from '../auth.js';
import { loadCourseStructure } from '../discovery.js';
import { extractLessonContent } from '../extractor.js';
import { createLogger } from '../utils.js';
import { promises as fs } from 'fs';
import { join } from 'path';

const logger = createLogger('debug-extraction');

// Default test lesson (cours with YouTube video)
const DEFAULT_LESSON_ID = '1021159';

async function main() {
  try {
    // Get lesson ID from command line or use default
    const lessonId = process.argv[2] || DEFAULT_LESSON_ID;

    const email = process.env.FORMATION_EMAIL;
    const password = process.env.FORMATION_PASSWORD;
    const formationUrl = process.env.FORMATION_URL;

    if (!email || !password) {
      throw new Error('FORMATION_EMAIL and FORMATION_PASSWORD must be set in .env');
    }
    if (!formationUrl) {
      throw new Error('FORMATION_URL must be set in .env');
    }

    logger.info({ lessonId }, 'Starting extraction debug test');

    // Step 1: Authenticate
    logger.info('Step 1: Authenticating...');
    const browser = await authenticate({ email, password }, formationUrl);

    // Step 2: Load structure
    logger.info('Step 2: Loading course structure...');
    const structure = await loadCourseStructure();

    // Step 3: Extract lesson
    logger.info({ lessonId }, 'Step 3: Extracting lesson content...');
    const completeLesson = await extractLessonContent(lessonId, browser, structure);

    // Step 4: Display results
    logger.info('\\n' + '='.repeat(80));
    logger.info('📊 EXTRACTION RESULTS');
    logger.info('='.repeat(80));

    logger.info('\\n📋 Metadata:');
    logger.info({
      id: completeLesson.metadata.id,
      title: completeLesson.metadata.title,
      type: completeLesson.metadata.type,
      url: completeLesson.metadata.url,
      hasQuiz: completeLesson.metadata.hasQuiz,
    });

    logger.info('\\n📝 Content:');
    logger.info({
      title: completeLesson.content.title,
      type: completeLesson.content.type,
      contentLength: completeLesson.content.mainContent.length,
      linksCount: completeLesson.content.links.length,
      extractedAt: completeLesson.content.extractedAt,
    });

    logger.info('\\n🔗 Links:');
    if (completeLesson.content.links.length > 0) {
      completeLesson.content.links.forEach((link, idx) => {
        logger.info(`  ${idx + 1}. ${link.title}`);
        logger.info(`     ${link.url}`);
      });
    } else {
      logger.info('  (no external links found)');
    }

    logger.info('\\n🎥 Media:');
    if (completeLesson.media.length > 0) {
      completeLesson.media.forEach((media, idx) => {
        logger.info(`  ${idx + 1}. ${media.type}`);
        logger.info(`     URL: ${media.url}`);
        if (media.mediaId) {
          logger.info(`     ID: ${media.mediaId}`);
        }
      });
    } else {
      logger.info('  (no media found)');
    }

    logger.info('\\n📂 Chapter Context:');
    logger.info({
      number: completeLesson.chapter.number,
      title: completeLesson.chapter.title,
    });

    logger.info('\\n📄 Markdown Content Preview (first 500 chars):');
    logger.info('-'.repeat(80));
    logger.info(completeLesson.content.mainContent.substring(0, 500));
    if (completeLesson.content.mainContent.length > 500) {
      logger.info('... (truncated)');
    }
    logger.info('-'.repeat(80));

    // Step 5: Save to file for inspection
    const outputDir = 'output/debug';
    await fs.mkdir(outputDir, { recursive: true });

    const outputFile = join(outputDir, `lesson-${lessonId}.json`);
    await fs.writeFile(outputFile, JSON.stringify(completeLesson, null, 2), 'utf-8');

    logger.info(`\\n💾 Full output saved to: ${outputFile}`);

    // Also save markdown separately
    const markdownFile = join(outputDir, `lesson-${lessonId}.md`);
    await fs.writeFile(markdownFile, completeLesson.content.mainContent, 'utf-8');

    logger.info(`📝 Markdown saved to: ${markdownFile}`);

    // Cleanup
    await browser.disconnect();

    logger.info('\\n✅ Extraction test completed successfully!');
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }, '❌ Extraction test failed');
    process.exit(1);
  }
}

main();
