import { BrowserManager } from '../browser-manager.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Create all MCP tool definitions
 */
export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'navigate',
      description: 'Navigate to a URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'snapshot',
      description: 'Get accessibility snapshot of the current page',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'evaluate',
      description: 'Execute JavaScript in the page context',
      inputSchema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'JavaScript code to execute',
          },
        },
        required: ['script'],
      },
    },
    {
      name: 'fill_form',
      description: 'Fill multiple form fields',
      inputSchema: {
        type: 'object',
        properties: {
          fields: {
            type: 'object',
            description: 'Object with selector: value pairs',
            additionalProperties: {
              type: 'string',
            },
          },
        },
        required: ['fields'],
      },
    },
    {
      name: 'click',
      description: 'Click an element by selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of element to click',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'tabs',
      description: 'Manage browser tabs - list or switch between tabs',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'select'],
            description: 'Action to perform: list (get all tabs) or select (switch to tab)',
          },
          index: {
            type: 'number',
            description: 'Tab index to switch to (only for select action)',
          },
        },
        required: ['action'],
      },
    },
    {
      name: 'wait_for',
      description: 'Wait for text to appear or timeout',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to wait for',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default 30000)',
          },
        },
        required: [],
      },
    },
  ];
}

/**
 * Execute tool by name
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  browserManager: BrowserManager
): Promise<unknown> {
  const page = await browserManager.getPage();

  logger.debug(`Executing tool: ${name}`, args);

  switch (name) {
    case 'navigate': {
      const url = args.url as string;
      logger.info(`📍 Navigating to: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle' });
      return { success: true, url };
    }

    case 'snapshot': {
      logger.info('📷 Getting page snapshot');
      // page.accessibility was removed in recent Playwright; ariaSnapshot() is
      // the modern equivalent and returns the YAML accessibility tree directly.
      const snapshot = await page.locator('body').ariaSnapshot();
      return snapshot;
    }

    case 'evaluate': {
      const script = args.script as string;
      logger.debug('⚡ Evaluating JavaScript');
      const result = await page.evaluate((s) => eval(s), script);
      return { result };
    }

    case 'fill_form': {
      const fields = args.fields as Record<string, string>;
      logger.info(`📝 Filling ${Object.keys(fields).length} form fields`);
      for (const [selector, value] of Object.entries(fields)) {
        // Click to focus field (simulates real user interaction)
        await page.click(selector);
        // Fill the field
        await page.fill(selector, value);
        // Trigger input and change events (important for form validation)
        await page.evaluate((sel) => {
          // @ts-ignore - Code runs in browser context, not Node.js
          const element = document.querySelector(sel);
          if (element) {
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.dispatchEvent(new Event('blur', { bubbles: true }));
          }
        }, selector);
      }
      return { success: true, fieldsCount: Object.keys(fields).length };
    }

    case 'click': {
      const selector = args.selector as string;
      logger.info(`🖱️ Clicking: ${selector}`);
      // Use Promise.all pattern recommended by Playwright docs
      // This ensures waitForNavigation starts BEFORE the click triggers navigation
      try {
        await Promise.all([
          page.waitForNavigation({ timeout: 10000 }).catch(() => {
            // Navigation might not happen, that's ok
            logger.debug('No navigation after click (expected for non-nav clicks)');
          }),
          page.click(selector)
        ]);
        logger.debug('Click completed with navigation');
      } catch (error) {
        // If click itself fails, throw the error
        logger.error(`Click failed: ${error}`);
        throw error;
      }
      return { success: true, selector };
    }

    case 'tabs': {
      const action = args.action as string;
      logger.info(`🪟 Tab management: action=${action}`);

      if (action === 'list') {
        // List all open tabs
        const tabs = await browserManager.listPages();
        logger.info({ tabCount: tabs.length }, `📋 Listed ${tabs.length} tabs`);
        return tabs;
      } else if (action === 'select') {
        // Switch to specific tab by index
        const index = args.index as number;
        if (index === undefined) {
          throw new Error('Tab index is required for select action');
        }
        logger.info({ tabIndex: index }, `🔄 Switching to tab ${index}`);
        await browserManager.switchToPage(index);
        return { success: true, tabIndex: index };
      } else {
        throw new Error(`Unknown tabs action: ${action}`);
      }
    }

    case 'wait_for': {
      const text = args.text as string | undefined;
      const timeout = (args.timeout as number) || 30000;
      if (text) {
        logger.info(`⏳ Waiting for text: "${text}" (timeout: ${timeout}ms)`);
        await page.waitForSelector(`text=${text}`, { timeout });
      } else {
        logger.info(`⏳ Waiting ${timeout}ms`);
        await page.waitForTimeout(timeout);
      }
      return { success: true };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
