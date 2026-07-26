# System Dependencies

This scraper requires several system-level tools for media processing.

## Required Tools

### 1. yt-dlp
**Purpose:** Download audio from YouTube/Vimeo and extract video thumbnails

**Version:** 2023.10.22 or later

**Installation:**

```bash
# Ubuntu/Debian
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# macOS (Homebrew)
brew install yt-dlp

# Windows (Chocolatey)
choco install yt-dlp

# Verify
yt-dlp --version
```

### 2. ffmpeg
**Purpose:** Extract video thumbnails and analyze video metadata

**Version:** 4.4 or later

**Installation:**

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y ffmpeg

# macOS (Homebrew)
brew install ffmpeg

# Windows (Chocolatey)
choco install ffmpeg

# Verify
ffmpeg -version
```

### 3. ffprobe
**Purpose:** Extract video metadata (duration, format)

**Version:** Included with ffmpeg

**Installation:** Installed automatically with ffmpeg

```bash
# Verify
ffprobe -version
```

---

## Node.js Dependencies

### OpenAI SDK
**Purpose:** Whisper API for audio transcription

**Version:** ^4.x

**Installation:** Automatic via `pnpm install`

```bash
# Already in package.json
pnpm install
```

**Environment Variable Required:**
```bash
# .env
OPENAI_API_KEY=sk-xxxxx
```

---

## Dependency Check Script

Run this script to verify all dependencies:

```bash
npm run check-deps
```

Or manually:

```bash
# Check all tools
command -v yt-dlp && echo "✅ yt-dlp installed" || echo "❌ yt-dlp missing"
command -v ffmpeg && echo "✅ ffmpeg installed" || echo "❌ ffmpeg missing"
command -v ffprobe && echo "✅ ffprobe installed" || echo "❌ ffprobe missing"

# Check Node packages
npm list openai execa
```

---

## Docker Alternative

If you prefer containerized dependencies, use Docker:

```bash
# Build image with all dependencies
docker build -t scraper-formation .

# Run scraper
docker run -v $(pwd)/output:/app/output scraper-formation
```

See [docker/README.md](../docker/README.md) for details.

---

## Troubleshooting

### yt-dlp not found
```bash
# Add to PATH
export PATH=$PATH:/usr/local/bin

# Or install locally
pip install yt-dlp
```

### ffmpeg not found
```bash
# Check package manager
apt list --installed | grep ffmpeg  # Ubuntu
brew list | grep ffmpeg             # macOS
```

### OpenAI API errors
```bash
# Check API key
echo $OPENAI_API_KEY

# Test API key
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

---

## Optional: Installation Script

Run the automated installer:

```bash
./scripts/install-deps.sh
```

This will detect your OS and install all required dependencies.

---

## Minimum Requirements

- **OS:** Linux (Ubuntu 20.04+), macOS (10.15+), Windows 10+
- **Node.js:** v18+ (v22 recommended)
- **Disk Space:** 2GB for tools + media storage
- **Internet:** Required for downloads and API calls

---

## CI/CD Integration

For automated environments (GitHub Actions, GitLab CI):

```yaml
# .github/workflows/scraper.yml
- name: Install system dependencies
  run: |
    sudo apt update
    sudo apt install -y ffmpeg
    sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
    sudo chmod a+rx /usr/local/bin/yt-dlp
```

See [.github/workflows/scraper.yml](../.github/workflows/scraper.yml) for complete example.
