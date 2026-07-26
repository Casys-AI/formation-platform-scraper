#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import { BrowserManager } from './browser-manager.js';
import { getToolDefinitions, executeTool } from './tools/index.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Create MCP server
const server = new Server(
  {
    name: 'mcp-playwright',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Initialize browser manager
const browserManager = new BrowserManager(
  process.env.PLAYWRIGHT_HEADLESS !== 'false'
);

/**
 * Handle ListTools request
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.debug('📋 Listing available tools');
  return {
    tools: getToolDefinitions(),
  };
});

/**
 * Handle CallTool request
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    logger.info(`🔧 Tool called: ${name}`);

    const result = await executeTool(name, args as Record<string, unknown>, browserManager);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    logger.error('❌ Tool execution failed:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // Initialize browser on startup
    await browserManager.initialize();

    // Connect to stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('✅ MCP Playwright Server started');
    logger.info('📍 Server connected via stdio');
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    await browserManager.close();
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('🛑 Shutting down...');
  await browserManager.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('🛑 Shutting down...');
  await browserManager.close();
  process.exit(0);
});

// Run server
main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
