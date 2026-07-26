/**
 * Debug script to check what's actually in the DOM
 */

import 'dotenv/config';
import { authenticate } from '../auth.js';
import { createLogger } from '../utils.js';

const logger = createLogger('debug-dom');

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

    logger.info('Navigating to index page...');
    await mcpClient.navigate(formationUrl);

    logger.info('Waiting for page load...');
    await mcpClient.waitFor({ timeout: 5000 });

    logger.info('Checking DOM...');

    // Debug 1: Check if ANY h2 elements exist
    const h2Count = await mcpClient.evaluate(`document.querySelectorAll('h2').length`);
    logger.info({ h2Count }, 'Total h2 elements found');

    // Debug 2: Get all h2 text content
    const h2Texts = await mcpClient.evaluate(`
      Array.from(document.querySelectorAll('h2')).map(h2 => h2.textContent?.trim())
    `);
    logger.info({ h2Texts }, 'All h2 text content');

    // Debug 3: Check for "Chapitre" text anywhere
    const chapitreCount = await mcpClient.evaluate(`
      Array.from(document.querySelectorAll('h2')).filter(h2 =>
        (h2.textContent || '').includes('Chapitre')
      ).length
    `);
    logger.info({ chapitreCount }, 'h2 elements containing "Chapitre"');

    // Debug 4: Check entire body text for "Chapitre"
    const bodyHasChapitre = await mcpClient.evaluate(`
      document.body.textContent?.includes('Chapitre') || false
    `);
    logger.info({ bodyHasChapitre }, 'Body contains "Chapitre"');

    await mcpClient.disconnect();
    logger.info('Done');
  } catch (error) {
    console.error('ERROR:', error);
    logger.error({ error: String(error), stack: error instanceof Error ? error.stack : undefined }, 'Debug failed');
    process.exit(1);
  }
}

main();
