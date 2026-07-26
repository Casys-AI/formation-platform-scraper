# Formation Platform Scraper

A scraper for formations hosted on [Teachizy](https://www.teachizy.fr/), a French course-hosting SaaS. It extracts full lesson content, transcribes embedded media with Whisper, qualifies external links, generates a pedagogical knowledge graph, and exports everything to structured Markdown.

## Features

- **Direct authentication** — logs in on the school's formation domain and keeps the session across requests
- **Course discovery** — extracts the complete course structure (chapters + lessons)
- **Content extraction** — full text, headings, lists, and links per lesson
- **Media transcription** — auto-transcribes YouTube/Vimeo/MP3 media with Whisper, with a bot-detection bypass for datacenter servers
- **AI content formatting** — normalizes and summarizes raw extracted content
- **Link qualification** — AI-powered summaries and quality scores for external links, with broken-link detection and replacement search
- **Knowledge graph** — generates a pedagogical knowledge graph across extracted lessons
- **Checkpoint / resume** — extraction and media processing can resume from where they left off, based on what's already on disk
- **Markdown export** — structured output with YAML frontmatter per lesson

## Prerequisites

- Node.js 18+ (v22 recommended)
- pnpm or npm
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and `ffmpeg`/`ffprobe` on your `PATH` — see [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) for install instructions and a dependency-check script
- An account with access to the formation you want to scrape
- An OpenAI API key (Whisper transcription + AI formatting)

## Installation

This is a standalone repo with **two independent `package.json` files**: the scraper at the root, and the embedded MCP Playwright server under `mcp-server/`. They are not a pnpm/npm workspace — install and build each separately.

```bash
# 1. Install and build the MCP Playwright server (drives the browser)
cd mcp-server
npm install
npm run build
cd ..

# 2. Install and build the scraper
pnpm install   # or: npm install
pnpm build     # or: npm run build
```

The scraper launches the MCP server as a stdio subprocess with `cwd: 'mcp-server'`, so it must already be built (`mcp-server/dist/`) before you run any scraper command.

## Configuration

### Environment variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```bash
# Required
FORMATION_EMAIL=your.email@example.com
FORMATION_PASSWORD=your_password
FORMATION_URL=https://formations.example.academy/mon-espace/formations/my-course
OPENAI_API_KEY=sk-proj-xxx

# Optional
TAVILY_API_KEY=             # Link qualification & broken-link replacement search
```

See [`.env.example`](.env.example) for the full list, including logging and runtime overrides (`PLAYWRIGHT_HEADLESS`, `DELAY_BETWEEN_PAGES_MS`, `DOWNLOAD_MEDIA`, `TRANSCRIBE_MEDIA`). Everything else about extraction behavior is set in `extraction-config.json`.

### Extraction config

The `extract` command reads `extraction-config.json` at the repo root (git-ignored, since it embeds your formation URL). Start from the example:

```bash
cp extraction-config.example.json extraction-config.json
```

```json
{
  "$schema": "./extraction-config.schema.json",
  "formationUrl": "https://formations.example.academy/mon-espace/formations/my-course",
  "mode": "chapters",
  "chapters": [1, 2, 3],
  "rateLimit": { "delayMs": 1000, "enableRateLimit": true },
  "media": { "skipMedia": false, "skipTranscribe": false, "resumeMode": true }
}
```

`extraction-config.schema.json` documents every field (modes: `chapters`, `types`, `all`, `specific-lessons`; media, formatting, anti-detection, and proxy options) and is wired as the `$schema` for editor autocompletion. Similarly:

- `dry-run-config.example.json` → copy to `dry-run-config.json` for a cost-estimation run (counts media, estimates transcription cost, no downloads)
- `link-check-config.example.json` → copy to `link-check-config.json` for the `check-links` command

## Usage (CLI)

The CLI is `tsx src/cli/cli.ts`, exposed via npm scripts:

```bash
# Discover and save the course structure
pnpm discover

# List available chapters from the saved structure
pnpm list-chapters

# Interactively select which chapters to extract (updates extraction-config.json)
pnpm select-chapters

# Run extraction based on extraction-config.json
pnpm extract

# Estimate cost/media count without downloading (dry-run-config.json)
pnpm dry-run

# Check health of all external links in extracted lesson content
pnpm check-links

# Generate a pedagogical knowledge graph from extracted lessons
pnpm knowledge-graph   # alias: pnpm kg

# Generate an extraction status report (output/{course-slug}/REPORT.md)
pnpm report
```

Or use the interactive menu by running the CLI with no arguments:

```bash
pnpm start
```

## YouTube Bot Detection Bypass (Optional)

**Required if extracting YouTube videos from a datacenter server** (AWS, OVH, Oracle, etc.) — since December 2024, YouTube blocks requests from datacenter IPs with `Sign in to confirm you're not a bot`.

### Quick setup

**On your local machine (Windows/Mac/Linux):**

1. **Install Privoxy** (one-time):
   - Windows: https://www.privoxy.org/sf-download-mirror/Win32/
   - Mac: `brew install privoxy && brew services start privoxy`
   - Linux: `sudo apt install privoxy && sudo systemctl start privoxy`

2. **Configure an SSH tunnel** (one-time), in `~/.ssh/config`:
   ```
   Host your-server
     HostName YOUR_SERVER_IP
     User ubuntu
     IdentityFile ~/.ssh/your_key
     RemoteForward 9090 127.0.0.1:8118  # Use 127.0.0.1, not localhost
   ```

3. **Open the tunnel before extraction** (each time): `ssh -N your-server` — keep the terminal open during the run.

4. **Enable the proxy** in `extraction-config.json`:
   ```json
   { "proxy": { "enabled": true, "url": "http://127.0.0.1:9090" } }
   ```

5. **Run extraction** on the server as usual.

### How it works

```
Server (datacenter IP) → SSH tunnel → Your local machine (residential IP) → YouTube ✅
```

Requests route through your residential ISP connection, bypassing bot detection. Vimeo, MP3, and direct/S3-hosted video work without a proxy.

### Troubleshooting

- **"Remote end closed connection without response"** — use `127.0.0.1:8118`, not `localhost:8118`, in `RemoteForward` (IPv4 vs IPv6).
- **"Connection refused"** — verify Privoxy is running (`curl --proxy http://127.0.0.1:8118 https://www.google.com`) and the tunnel is open.

## Output structure

```
output/
└── my-course/
    ├── course-structure.json
    ├── REPORT.md
    ├── chapter-01/
    │   ├── lesson-01-example-lesson.md
    │   ├── lesson-01-example-lesson.json
    │   └── ...
    └── chapter-02/
        └── ...

media/
└── my-course/
    └── chapter-01/
        ├── lesson-01-audio.mp3
        └── ...
```

### Markdown format

```markdown
---
title: "Example Lesson Title"
chapter: 1
chapter_title: "Getting Started"
lesson_id: "1021159"
media:
  - type: youtube
    video_id: "dQw4w9WgXcQ"
    transcription_language: "fr"
links:
  - title: "Reference Guide"
    url: "https://..."
    summary: "..."
    quality_score: 0.92
---

# Example Lesson Title

[Main content]

## Video transcription

[Whisper transcription]

## Resources

### Reference Guide
**Quality:** 92%

[link summary]
```

## Checkpoint & resume

Media downloads and transcriptions track their own completion status on disk. Re-running `pnpm extract` with `media.resumeMode: true` (the default in the example config) skips lessons and media that already completed successfully — interrupting a run is safe, just restart the same command. To force re-processing, delete the relevant `output/`/`media/` subfolder or set `media.resumeMode: false`.

## Development

```bash
# Watch mode
pnpm dev

# Type check
npx tsc --noEmit
```

## Troubleshooting

- **"MCP server not found"** — build it first: `cd mcp-server && npm install && npm run build`.
- **Authentication failed** — check `FORMATION_EMAIL`/`FORMATION_PASSWORD` in `.env`; run with `PLAYWRIGHT_HEADLESS=false` to watch the browser.
- **Whisper API rate limit** — increase `DELAY_BETWEEN_PAGES_MS`, or run in batches and resume later.

## License

MIT — see [`LICENSE`](LICENSE).
