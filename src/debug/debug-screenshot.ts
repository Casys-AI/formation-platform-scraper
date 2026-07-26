import 'dotenv/config';
import { authenticate } from '../auth.js';
import { createLogger } from '../utils.js';

const logger = createLogger('debug-screenshot');

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

    logger.info('Taking screenshot...');
    await mcpClient.screenshot({ filename: 'debug-after-5s.png' });

    logger.info('Waiting 10 more seconds...');
    await mcpClient.waitFor({ timeout: 10000 });

    logger.info('Taking second screenshot...');
    await mcpClient.screenshot({ filename: 'debug-after-15s.png' });

    // Check h2 count again
    const h2Count = await mcpClient.evaluate(`document.querySelectorAll('h2').length`);
    logger.info({ h2Count }, 'h2 count after 15 seconds');

    await mcpClient.disconnect();
    logger.info('Done - check debug-after-5s.png and debug-after-15s.png');
  } catch (error) {
    console.error('ERROR:', error);
    process.exit(1);
  }
}

main();
