/**
 * Browser automation wrapper (Playwright, in-process).
 *
 * Drives a single Chromium page directly via Playwright. The public surface
 * (navigate/evaluate/click/fillForm/waitFor/…) is intentionally small and
 * stable so the scraping modules don't care how the browser is driven.
 */

import { chromium, type Browser as PwBrowser, type BrowserContext, type Page } from 'playwright';
import { createLogger } from './utils.js';
import { TIMEOUTS } from './constants.js';

const logger = createLogger('browser');

/**
 * A thin, typed wrapper around a Playwright page with a persistent context
 * (cookies survive across navigations, tabs are supported).
 */
export class Browser {
  private browser: PwBrowser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly headless: boolean;

  constructor() {
    // Visible browser when PLAYWRIGHT_HEADLESS=false, headless otherwise.
    this.headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
  }

  /**
   * Launch Chromium and open a page. Cookies/storage persist for the session.
   */
  async connect(): Promise<void> {
    logger.info('🔌 Launching browser...');
    try {
      this.browser = await chromium.launch({
        headless: this.headless,
        args: this.headless ? ['--disable-blink-features=AutomationControlled'] : [],
      });
      this.context = await this.browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        acceptDownloads: true,
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
      });
      this.page = await this.context.newPage();
      logger.info('✅ Browser ready');
    } catch (error) {
      logger.error({ error }, '❌ Failed to launch browser');
      throw new Error(
        `Browser launch failed: ${error instanceof Error ? error.message : String(error)}. ` +
          'Ensure Playwright browsers are installed: npx playwright install chromium'
      );
    }
  }

  /**
   * Navigate to a URL and wait for the network to settle.
   */
  async navigate(url: string): Promise<void> {
    const page = this.ensureConnected();
    logger.debug({ url }, '📍 Navigating');
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
    } catch (error) {
      logger.error({ url, error }, '❌ Navigation failed');
      throw new Error(`Failed to navigate to ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Return the ARIA accessibility snapshot (YAML) of the current page body.
   */
  async snapshot(): Promise<string> {
    const page = this.ensureConnected();
    logger.debug('📷 Getting page snapshot');
    try {
      return await page.locator('body').ariaSnapshot();
    } catch (error) {
      logger.error({ error }, '❌ Snapshot failed');
      throw new Error(`Failed to get page snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Evaluate a JavaScript expression in the page context and return its result.
   * The script is run via eval() in the browser, matching the previous behavior.
   *
   * @param script JavaScript to evaluate (expression or IIFE).
   * @param options.timeout Timeout in milliseconds (default: TIMEOUTS.EVALUATE_DEFAULT).
   */
  async evaluate(script: string, options: { timeout?: number } = {}): Promise<any> {
    const page = this.ensureConnected();
    const timeout = options.timeout ?? TIMEOUTS.EVALUATE_DEFAULT;
    logger.debug({ script: script.substring(0, 100), timeout }, '⚡ Evaluating JavaScript');

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Script evaluation timed out after ${timeout}ms`)), timeout);
    });

    try {
      // Playwright evaluates a string argument as a JS expression in the page.
      // Our extraction scripts are IIFEs/expressions, so no eval() is needed.
      const result = await Promise.race([
        page.evaluate(script),
        timeoutPromise,
      ]);
      logger.debug('✅ Script evaluated');
      return result;
    } catch (error) {
      logger.error({ error }, '❌ Script evaluation failed');
      throw new Error(`Failed to evaluate script: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fill multiple form fields by selector, firing input/change/blur so client-side
   * validation reacts as it would to a real user.
   *
   * @param fields Object mapping CSS selectors to values.
   */
  async fillForm(fields: Record<string, string>): Promise<void> {
    const page = this.ensureConnected();
    logger.debug({ fieldCount: Object.keys(fields).length }, '📝 Filling form fields');
    try {
      for (const [selector, value] of Object.entries(fields)) {
        await page.click(selector);
        await page.fill(selector, value);
        await page.evaluate((sel: string) => {
          const element = document.querySelector(sel);
          if (element) {
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.dispatchEvent(new Event('blur', { bubbles: true }));
          }
        }, selector);
      }
    } catch (error) {
      logger.error({ fields: Object.keys(fields), error }, '❌ Form filling failed');
      throw new Error(`Failed to fill form: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Click an element by CSS selector, tolerating an optional navigation.
   */
  async click(selector: string): Promise<void> {
    const page = this.ensureConnected();
    logger.debug({ selector }, '🖱️  Clicking element');
    try {
      await Promise.all([
        // Navigation may or may not happen; don't fail the click if it doesn't.
        page.waitForNavigation({ timeout: 10000 }).catch(() => undefined),
        page.click(selector),
      ]);
    } catch (error) {
      logger.error({ selector, error }, '❌ Click failed');
      throw new Error(`Failed to click ${selector}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Wait for text to appear, or for a plain timeout when no text is given.
   *
   * @param options.text Text to wait for (optional).
   * @param options.timeout Timeout in milliseconds (default 30000).
   */
  async waitFor(options: { text?: string; timeout?: number } = {}): Promise<void> {
    const page = this.ensureConnected();
    const { text, timeout = 30000 } = options;
    try {
      if (text) {
        logger.debug({ text, timeout }, '⏳ Waiting for text');
        await page.waitForSelector(`text=${text}`, { timeout });
      } else {
        logger.debug({ timeout }, '⏳ Waiting for timeout');
        await page.waitForTimeout(timeout);
      }
    } catch (error) {
      logger.error({ options, error }, '❌ Wait failed');
      throw new Error(`Wait failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Take a screenshot of the current page.
   */
  async screenshot(options: { filename?: string } = {}): Promise<void> {
    const page = this.ensureConnected();
    logger.debug({ filename: options.filename }, '📸 Taking screenshot');
    try {
      await page.screenshot(options.filename ? { path: options.filename } : {});
    } catch (error) {
      logger.error({ error }, '❌ Screenshot failed');
      throw new Error(`Failed to take screenshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * List all open tabs in the browser context.
   */
  async listTabs(): Promise<Array<{ index: number; title: string; url: string }>> {
    const context = this.ensureContext();
    logger.debug('📑 Listing browser tabs');
    try {
      const pages = context.pages();
      const tabs = await Promise.all(
        pages.map(async (p, index) => ({ index, title: await p.title(), url: p.url() }))
      );
      tabs.forEach((tab) =>
        logger.info(
          { index: tab.index, title: tab.title?.substring(0, 50), url: tab.url?.substring(0, 80) },
          `📑 Tab ${tab.index}`
        )
      );
      return tabs;
    } catch (error) {
      logger.error({ error }, '❌ Failed to list tabs');
      throw new Error(`Failed to list tabs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Switch the active page to a specific tab by index.
   */
  async switchTab(tabIndex: number): Promise<void> {
    const context = this.ensureContext();
    logger.info({ tabIndex }, '🔄 Switching to tab');
    const pages = context.pages();
    if (tabIndex < 0 || tabIndex >= pages.length) {
      throw new Error(`Invalid tab index ${tabIndex}. Total tabs: ${pages.length}`);
    }
    this.page = pages[tabIndex];
    await this.page.bringToFront();
    logger.info({ tabIndex, url: this.page.url().substring(0, 80) }, '✅ Switched to tab');
  }

  /**
   * Close the page, context and browser.
   */
  async disconnect(): Promise<void> {
    logger.info('🔌 Closing browser');
    try {
      await this.context?.close();
      await this.browser?.close();
    } catch (error) {
      logger.warn({ error }, '⚠️ Error while closing browser');
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
    logger.info('✅ Browser closed');
  }

  private ensureConnected(): Page {
    if (!this.page) {
      throw new Error('Browser not connected. Call connect() first.');
    }
    return this.page;
  }

  private ensureContext(): BrowserContext {
    if (!this.context) {
      throw new Error('Browser not connected. Call connect() first.');
    }
    return this.context;
  }
}
