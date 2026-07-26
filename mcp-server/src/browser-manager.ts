import { Browser, BrowserContext, Page, chromium } from 'playwright';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * BrowserManager - Handles Playwright browser lifecycle
 * Creates and manages a single browser instance with reusable context
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private headless: boolean;

  constructor(headless: boolean = true) {
    this.headless = headless;
  }

  /**
   * Initialize browser, context, and page
   */
  async initialize(): Promise<void> {
    try {
      logger.info('🚀 Starting Playwright browser...');

      this.browser = await chromium.launch({
        headless: this.headless,
        args: this.headless ? ['--disable-blink-features=AutomationControlled'] : [],
      });

      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        acceptDownloads: true,
        bypassCSP: false,
        ignoreHTTPSErrors: false,
        // Cookie and storage persistence options
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
      });

      this.page = await this.context.newPage();
      logger.info('✅ Browser initialized successfully');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
      }, '❌ Failed to initialize browser');
      throw error;
    }
  }

  /**
   * Get current page (lazy initialize if needed)
   */
  async getPage(): Promise<Page> {
    if (!this.page) {
      await this.initialize();
    }
    return this.page!;
  }

  /**
   * Get browser context (for tab management)
   */
  async getContext(): Promise<BrowserContext> {
    if (!this.context) {
      await this.initialize();
    }
    return this.context!;
  }

  /**
   * List all pages/tabs in the browser context
   * Returns array with index, title, and URL for each tab
   */
  async listPages(): Promise<Array<{ index: number; title: string; url: string; isCurrent: boolean }>> {
    const context = await this.getContext();
    const pages = context.pages();

    logger.info({ totalPages: pages.length }, `📑 Listing ${pages.length} browser tabs`);

    const pageInfos = await Promise.all(
      pages.map(async (page, index) => {
        const title = await page.title();
        const url = page.url();
        const isCurrent = page === this.page;

        logger.info({
          index,
          title: title.substring(0, 50),
          url: url.substring(0, 80),
          isCurrent
        }, `Tab ${index}: ${isCurrent ? '(current)' : ''}`);

        return {
          index,
          title,
          url,
          isCurrent
        };
      })
    );

    return pageInfos;
  }

  /**
   * Switch to a specific page/tab by index
   * Updates the internal page reference to the selected tab
   */
  async switchToPage(pageIndex: number): Promise<void> {
    const context = await this.getContext();
    const pages = context.pages();

    logger.info({ pageIndex, totalPages: pages.length }, `🔄 Switching to tab ${pageIndex}`);

    if (pageIndex < 0 || pageIndex >= pages.length) {
      logger.error({ pageIndex, totalPages: pages.length }, `❌ Invalid page index`);
      throw new Error(`Invalid page index ${pageIndex}. Total pages: ${pages.length}`);
    }

    const targetPage = pages[pageIndex];
    this.page = targetPage;

    // Bring the page to front (focus it)
    await targetPage.bringToFront();

    const title = await targetPage.title();
    const url = targetPage.url();

    logger.info({
      pageIndex,
      title: title.substring(0, 50),
      url: url.substring(0, 80)
    }, `✅ Switched to tab ${pageIndex}: "${title}"`);
  }

  /**
   * Close browser and cleanup
   */
  async close(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        logger.info('✅ Browser closed');
      }
    } catch (error) {
      logger.warn('⚠️ Error closing browser:', error);
    }
  }

  /**
   * Check if browser is still alive
   */
  isAlive(): boolean {
    return this.page !== null && !this.page.isClosed();
  }
}
