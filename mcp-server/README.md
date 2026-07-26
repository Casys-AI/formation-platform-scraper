# MCP Playwright Server

A reusable Model Context Protocol (MCP) server that provides browser automation tools via Playwright. Designed for CASYS and other tools that need headless browser capabilities.

## Features

- **Single browser instance** - Reuses page context across multiple client connections
- **Persistent cookies** - Maintains authenticated sessions across requests
- **Stdio transport** - Lightweight stdio-based communication with clients
- **Essential tools** - navigate, snapshot, evaluate, fill_form, click, tabs, wait_for
- **Error handling** - Graceful error handling and recovery

## Installation

```bash
cd mcp-server
npm install
npm run build
```

## Usage

### Start the server

```bash
# Run in stdio mode (default, used by clients)
npm start

# Or with environment variables
PLAYWRIGHT_HEADLESS=true npm start

# Development mode with hot reload
npm run dev
```

### Use from client (e.g., scraper)

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Start MCP server in subprocess
const transport = new StdioClientTransport({
  command: 'node',
  args: ['mcp-server/dist/index.js'],
});

const client = new Client(
  { name: 'scraper-app', version: '1.0.0' },
  { capabilities: {} }
);

await client.connect(transport);

// Use tools
await client.callTool({
  name: 'navigate',
  arguments: { url: 'https://example.com' },
});

const snapshot = await client.callTool({
  name: 'snapshot',
  arguments: {},
});
```

## Available Tools

### navigate(url: string)
Navigate to a URL and wait for network idle.

```json
{
  "name": "navigate",
  "arguments": { "url": "https://example.com" }
}
```

### snapshot()
Get accessibility snapshot of current page (useful for HTML parsing).

```json
{
  "name": "snapshot",
  "arguments": {}
}
```

### evaluate(script: string)
Execute JavaScript in page context.

```json
{
  "name": "evaluate",
  "arguments": {
    "script": "document.querySelectorAll('a').length"
  }
}
```

### fill_form(fields: Record<string, string>)
Fill multiple form fields at once.

```json
{
  "name": "fill_form",
  "arguments": {
    "fields": {
      "#email": "user@example.com",
      "#password": "secret123"
    }
  }
}
```

### click(selector: string)
Click an element by CSS selector.

```json
{
  "name": "click",
  "arguments": { "selector": "button[type=submit]" }
}
```

### tabs(action: 'list' | 'select', index?: number)
Manage browser tabs - list all open tabs or switch to a specific tab by index.

```json
{
  "name": "tabs",
  "arguments": { "action": "list" }
}
```

```json
{
  "name": "tabs",
  "arguments": { "action": "select", "index": 1 }
}
```

### wait_for(text?: string, timeout?: number)
Wait for text to appear or timeout.

```json
{
  "name": "wait_for",
  "arguments": {
    "text": "Loading complete",
    "timeout": 5000
  }
}
```

## Configuration

### Environment Variables

- `PLAYWRIGHT_HEADLESS` - Run in headless mode (default: true)
- `LOG_LEVEL` - Pino log level (debug, info, warn, error) (default: info)

## Architecture

```
MCP Playwright Server
  ├── BrowserManager
  │   └── Playwright Browser (Chromium)
  │       └── BrowserContext (cookies, auth)
  │           └── Page (current page)
  └── Tools
      ├── navigate
      ├── snapshot
      ├── evaluate
      ├── fill_form
      ├── click
      ├── tabs
      └── wait_for
```

## Limitations

- **Single page context** - Only one page at a time. Subsequent navigation replaces previous page.
- **No multi-tab** - Current implementation focuses on single-page workflows
- **Accessibility snapshot only** - Uses accessibility API for HTML parsing (not full DOM)

## Future Enhancements

- [ ] HTTP server mode (in addition to stdio)
- [ ] Multiple page/tab support
- [ ] Video recording
- [ ] HAR file capture
- [ ] Screenshot tool
- [ ] Better DOM selector support

## Development

```bash
# Watch and rebuild
npm run build -- --watch

# Type check
npx tsc --noEmit
```

## License

MIT
