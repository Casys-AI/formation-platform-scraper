#!/bin/bash
# Check system dependencies for formation-platform-scraper

set -e

echo "🔍 Checking system dependencies..."
echo ""

MISSING_DEPS=()

# Check yt-dlp
if command -v yt-dlp &> /dev/null; then
    VERSION=$(yt-dlp --version)
    echo "✅ yt-dlp installed (version: $VERSION)"
else
    echo "❌ yt-dlp NOT FOUND"
    MISSING_DEPS+=("yt-dlp")
fi

# Check ffmpeg
if command -v ffmpeg &> /dev/null; then
    VERSION=$(ffmpeg -version | head -1 | cut -d' ' -f3)
    echo "✅ ffmpeg installed (version: $VERSION)"
else
    echo "❌ ffmpeg NOT FOUND"
    MISSING_DEPS+=("ffmpeg")
fi

# Check ffprobe
if command -v ffprobe &> /dev/null; then
    VERSION=$(ffprobe -version | head -1 | cut -d' ' -f3)
    echo "✅ ffprobe installed (version: $VERSION)"
else
    echo "❌ ffprobe NOT FOUND"
    MISSING_DEPS+=("ffprobe")
fi

# Check OpenAI API key
if [ -n "$OPENAI_API_KEY" ]; then
    echo "✅ OPENAI_API_KEY is set"
else
    echo "⚠️  OPENAI_API_KEY not set (required for transcription)"
fi

echo ""

# Summary
if [ ${#MISSING_DEPS[@]} -eq 0 ]; then
    echo "🎉 All dependencies installed!"
    exit 0
else
    echo "❌ Missing dependencies: ${MISSING_DEPS[*]}"
    echo ""
    echo "📖 Installation instructions:"
    echo ""
    echo "  Ubuntu/Debian:"
    echo "    sudo apt update && sudo apt install -y ffmpeg"
    echo "    sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp"
    echo "    sudo chmod a+rx /usr/local/bin/yt-dlp"
    echo ""
    echo "  macOS:"
    echo "    brew install ffmpeg yt-dlp"
    echo ""
    echo "  Or run automated installer:"
    echo "    ./scripts/install-deps.sh"
    echo ""
    exit 1
fi
