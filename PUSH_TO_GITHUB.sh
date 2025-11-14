#!/bin/bash
# Push FFmpeg Service to GitHub

echo "🚀 Setting up FFmpeg Service GitHub Repository"
echo ""

# Check if git is initialized
if [ ! -d ".git" ]; then
    echo "Initializing git repository..."
    git init
fi

# Add all files
echo "Adding files..."
git add .

# Commit
echo "Committing..."
git commit -m "FFmpeg video rendering service"

# Set main branch
git branch -M main

echo ""
echo "✅ Ready to push!"
echo ""
echo "Next steps:"
echo "1. Create repository on GitHub: https://github.com/new"
echo "   - Name: ffmpeg-service"
echo "   - DO NOT initialize with README"
echo ""
echo "2. Then run:"
echo "   git remote add origin https://github.com/YOUR_USERNAME/ffmpeg-service.git"
echo "   git push -u origin main"
echo ""
echo "Or use GitHub CLI:"
echo "   gh repo create ffmpeg-service --public --source=. --remote=origin --push"

