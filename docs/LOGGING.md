# Logging System

The scraper has a **dual logging system** for both real-time monitoring and post-analysis.

---

## 🎯 Features

### ✅ Option 1: Automatic File Logging (Always Active)

**All logs are automatically saved** to `output/logs/scraper-YYYY-MM-DD.log`

- **Console**: Pretty, colorized output for real-time monitoring
- **File**: JSON format for analysis with `grep`, `jq`, etc.

**Example:**
```bash
# Run scraper - logs automatically saved
npx tsx src/cli/extract.ts dry-run-config.json

# Analyze logs afterward
grep -i error output/logs/scraper-2025-11-06.log
grep "YouTube download error" output/logs/*.log | wc -l
```

---

### 🎨 Option 2: Web Dashboard (Optional)

**Real-time log visualization** in a web browser with filters and search.

#### Installation (One-time)
```bash
pnpm add -g pino-noir
```

#### Usage
```bash
# Pipe logs to dashboard
npx tsx src/cli/extract.ts dry-run-config.json | pino-noir

# Or view existing log file
cat output/logs/scraper-2025-11-06.log | pino-noir
```

**Dashboard opens at:** `http://localhost:3000`

**Features:**
- 🔍 Full-text search across all logs
- 🎯 Filter by level (info, warn, error)
- 📊 Timeline view
- 🏷️ Filter by logger name (media-handler, extractor, etc.)

---

## 📂 Log File Structure

```
output/logs/
├── scraper-2025-11-06.log  (Today's logs, JSON format)
├── scraper-2025-11-05.log  (Yesterday's logs)
└── scraper-2025-11-04.log  (Older logs)
```

**Each log entry contains:**
```json
{
  "level": 50,
  "time": 1699289421000,
  "name": "media-handler",
  "msg": "❌ YouTube download error (3/5)",
  "consecutiveErrors": 3,
  "threshold": 5
}
```

---

## 🔍 Common Log Analysis Commands

### Count errors by type
```bash
# YouTube errors
grep "YouTube download error" output/logs/scraper-*.log | wc -l

# Whisper errors
grep "Transcription failed" output/logs/scraper-*.log | wc -l

# All errors
grep '"level":50' output/logs/scraper-*.log | wc -l
```

### Find specific lessons with errors
```bash
# Using jq (install: apt install jq)
cat output/logs/scraper-2025-11-06.log | \
  jq 'select(.level == 50 and .lessonId) | {lessonId, msg}'
```

### Extract error messages
```bash
grep '"level":50' output/logs/scraper-*.log | \
  jq -r '.msg' | \
  sort | uniq -c | sort -rn
```

---

## 🔔 Advanced: Better Stack (Cloud Monitoring)

For production monitoring with alerts:

```bash
pnpm add @logtail/pino
```

Then add to `src/utils.ts`:
```typescript
{
  target: '@logtail/pino',
  options: {
    sourceToken: process.env.BETTERSTACK_TOKEN,
  },
}
```

**Features:**
- 🔔 Real-time alerts (email/Slack)
- 📊 Dashboard with graphs
- 💾 Long-term retention
- 🔍 Full-text search

**Free tier**: 1GB logs/month

---

## 📝 Log Levels

- **10 (trace)**: Very detailed debugging
- **20 (debug)**: Debugging information
- **30 (info)**: General information (default)
- **40 (warn)**: Warning messages
- **50 (error)**: Error messages
- **60 (fatal)**: Fatal errors

**Change log level:**
```bash
LOG_LEVEL=debug npx tsx src/cli/extract.ts dry-run-config.json
```

---

## 🧹 Log Cleanup

Logs are kept indefinitely. To clean up old logs:

```bash
# Delete logs older than 30 days
find output/logs -name "scraper-*.log" -mtime +30 -delete

# Or archive them
tar -czf logs-archive-$(date +%Y-%m).tar.gz output/logs/*.log
rm output/logs/scraper-*.log
```
