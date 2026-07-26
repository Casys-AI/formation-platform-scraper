/**
 * Authentication logic for Teachizy-hosted formation platforms.
 *
 * A Teachizy formation is served on the school's own domain
 * (e.g. formations.<school>.<tld>). Authentication is a single, direct login on
 * that domain — the credentials are the ones you use to access the formation.
 * Nothing about a specific tenant is hardcoded: the login URL is derived from
 * the formation URL passed in by the caller.
 */

import { MCPClient } from './mcp-client.js';
import { createLogger, retry, redactEmail } from './utils.js';

const logger = createLogger('auth');

/**
 * Authentication configuration: the credentials used to access the formation.
 */
export interface AuthConfig {
  email: string;
  password: string;
}

/**
 * Derive the login URL of the formation's domain from its URL.
 *
 * @param formationUrl e.g. "https://formations.example.academy/mon-espace/formations/my-course"
 * @returns the login URL, e.g. "https://formations.example.academy/connexion"
 * @throws Error if the URL is not a valid absolute URL
 */
function deriveLoginUrl(formationUrl: string): string {
  try {
    return `${new URL(formationUrl).origin}/connexion`;
  } catch {
    throw new Error(
      `Invalid formation URL: "${formationUrl}". Expected an absolute URL like ` +
        'https://formations.<school>.<tld>/mon-espace/formations/<course-slug>'
    );
  }
}

/**
 * Authenticate against a Teachizy-hosted formation and return an authenticated
 * MCP client with a persistent session.
 *
 * Flow:
 * 1. Navigate to the formation's login page.
 * 2. If already authenticated (not redirected to /connexion), we're done.
 * 3. Otherwise fill the login form and submit.
 *
 * @param config The formation credentials.
 * @param formationUrl URL of the formation to scrape. Its origin is used to
 *   build the login URL and verify the authenticated state.
 * @returns Authenticated MCPClient instance.
 * @throws Error if authentication fails after retries.
 */
export async function authenticate(config: AuthConfig, formationUrl: string): Promise<MCPClient> {
  const loginUrl = deriveLoginUrl(formationUrl);

  logger.info({ email: redactEmail(config.email), loginUrl }, '🔐 Starting authentication');

  // Validate credentials
  if (!config.email || !config.password) {
    throw new Error('Formation email and password are required');
  }

  const mcpClient = new MCPClient();

  // Connect ONCE - preserve cookies across requests
  logger.info('🔌 Connecting to MCP Playwright server');
  await mcpClient.connect();

  await retry(
    async () => {
      // Step 1: Navigate to the formation's login page
      logger.info({ loginUrl }, '📍 Navigating to formation login');
      await mcpClient.navigate(loginUrl);
      await mcpClient.waitFor({ timeout: 2000 });

      // Step 2: If a previous session is still active, we may already be past login
      const initialUrl = await mcpClient.evaluate('window.location.href');
      if (!initialUrl.includes('/connexion')) {
        logger.info({ initialUrl }, '✅ Already authenticated (no login required)');
        return;
      }

      // Step 3: Fill the login form
      logger.info({ email: redactEmail(config.email) }, '📝 Filling login form');
      await mcpClient.fillForm({
        'input[type="email"]': config.email,
        'input[type="password"]': config.password,
      });

      // Step 4: Submit
      logger.info('🖱️  Clicking Se connecter');
      await mcpClient.click('button[type="submit"]');

      // Step 5: Wait for redirect after login
      logger.info('⏳ Waiting for redirect after login');
      await mcpClient.waitFor({ timeout: 5000 });

      // Step 6: Verify we're no longer on the login page
      const afterLoginUrl = await mcpClient.evaluate('window.location.href');
      logger.info({ afterLoginUrl }, '📍 Current URL after login');

      if (afterLoginUrl.includes('/connexion')) {
        throw new Error('Authentication failed - still on login page. Check credentials.');
      }

      logger.info('✅ Authentication successful');
    },
    {
      retries: 2,
      delay: 3000,
      backoff: 2,
    }
  );

  return mcpClient;
}

/**
 * Verify authentication by checking access to a protected page.
 *
 * @param mcpClient Authenticated MCP client.
 * @param formationUrl A protected formation URL to probe.
 * @returns true if navigation succeeds without landing on the login page.
 */
export async function verifyAuthentication(
  mcpClient: MCPClient,
  formationUrl: string
): Promise<boolean> {
  logger.info('🔍 Verifying authentication');

  try {
    await mcpClient.navigate(formationUrl);
    await mcpClient.waitFor({ timeout: 5000 });

    const currentUrl = await mcpClient.evaluate('window.location.href');
    if (currentUrl.includes('/connexion')) {
      logger.error({ currentUrl }, '❌ Authentication verification failed (redirected to login)');
      return false;
    }

    logger.info('✅ Authentication verified');
    return true;
  } catch (error) {
    logger.error({ error }, '❌ Authentication verification failed');
    return false;
  }
}
