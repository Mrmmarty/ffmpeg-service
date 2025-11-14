# FFmpeg Video Rendering Service

Professional video rendering service with proper transitions, text overlays, and audio mixing.

## 🚀 Quick Deploy to Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "FFmpeg video rendering service"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ffmpeg-service.git
git push -u origin main
```

### 2. Deploy on Railway

1. Go to https://railway.app
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select `ffmpeg-service`
5. Wait 2-3 minutes for deployment
6. Copy the service URL from Settings → Domains

### 3. Add to Main Project

Add to `.env`:
```
FFMPEG_SERVICE_URL=https://your-service.railway.app
```

**Done!** 🎬

## Features

- ✅ Professional Transitions (fade, crossfade, wipe, zoom, slide)
- ✅ Text Overlays (dynamic positioning and styling)
- ✅ Audio Mixing (perfect sync)
- ✅ High Quality (H.264, 30 FPS)

## API

### POST /render

Render video from images with transitions and audio.

**Request:**
```json
{
  "segments": [
    {
      "imageUrl": "https://example.com/image.jpg",
      "duration": 3,
      "textOverlay": "2020 BMW 3 Series",
      "type": "opener"
    }
  ],
  "audioUrl": "https://example.com/audio.mp3",
  "options": {
    "transitionType": "crossfade",
    "transitionDuration": 0.5
  }
}
```

**Response:**
```json
{
  "success": true,
  "videoUrl": "data:video/mp4;base64,...",
  "videoSize": 1234567,
  "duration": 3
}
```

### GET /health

Health check endpoint.

## Local Development

```bash
npm install
npm run dev
```

Service runs on http://localhost:3001

**Note:** Requires FFmpeg installed locally.

## Cost

- Railway: $5/month base + ~$0.01 per video
- Much cheaper than Cloudinary at scale!
