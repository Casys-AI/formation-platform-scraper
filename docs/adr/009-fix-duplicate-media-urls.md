# ADR 009: Fix Dual-Process Race Condition

**Date:** 2025-11-09
**Status:** Implemented (Replaces incorrect hypothesis)
**Deciders:** Development Team

## Context

Lesson 1022471 consistently showed "Media: 2/3 transcribed" despite having 3 unique videos in the DOM. Initial hypothesis was that the DOM contained duplicate URLs, but **Playwright verification proved this false**. Investigation revealed the true cause: **two separate Node.js processes were running the extraction simultaneously**.

## The Bug

### Symptoms

1. **Duplicate logs in console** - Same log messages appearing twice with identical timestamps
2. **MP4 conversion failures** - "MP4 file not found" errors during media processing
3. **Partial media processing** - Reports showing "2/3 transcribed" instead of "3/3"
4. **Race condition on file operations** - One process deleting files while another tried to access them

### Initial False Hypothesis ❌

Originally hypothesized that Teachizy displayed the same video multiple times in the DOM (e.g., once in main content, once in summary box), causing duplicate URLs to be extracted.

**Verification with Playwright:**
```javascript
// Used Playwright to check actual DOM content
await page.goto('https://formations.example.academy/.../lesson/1022471');
const videos = await page.$$('video source');

Result:
✅ 3 unique <video> elements found
✅ Each video has a unique URL
✅ NO duplicates in DOM
```

**Conclusion:** The DOM extraction was correct. The problem was NOT duplicate URLs.

### Root Cause Discovery ✅

Added debug logging to track media processing:

```typescript
export function deduplicateMedia(media: MediaContent[]): MediaContent[] {
  logger.info(
    { inputCount: media.length, urls: media.map(m => m.url) },
    '🔍 [DEBUG] deduplicateMedia() - INPUT'
  );
  // ... deduplication logic ...
}
```

**Debug logs revealed TWO processes running in parallel:**

```
[08:11:46] 🔍 [DEBUG] deduplicateMedia() - INPUT: 3 media items (Process 1)
[08:11:46] 🎬 [DEBUG] Processing media 03c74e9f (Process 1)
[08:11:47] 📥 Downloaded 03c74e9f.mp4 (Process 1)
[08:11:51] 🎵 Converted to MP3 (Process 1)
[08:11:51] 🗑️  Deleted original MP4 (Process 1)

[08:11:47] 🔍 [DEBUG] deduplicateMedia() - INPUT: 3 media items (Process 2 - parallel!)
[08:11:47] 🎬 [DEBUG] Processing media 03c74e9f (Process 2)
[08:11:51] ❌ ERROR: MP4 file not found! (Process 1 already deleted it)
```

### The Real Problem

The CLI architecture had a fundamental flaw - spawning extract.ts as a separate process:

```typescript
// cli.ts (BEFORE - THE BUG)
async function extractCommand() {
  await execa('npx', ['tsx', 'src/cli/extract.ts'], { stdio: 'inherit' });
}

// extract.ts (BEFORE)
async function main() {
  // ... extraction logic
}

main(); // Auto-executed at module level
```

**What was happening:**

1. User runs `pnpm extract`
2. `cli.ts` spawns `extract.ts` as a **separate process** via `execa()`
3. `extract.ts` auto-executes `main()` when imported/run
4. Both processes share same stdout (due to `stdio: 'inherit'`)
5. Both processes attempt to download/convert/delete the same media files **simultaneously**

**Race condition timeline:**

```
Process 1:                          Process 2:
─────────────────────────────────   ───────────────────────────────────
08:11:46 - Start extraction         08:11:47 - Start extraction
08:11:46 - Download 03c74e9f.mp4
08:11:47 - Convert to MP3           08:11:47 - Try to download 03c74e9f.mp4
08:11:51 - Delete MP4 ✅
                                    08:11:51 - Try to convert MP4 ❌ NOT FOUND!
```

## Decision

**Refactor to single-process architecture** by making `extract.ts` callable as a function instead of spawning it as a separate process.

### Solution: Three Changes

#### 1. Export main() from extract.ts

```typescript
// extract.ts (AFTER - THE FIX)
export async function main(configPath?: string) {
  try {
    const finalConfigPath = configPath || process.argv[2] || 'extraction-config.json';
    const config = loadConfig(finalConfigPath);
    // ... rest of extraction logic
  }
}

// Note: main() is no longer auto-executed here.
// It's now called from cli.ts when the 'extract' command is used.
```

**Key changes:**
- Made `main()` exported so it can be imported from other modules
- Added optional `configPath` parameter to allow explicit config path
- **Removed module-level `main()` call** that was auto-executing

#### 2. Import and call main() directly in cli.ts

```typescript
// cli.ts (AFTER - THE FIX)
import { main as extractMain } from './extract.js';

async function extractCommand() {
  try {
    await extractMain('extraction-config.json');  // Direct function call
  } catch (error) {
    UI.error(`Failed to extract: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
```

**Key changes:**
- Import `main()` as `extractMain()` from extract.ts
- **Call it directly** instead of spawning with `execa()`
- Pass config path explicitly

#### 3. Add logger caching in utils.ts

```typescript
// utils.ts (AFTER - PREVENT DUPLICATE LOGGERS)
const loggerCache = new Map<string, pino.Logger>();

/**
 * Create a logger instance with triple output: console + file + Loki
 * Uses caching to ensure only one logger per name
 */
export function createLogger(name: string) {
  // Return cached logger if exists
  if (loggerCache.has(name)) {
    return loggerCache.get(name)!;
  }

  const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    name,
  }, pino.transport({ targets }));

  // Cache the logger
  loggerCache.set(name, logger);

  return logger;
}
```

**Key changes:**
- Added `loggerCache` Map to store logger instances by name
- Prevents duplicate logger instances even if createLogger() is called multiple times
- Ensures consistent logging without duplicates

## Consequences

### Positive

- ✅ **Eliminates race conditions** - Only one execution path through the code
- ✅ **Cleaner logs** - No duplicate log messages from parallel processes
- ✅ **Better error handling** - Errors propagate through normal function calls
- ✅ **Easier debugging** - Single call stack to trace
- ✅ **Lower resource usage** - One process instead of two
- ✅ **Correct media processing** - All 3 videos transcribed successfully

### Negative

- ⚠️ **Different process.argv behavior** - Command name appears in argv instead of config path
- ⚠️ **Explicit config paths required** - Must pass config path instead of relying on argv
- ⚠️ **Module-level side effects** - Must avoid module-level code execution

### Trade-offs

**Before (Multi-process):**
- Pros: Process isolation
- Cons: Race conditions, duplicate logs, higher resource usage

**After (Single-process):**
- Pros: No race conditions, clean logs, efficient
- Cons: Must be careful with module-level code

## Verification

To verify the fix works:

```bash
# Clean test with lesson 1022471
cd tools/scraper-formation
pnpm extract

# Expected results:
# - No duplicate log messages
# - All 3 videos transcribed successfully
# - No MP4 conversion errors
# - Report shows "Media: 3/3 transcribed"
```

**Success criteria:**
1. Single set of log messages (not duplicated)
2. All 3 media files processed without errors
3. All 3 transcriptions completed
4. No "MP4 file not found" errors

## Files Changed

1. **[cli.ts:14,99-105](../../src/cli/cli.ts)** - Import and call extractMain() directly instead of spawning process
2. **[extract.ts:23,672](../../src/cli/extract.ts)** - Export main(), remove auto-execution
3. **[utils.ts:16-26,64-70](../../src/utils.ts)** - Add logger caching to prevent duplicates

## Related ADRs

- **ADR-007**: Fix S3 Media File Collision Bug (hash-based unique filenames)
- **ADR-008**: Fix Transcription Race Condition (moved MP4→MP3 conversion before transcription)

## Lessons Learned

1. **Verify assumptions with tools** - Using Playwright to check the DOM was crucial to ruling out duplicate URLs
2. **Debug logging reveals process behavior** - Adding debug logs exposed the dual-process issue
3. **Process spawning has hidden costs** - `execa()` with `stdio: 'inherit'` creates shared stdout and parallel execution
4. **Module-level side effects are dangerous** - Auto-executing code at import time leads to unexpected behavior
5. **Single-process architecture is simpler** - Direct function calls are easier to understand and debug than process spawning
6. **False hypotheses waste time** - Don't assume - verify with tools before implementing fixes

## Architecture Decision

**Adopt single-process architecture** for all CLI commands:
- CLI entry point (`cli.ts`) imports and calls functions directly
- Command implementation files (`extract.ts`, etc.) export their main functions
- No auto-execution at module level
- No process spawning with `execa()` for internal commands

This pattern should be applied to all future CLI commands.

## Notes

This completes the race condition fixes:
1. **ADR-007**: Different S3 videos in same lesson → unique filenames (hash-based)
2. **ADR-008**: Parallel transcription processes → sequential MP4→MP3 conversion
3. **ADR-009**: ~~Duplicate URLs from DOM~~ → **Dual-process race condition** (THIS ADR - corrected)
