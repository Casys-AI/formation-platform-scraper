/**
 * Debug script to test JavaScript syntax in evaluate()
 */

import 'dotenv/config';
import { authenticate } from '../auth.js';
import { createLogger } from '../utils.js';

const logger = createLogger('debug-js-syntax');

// Default test lesson used when no lesson ID is passed on the command line
const DEFAULT_LESSON_ID = '1021159';

async function main() {
  try {
    const email = process.env.FORMATION_EMAIL;
    const password = process.env.FORMATION_PASSWORD;
    const formationUrl = process.env.FORMATION_URL;

    if (!email || !password) {
      throw new Error('FORMATION_EMAIL and FORMATION_PASSWORD must be set in .env');
    }
    if (!formationUrl) {
      throw new Error('FORMATION_URL must be set in .env');
    }

    logger.info('Authenticating...');
    const mcpClient = await authenticate({ email, password }, formationUrl);

    const lessonId = process.argv[2] || DEFAULT_LESSON_ID;
    const url = `${formationUrl}/elements/${lessonId}`;
    logger.info({ url }, 'Navigating to lesson...');
    await mcpClient.navigate(url);

    logger.info('Waiting for page load...');
    await mcpClient.waitFor({ timeout: 5000 });

    logger.info('Test 1: Simple h1 extraction');
    try {
      const h1 = await mcpClient.evaluate(`document.querySelector('h1')?.textContent?.trim() || 'NOT FOUND'`);
      logger.info({ h1 }, '✅ Test 1 passed');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, '❌ Test 1 failed');
    }

    logger.info('Test 2: h1 parent finder');
    try {
      const result = await mcpClient.evaluate(`
        (() => {
          const h1 = document.querySelector('h1');
          if (!h1) return { found: false };

          let parent = h1.parentElement;
          let level = 0;

          while (parent && level < 5) {
            const paragraphCount = parent.querySelectorAll('p').length;
            if (paragraphCount >= 3) {
              return {
                found: true,
                tag: parent.tagName,
                className: parent.className,
                paragraphs: paragraphCount,
                level: level
              };
            }
            parent = parent.parentElement;
            level++;
          }

          return { found: false };
        })()
      `);
      logger.info({ result }, '✅ Test 2 passed');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, '❌ Test 2 failed');
    }

    await mcpClient.disconnect();
    logger.info('✅ All tests complete');
  } catch (error) {
    logger.error({ error }, '❌ Tests failed');
    process.exit(1);
  }
}

main();
