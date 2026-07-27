#!/usr/bin/env node
/**
 * Formation Platform Scraper - Main Entry Point
 *
 * Thin smoke-test entry point for the auth and discovery flows. The full
 * extraction pipeline lives behind the CLI (see src/cli/cli.ts).
 */

import 'dotenv/config';
import { authenticate, verifyAuthentication } from './auth.js';
import { discoverCourseStructure } from './discovery.js';
import { createLogger, redactEmail } from './utils.js';

const logger = createLogger('main');

/**
 * Read and validate the credentials + formation URL from the environment.
 * Fails fast with an explicit message when anything is missing.
 */
function readEnv() {
  const email = process.env.FORMATION_EMAIL;
  const password = process.env.FORMATION_PASSWORD;
  const formationUrl = process.env.FORMATION_URL;

  if (!email || !password) {
    throw new Error('FORMATION_EMAIL and FORMATION_PASSWORD must be set in .env');
  }
  if (!formationUrl) {
    throw new Error('FORMATION_URL must be set in .env (e.g. https://formations.<school>.<tld>/mon-espace/formations/<course-slug>)');
  }

  return { email, password, formationUrl };
}

/**
 * Test authentication flow
 */
async function testAuth() {
  try {
    logger.info('🧪 Testing authentication flow');

    const { email, password, formationUrl } = readEnv();

    logger.info({ email: redactEmail(email) }, '📧 Using credentials');

    const browser = await authenticate({ email, password }, formationUrl);

    logger.info('✅ Authentication succeeded');

    const isVerified = await verifyAuthentication(browser, formationUrl);
    if (isVerified) {
      logger.info('✅ Authentication verified');
    } else {
      logger.error('❌ Authentication verification failed');
    }

    await browser.disconnect();

    logger.info('🎉 Test complete');
  } catch (error) {
    logger.error({ error }, '❌ Test failed');
    process.exit(1);
  }
}

/**
 * Test discovery flow
 */
async function testDiscovery() {
  try {
    logger.info('🧪 Testing discovery flow');

    const { email, password, formationUrl } = readEnv();

    logger.info({ email: redactEmail(email) }, '📧 Using credentials');

    const browser = await authenticate({ email, password }, formationUrl);

    logger.info('✅ Authentication succeeded');

    // Run discovery (limit to 2 chapters for testing)
    logger.info('🔍 Starting course discovery (first 2 chapters only)...');
    const structure = await discoverCourseStructure(browser, formationUrl, { maxChapters: 2 });

    logger.info({
      totalChapters: structure.chapters.length,
      totalLessons: structure.totalLessons,
      firstChapter: structure.chapters[0]?.title,
      firstLessonTitle: structure.chapters[0]?.lessons[0]?.title,
      firstLessonId: structure.chapters[0]?.lessons[0]?.id,
    }, '✅ Discovery completed');

    await browser.disconnect();

    logger.info('🎉 Test complete');
  } catch (error) {
    logger.error({ error }, '❌ Test failed');
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--test-auth')) {
    await testAuth();
    return;
  }

  if (args.includes('--test-discovery') || args.includes('--discover-only')) {
    await testDiscovery();
    return;
  }

  // Default: show usage
  console.log(`
Formation Platform Scraper
Usage:
  npm start -- --test-auth          Test authentication flow
  npm start -- --test-discovery     Test course structure discovery

Environment variables required:
  FORMATION_EMAIL            Email used to access the formation
  FORMATION_PASSWORD         Password used to access the formation
  FORMATION_URL              URL of the formation to scrape
  OPENAI_API_KEY             OpenAI API key (for transcription)
`);
}

main().catch((error) => {
  logger.error({ error }, '💥 Fatal error');
  process.exit(1);
});
