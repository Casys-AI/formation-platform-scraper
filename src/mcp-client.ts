/**
 * Story 3 Phase 1: MCP Client Wrapper
 *
 * Provides typed wrapper methods for communicating with MCP Playwright server
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createLogger } from './utils.js';
import { TIMEOUTS } from './constants.js';

const logger = createLogger('mcp-client');

/**
 * MCP Client wrapper for Playwright server communication
 * Handles connection, tool calls, and error management
 */
export class MCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  /**
   * Connect to MCP Playwright server via stdio transport
   * Auto-starts the server process
   */
  async connect(): Promise<void> {
    logger.info('🔌 Connecting to MCP Playwright server...');

    try {
      // Start the MCP Playwright server as a subprocess over stdio transport.
      // Reuse the exact Node.js binary running this process (process.execPath) so
      // the child inherits the same runtime version — no hardcoded interpreter path.
      const nodeCommand = process.execPath;

      this.transport = new StdioClientTransport({
        command: nodeCommand,
        args: ['dist/index.js'],
        env: process.env as Record<string, string>,
        // Run from the embedded MCP server directory so it resolves its own deps
        cwd: 'mcp-server',
      });

      // Create MCP client
      this.client = new Client(
        {
          name: 'scraper-formation',
          version: '1.0.0'
        },
        {
          capabilities: {}
        }
      );

      // Connect client to transport
      await this.client.connect(this.transport);

      logger.info('✅ Connected to MCP Playwright server');
    } catch (error) {
      logger.error({ error }, '❌ Failed to connect to MCP server');
      throw new Error(
        `MCP connection failed: ${error instanceof Error ? error.message : String(error)}. ` +
        'Ensure MCP server is built: cd mcp-server && npm run build'
      );
    }
  }

  /**
   * Navigate to a URL and wait for network idle
   */
  async navigate(url: string): Promise<void> {
    this.ensureConnected();

    logger.debug({ url }, '📍 Navigating to URL');

    try {
      await this.client!.callTool({
        name: 'navigate',
        arguments: { url },
      });

      logger.debug({ url }, '✅ Navigation complete');
    } catch (error) {
      logger.error({ url, error }, '❌ Navigation failed');
      throw new Error(`Failed to navigate to ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get accessibility snapshot of current page
   * Returns HTML-like structure for parsing
   */
  async snapshot(): Promise<string> {
    this.ensureConnected();

    logger.debug('📷 Getting page snapshot');

    try {
      const result = await this.client!.callTool({
        name: 'snapshot',
        arguments: {},
      });

      // MCP result.content is an array of content blocks
      const content = (result.content as any)?.[0];
      if (!content || content.type !== 'text') {
        throw new Error('Snapshot returned invalid content');
      }

      logger.debug('✅ Snapshot retrieved');
      return content.text as string;
    } catch (error) {
      logger.error({ error }, '❌ Snapshot failed');
      throw new Error(`Failed to get page snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Execute JavaScript in page context
   * @param script JavaScript code to execute
   * @param options.timeout Timeout in milliseconds (default: TIMEOUTS.EVALUATE_DEFAULT)
   */
  async evaluate(script: string, options: { timeout?: number } = {}): Promise<any> {
    this.ensureConnected();

    const timeout = options.timeout ?? TIMEOUTS.EVALUATE_DEFAULT;
    logger.debug({ script: script.substring(0, 100), timeout }, '⚡ Evaluating JavaScript');

    try {
      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Script evaluation timed out after ${timeout}ms`)), timeout);
      });

      // Race between evaluation and timeout
      const result = await Promise.race([
        this.client!.callTool({
          name: 'evaluate',
          arguments: { script },
        }),
        timeoutPromise
      ]);

      const content = (result as any).content?.[0];
      if (!content || content.type !== 'text') {
        throw new Error('Evaluate returned invalid content');
      }

      // Parse JSON result
      const parsed = JSON.parse(content.text as string);
      logger.debug('✅ Script evaluated');
      return parsed.result;
    } catch (error) {
      logger.error({ error }, '❌ Script evaluation failed');
      throw new Error(`Failed to evaluate script: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fill multiple form fields by selector
   *
   * @param fields Object mapping CSS selectors to values
   * @example
   * await fillForm({
   *   'input[name="email"]': 'user@example.com',
   *   'input[type="password"]': 'password123'
   * })
   */
  async fillForm(fields: Record<string, string>): Promise<void> {
    this.ensureConnected();

    logger.debug({ fieldCount: Object.keys(fields).length }, '📝 Filling form fields');

    try {
      await this.client!.callTool({
        name: 'fill_form',
        arguments: { fields },
      });

      logger.debug({ fieldCount: Object.keys(fields).length }, '✅ Form filled');
    } catch (error) {
      logger.error({ fields: Object.keys(fields), error }, '❌ Form filling failed');
      throw new Error(`Failed to fill form: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Click an element by CSS selector
   */
  async click(selector: string): Promise<void> {
    this.ensureConnected();

    logger.debug({ selector }, '🖱️  Clicking element');

    try {
      await this.client!.callTool({
        name: 'click',
        arguments: { selector },
      });

      logger.debug({ selector }, '✅ Click complete');
    } catch (error) {
      logger.error({ selector, error }, '❌ Click failed');
      throw new Error(`Failed to click ${selector}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Wait for text to appear or timeout
   *
   * @param options.text Text to wait for (optional)
   * @param options.timeout Timeout in milliseconds (default 30000)
   */
  async waitFor(options: { text?: string; timeout?: number } = {}): Promise<void> {
    this.ensureConnected();

    const { text, timeout = 30000 } = options;

    if (text) {
      logger.debug({ text, timeout }, '⏳ Waiting for text');
    } else {
      logger.debug({ timeout }, '⏳ Waiting for timeout');
    }

    try {
      await this.client!.callTool({
        name: 'wait_for',
        arguments: options,
      });

      logger.debug('✅ Wait complete');
    } catch (error) {
      logger.error({ options, error }, '❌ Wait failed');
      throw new Error(`Wait failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Take a screenshot of the current page
   */
  async screenshot(options: { filename?: string } = {}): Promise<void> {
    this.ensureConnected();

    logger.debug({ filename: options.filename }, '📸 Taking screenshot');

    try {
      await this.client!.callTool({
        name: 'take_screenshot',
        arguments: options,
      });

      logger.debug('✅ Screenshot taken');
    } catch (error) {
      logger.error({ error }, '❌ Screenshot failed');
      throw new Error(`Failed to take screenshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * List all open browser tabs
   * Returns array of tab info with index, title, and URL
   */
  async listTabs(): Promise<any[]> {
    this.ensureConnected();

    logger.debug('📑 Listing browser tabs');

    try {
      const result = await this.client!.callTool({
        name: 'tabs',
        arguments: { action: 'list' },
      });

      const content = (result.content as any)?.[0];
      if (!content || content.type !== 'text') {
        throw new Error('listTabs returned invalid content');
      }

      // Parse the tabs info from response
      const tabs = JSON.parse(content.text);
      logger.debug({ tabCount: tabs.length }, '✅ Tabs listed');

      tabs.forEach((tab: any, idx: number) => {
        logger.info({
          index: idx,
          title: tab.title?.substring(0, 50),
          url: tab.url?.substring(0, 80)
        }, `📑 Tab ${idx}`);
      });

      return tabs;
    } catch (error) {
      logger.error({ error }, '❌ Failed to list tabs');
      throw new Error(`Failed to list tabs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Switch to a specific browser tab by index
   * @param tabIndex 0-based index of the tab to switch to
   */
  async switchTab(tabIndex: number): Promise<void> {
    this.ensureConnected();

    logger.info({ tabIndex }, '🔄 Switching to tab');

    try {
      const result = await this.client!.callTool({
        name: 'tabs',
        arguments: {
          action: 'select',
          index: tabIndex
        },
      });

      logger.info({ tabIndex }, '✅ Switched to tab');

      // Log the new active tab info
      const content = (result.content as any)?.[0];
      if (content && content.type === 'text') {
        try {
          const tabInfo = JSON.parse(content.text);
          logger.info({
            title: tabInfo.title?.substring(0, 50),
            url: tabInfo.url?.substring(0, 80)
          }, '📍 Now on tab');
        } catch {
          // Ignore parse errors for tab info
        }
      }
    } catch (error) {
      logger.error({ tabIndex, error }, '❌ Failed to switch tab');
      throw new Error(`Failed to switch to tab ${tabIndex}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Disconnect from MCP server and clean up resources
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      logger.info('🔌 Disconnecting from MCP server');
      await this.client.close();
      this.client = null;
    }
    if (this.transport) {
      // Transport cleanup is handled by client.close()
      this.transport = null;
    }
    logger.info('✅ Disconnected from MCP server');
  }

  /**
   * Ensure client is connected before making calls
   * @throws Error if not connected
   */
  private ensureConnected(): void {
    if (!this.client) {
      throw new Error('MCP client not connected. Call connect() first.');
    }
  }
}
