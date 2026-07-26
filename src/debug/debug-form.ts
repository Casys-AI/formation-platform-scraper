/**
 * Debug script to inspect the login form structure
 */
import 'dotenv/config';
import { authenticate } from '../auth.js';
import { MCPClient } from '../mcp-client.js';
import { createLogger } from '../utils.js';

const logger = createLogger('debug-form');

async function debugForm() {
  const email = process.env.FORMATION_EMAIL;
  const password = process.env.FORMATION_PASSWORD;
  const formationUrl = process.env.FORMATION_URL;

  if (!email || !password) {
    throw new Error('FORMATION_EMAIL and FORMATION_PASSWORD must be set in .env');
  }
  if (!formationUrl) {
    throw new Error('FORMATION_URL must be set in .env');
  }

  logger.info('🔍 Inspecting login form structure');

  const mcpClient = new MCPClient();
  await mcpClient.connect();

  // Navigate to login page
  const loginUrl = `${new URL(formationUrl).origin}/connexion`;
  await mcpClient.navigate(loginUrl);
  await mcpClient.waitFor({ timeout: 5000 });

  // Inspect form structure - step by step
  logger.info('📋 Checking if form exists');
  const hasForm = await mcpClient.evaluate('!!document.querySelector("form")');
  logger.info({ hasForm }, 'Form exists?');

  if (hasForm) {
    logger.info('📋 Getting form action');
    const action = await mcpClient.evaluate('document.querySelector("form").action');
    logger.info({ action }, 'Form action');

    logger.info('📋 Getting form method');
    const method = await mcpClient.evaluate('document.querySelector("form").method');
    logger.info({ method }, 'Form method');

    logger.info('📋 Counting inputs');
    const inputCount = await mcpClient.evaluate('document.querySelectorAll("form input").length');
    logger.info({ inputCount }, 'Input count');

    logger.info('📋 Counting buttons');
    const buttonCount = await mcpClient.evaluate('document.querySelectorAll("form button").length');
    logger.info({ buttonCount }, 'Button count');

    logger.info('📋 Getting submit button type');
    const submitBtnType = await mcpClient.evaluate('document.querySelector("button[type=submit]")?.type || "not found"');
    logger.info({ submitBtnType }, 'Submit button');
  }

  await mcpClient.disconnect();
}

debugForm().catch((error) => {
  logger.error({ error }, '❌ Debug failed');
  process.exit(1);
});
