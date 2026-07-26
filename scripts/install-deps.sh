#!/bin/bash
# Automated installation of system dependencies for formation-platform-scraper

set -e

echo "🚀 Installing system dependencies for formation-platform-scraper..."
echo ""

# Detect OS
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
    echo "🐧 Detected: Linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
    echo "🍎 Detected: macOS"
else
    echo "❌ Unsupported OS: $OSTYPE"
    echo "Please install dependencies manually. See docs/DEPENDENCIES.md"
    exit 1
fi

echo ""

# Install dependencies based on OS
if [ "$OS" == "linux" ]; then
    echo "📦 Installing ffmpeg..."
    if ! command -v ffmpeg &> /dev/null; then
        sudo apt update
        sudo apt install -y ffmpeg
        echo "✅ ffmpeg installed"
    else
        echo "✅ ffmpeg already installed"
    fi

    echo ""
    echo "📦 Installing yt-dlp..."
    if ! command -v yt-dlp &> /dev/null; then
        sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
        sudo chmod a+rx /usr/local/bin/yt-dlp
        echo "✅ yt-dlp installed"
    else
        echo "✅ yt-dlp already installed"
    fi

elif [ "$OS" == "macos" ]; then
    # Check if Homebrew is installed
    if ! command -v brew &> /dev/null; then
        echo "❌ Homebrew not found. Please install Homebrew first:"
        echo "   /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        exit 1
    fi

    echo "📦 Installing ffmpeg..."
    if ! command -v ffmpeg &> /dev/null; then
        brew install ffmpeg
        echo "✅ ffmpeg installed"
    else
        echo "✅ ffmpeg already installed"
    fi

    echo ""
    echo "📦 Installing yt-dlp..."
    if ! command -v yt-dlp &> /dev/null; then
        brew install yt-dlp
        echo "✅ yt-dlp installed"
    else
        echo "✅ yt-dlp already installed"
    fi
fi

echo ""
echo "🔍 Verifying installation..."
echo ""

# Verify installations
./scripts/check-deps.sh

echo ""
echo "🎉 All dependencies installed successfully!"
echo ""
echo "⚠️  Don't forget to set your OPENAI_API_KEY in .env:"
echo "   OPENAI_API_KEY=sk-xxxxx"
echo ""
