import 'dotenv/config';
import { authenticate } from '../auth.js';
import { createLogger } from '../utils.js';

const logger = createLogger('debug-url');

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

    logger.info('Waiting 5 seconds...');
    await mcpClient.waitFor({ timeout: 5000 });

    // Check current URL
    const currentUrl = await mcpClient.evaluate(`window.location.href`);
    logger.info({ currentUrl }, 'Current URL after navigation');

    // Check page title
    const pageTitle = await mcpClient.evaluate(`document.title`);
    logger.info({ pageTitle }, 'Page title');

    // Check if redirected
    const isRedirected = currentUrl !== formationUrl;
    logger.info({ isRedirected }, 'Was redirected?');

    // Check body length
    const bodyLength = await mcpClient.evaluate(`document.body.innerHTML.length`);
    logger.info({ bodyLength }, 'Body HTML length');

    // Sample body content
    const bodySample = await mcpClient.evaluate(`document.body.textContent?.substring(0, 500)`);
    logger.info({ bodySample }, 'Body text sample (first 500 chars)');

    await mcpClient.disconnect();
    logger.info('Done');
  } catch (error) {
    console.error('ERROR:', error);
    process.exit(1);
  }
}

main();
