# Deploy FFmpeg Service to Railway

## ⚠️ Important: Create GitHub Repo First!

Railway needs the GitHub repository to exist before it can deploy.

---

## Step 1: Create GitHub Repository

### Go to GitHub:
👉 https://github.com/new

### Fill in:
- **Repository name:** `ffmpeg-service`
- **Description:** "FFmpeg video rendering service"
- **Public** or **Private** (your choice)
- **⚠️ DO NOT** check "Add a README file"
- **⚠️ DO NOT** add .gitignore or license

### Click "Create repository"

---

## Step 2: Push Code to GitHub

GitHub will show you commands. Use these:

```bash
cd ffmpeg-service
git init
git add .
git commit -m "FFmpeg video rendering service"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ffmpeg-service.git
git push -u origin main
```

**Replace `YOUR_USERNAME` with your GitHub username!**

---

## Step 3: Deploy on Railway

1. **Go to Railway:**
   - https://railway.app
   - Click "New Project"
   - Select "Deploy from GitHub repo"

2. **Refresh if needed:**
   - Click refresh icon (🔄)
   - Now you should see `ffmpeg-service`!

3. **Select `ffmpeg-service`** and click "Deploy"

4. **Wait 2-3 minutes** for deployment

---

## Step 4: Get Service URL

- Railway Dashboard → Your Service → Settings → Domains
- Copy the URL

---

## Step 5: Add to Main Project

Add to `.env`:
```
FFMPEG_SERVICE_URL=https://your-service.railway.app
```

---

## ✅ Done!

Your FFmpeg service is now live! 🎬

