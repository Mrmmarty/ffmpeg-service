/**
 * FFmpeg Video Rendering Service
 * 
 * Deploy this on Railway/Render/Fly.io for professional video rendering
 * with proper transitions, text overlays, and audio mixing.
 */

import express, { Request, Response } from 'express'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { writeFile, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

const execAsync = promisify(exec)

/**
 * Execute FFmpeg command with better error handling and progress logging
 */
async function execFFmpeg(args: string[], workDir: string, jobId: string, timeoutMs: number = 300000): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let hasOutput = false

    ffmpeg.stdout?.on('data', (data) => {
      const output = data.toString()
      stdout += output
      hasOutput = true
      // Log progress lines (frame=...)
      if (output.includes('frame=')) {
        const lines = output.split('\n').filter((l: string) => l.includes('frame='))
        if (lines.length > 0) {
          console.log(`[${jobId}] ${lines[lines.length - 1].trim()}`)
        }
      }
    })

    ffmpeg.stderr?.on('data', (data) => {
      const output = data.toString()
      stderr += output
      hasOutput = true
      // FFmpeg writes progress to stderr
      if (output.includes('frame=') || output.includes('time=')) {
        const lines = output.split('\n').filter((l: string) => l.includes('frame=') || l.includes('time='))
        if (lines.length > 0) {
          console.log(`[${jobId}] ${lines[lines.length - 1].trim()}`)
        }
      }
    })

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGTERM')
      reject(new Error(`FFmpeg command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    ffmpeg.on('close', (code, signal) => {
      clearTimeout(timeout)
      
      if (code === 0) {
        resolve()
      } else {
        const errorMsg = signal 
          ? `FFmpeg process killed by signal: ${signal}` 
          : `FFmpeg exited with code ${code}`
        
        console.error(`[${jobId}] ❌ ${errorMsg}`)
        console.error(`[${jobId}] FFmpeg command: ffmpeg ${args.join(' ')}`)
        
        // Log full stderr (FFmpeg writes errors and progress here)
        if (stderr) {
          const stderrLines = stderr.split('\n').filter((l: string) => l.trim())
          console.error(`[${jobId}] FFmpeg stderr (${stderrLines.length} lines):`)
          // Log last 50 lines of stderr (most relevant errors)
          stderrLines.slice(-50).forEach((line: string) => {
            if (line.trim()) {
              console.error(`[${jobId}]   ${line}`)
            }
          })
        }
        
        if (stdout) {
          const stdoutLines = stdout.split('\n').filter((l: string) => l.trim())
          console.error(`[${jobId}] FFmpeg stdout (${stdoutLines.length} lines):`)
          stdoutLines.slice(-20).forEach((line: string) => {
            if (line.trim()) {
              console.error(`[${jobId}]   ${line}`)
            }
          })
        }
        
        // Extract specific error messages from stderr
        let specificError = ''
        if (stderr) {
          const errorMatch = stderr.match(/Error\s*:\s*(.+)/i) || stderr.match(/error\s*:\s*(.+)/i)
          if (errorMatch) {
            specificError = ` - ${errorMatch[1].trim()}`
          }
        }
        
        reject(new Error(`${errorMsg}${specificError}. ${hasOutput ? 'Check logs above for details.' : 'No output received.'}`))
      }
    })

    ffmpeg.on('error', (error) => {
      clearTimeout(timeout)
      reject(new Error(`Failed to start FFmpeg: ${error.message}`))
    })
  })
}
const app = express()

app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'ffmpeg-video-renderer' })
})

// Render video endpoint
app.post('/render', async (req: Request, res: Response) => {
  const jobId = uuidv4()
  const workDir = `/tmp/ffmpeg-${jobId}`
  
  // Use chunked transfer encoding to keep connection alive
  // This prevents Railway from killing the process
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Transfer-Encoding': 'chunked',
    'Connection': 'keep-alive',
  })
  
  // Send initial response
  res.write(JSON.stringify({
    success: true,
    jobId,
    message: 'Video rendering started',
    status: 'processing',
  }) + '\n')
  
  // Process video and stream updates
  try {
    const result = await processVideoAsync(jobId, workDir, req.body, (update) => {
      // Send progress updates to keep connection alive
      const updateJson = JSON.stringify(update) + '\n'
      res.write(updateJson)
      console.log(`[${jobId}] Sent progress update:`, update.stage || update.progress)
    })
    
    // Send final result - CRITICAL: Must include videoUrl
    const finalResponse = {
      success: true,
      ...result,
      status: 'completed' as const,
    }
    console.log(`[${jobId}] Sending final result:`, {
      success: finalResponse.success,
      status: finalResponse.status,
      hasVideoUrl: !!finalResponse.videoUrl,
      videoSize: finalResponse.videoSize,
      duration: finalResponse.duration,
    })
    
    const finalJson = JSON.stringify(finalResponse) + '\n'
    res.write(finalJson)
    res.end()
    console.log(`[${jobId}] ✓ Final result sent successfully`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[${jobId}] ❌ Error in render endpoint:`, errorMessage)
    const errorResponse = {
      success: false,
      error: errorMessage,
      status: 'failed' as const,
    }
    res.write(JSON.stringify(errorResponse) + '\n')
    res.end()
  }
})

async function processVideoAsync(
  jobId: string, 
  workDir: string, 
  body: any,
  onProgress?: (update: any) => void
) {
  let finalVideoPath: string // Will be set during processing
  let actualAudioDuration: number = 0 // Will be set during processing
  try {
    // Create work directory
    await mkdir(workDir, { recursive: true })
    
    onProgress?.({ stage: 'initializing', progress: 0 })

    const { segments, audioUrl, carData, options, callbackUrl } = body

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      console.error(`[${jobId}] Error: Segments array is required`)
      return
    }

    if (!audioUrl) {
      console.error(`[${jobId}] Error: audioUrl is required`)
      return
    }

    const transitionType = options?.transitionType || 'crossfade'
    const transitionDuration = options?.transitionDuration || 0.5
    // Higher resolution for better quality (4K vertical = 2160x3840, but use 1440x2560 for balance)
    // Using 1080x1920 for now but ensure high quality input
    const width = options?.width || 1080
    const height = options?.height || 1920
    const fps = options?.fps || 30
    // Ensure high quality encoding
    const videoQuality = 'high'

    // Log what we received
    const uniqueImageUrls = new Set(segments.map((s: any) => s.imageUrl))
    console.log(`[${jobId}] ===== FFMPEG SERVICE RECEIVED =====`)
    console.log(`[${jobId}] Total segments: ${segments.length}`)
    console.log(`[${jobId}] Unique images: ${uniqueImageUrls.size}`)
    console.log(`[${jobId}] Segment details:`)
    segments.forEach((seg: any, idx: number) => {
      console.log(`[${jobId}]   ${idx + 1}. ${seg.type} - ${seg.imageUrl?.substring(0, 70) || 'NO URL'}... (${seg.duration?.toFixed(2) || 'N/A'}s)`)
    })
    console.log(`[${jobId}] Transition: ${transitionType}, Duration: ${transitionDuration}s`)
    console.log(`[${jobId}] Dimensions: ${width}x${height}, FPS: ${fps}`)
    console.log(`[${jobId}] ====================================`)

    // Step 1: Download images (in parallel batches to speed up)
    console.log(`[${jobId}] Downloading ${segments.length} images...`)
    onProgress?.({ stage: 'downloading_images', progress: 5 })
    
    const imagePaths: string[] = []
    const downloadPromises: Promise<void>[] = []
    
    // Download images in smaller batches to reduce memory usage
    // Railway has 1GB memory limit, so we need to be conservative
    const batchSize = 3 // Reduced from 5 to save memory
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const imagePath = path.join(workDir, `image-${i}.jpg`)
      imagePaths.push(imagePath) // Reserve slot
      
      const downloadPromise = (async () => {
        try {
          if (!segment.imageUrl) {
            throw new Error(`Segment ${i} has no imageUrl`)
          }
          const response = await fetch(segment.imageUrl)
          if (!response.ok) {
            throw new Error(`Failed to download image ${i}: ${response.status}`)
          }
          const buffer = await response.arrayBuffer()
          const imageBuffer = Buffer.from(buffer)
          await writeFile(imagePath, imageBuffer)
          // Clear buffer to help GC (though Buffer.from creates a copy, this helps)
          console.log(`[${jobId}] ✓ Downloaded image ${i + 1}/${segments.length}`)
          onProgress?.({ stage: 'downloading_images', progress: 5 + Math.round((i + 1) / segments.length * 10) })
          
          // Small delay to prevent overwhelming Railway resources
          await new Promise(resolve => setTimeout(resolve, 100))
        } catch (error) {
          console.error(`[${jobId}] Error downloading image ${i}:`, error)
          throw new Error(`Failed to download image ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      })()
      
      downloadPromises.push(downloadPromise)
      
      // Process in batches
      if (downloadPromises.length >= batchSize || i === segments.length - 1) {
        await Promise.all(downloadPromises)
        downloadPromises.length = 0 // Clear array
      }
    }
    
    console.log(`[${jobId}] Downloaded ${imagePaths.length} images successfully`)
    onProgress?.({ stage: 'images_downloaded', progress: 15 })

    // Step 2: Download audio
    console.log(`[${jobId}] Downloading audio from: ${audioUrl}`)
    onProgress?.({ stage: 'downloading_audio', progress: 20 })
    const audioPath = path.join(workDir, 'audio.mp3')
    try {
      const audioResponse = await fetch(audioUrl)
      if (!audioResponse.ok) {
        throw new Error(`Failed to download audio: ${audioResponse.status} ${audioResponse.statusText}`)
      }
      const contentType = audioResponse.headers.get('content-type') || 'unknown'
      const contentLength = audioResponse.headers.get('content-length')
      console.log(`[${jobId}] Audio response: contentType=${contentType}, size=${contentLength || 'unknown'} bytes`)
      
      const audioBuffer = await audioResponse.arrayBuffer()
      if (!audioBuffer || audioBuffer.byteLength === 0) {
        throw new Error('Downloaded audio file is empty')
      }
      
      await writeFile(audioPath, Buffer.from(audioBuffer))
      console.log(`[${jobId}] ✓ Audio downloaded: ${audioBuffer.byteLength} bytes saved to ${audioPath}`)
      
      // Verify audio file exists and has content
      const fs = await import('fs/promises')
      const stats = await fs.stat(audioPath)
      console.log(`[${jobId}] Audio file verified: ${stats.size} bytes on disk`)
      
      if (stats.size === 0) {
        throw new Error('Audio file is empty after write')
      }
      
      // Get audio duration using ffprobe
      try {
        const audioInfo = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`)
        actualAudioDuration = parseFloat(audioInfo.stdout.trim()) || 0
        console.log(`[${jobId}] Audio duration detected: ${actualAudioDuration.toFixed(2)}s`)
        
        if (actualAudioDuration === 0 || isNaN(actualAudioDuration)) {
          console.warn(`[${jobId}] ⚠️ Invalid audio duration detected: ${audioInfo.stdout}, using estimated duration`)
          actualAudioDuration = segments.reduce((sum, s) => sum + (s.duration || 3), 0)
        }
      } catch (probeError) {
        console.error(`[${jobId}] ⚠️ Failed to probe audio duration:`, probeError)
        // Don't fail here, we'll use estimated duration
        actualAudioDuration = segments.reduce((sum, s) => sum + (s.duration || 3), 0)
        console.log(`[${jobId}] Using estimated duration: ${actualAudioDuration.toFixed(2)}s`)
      }
      
      onProgress?.({ stage: 'audio_downloaded', progress: 25 })
    } catch (error) {
      console.error(`[${jobId}] ❌ Error downloading audio:`, error)
      throw new Error(`Failed to download audio: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

    // Step 3: Create video clips from images with text overlays
    console.log(`[${jobId}] Creating ${segments.length} video clips from ${imagePaths.length} images...`)
    onProgress?.({ stage: 'creating_clips', progress: 30 })
    const clipPaths: string[] = []
    
    for (let i = 0; i < segments.length; i++) {
      onProgress?.({ stage: 'creating_clips', progress: 30 + Math.round((i / segments.length) * 20) })
      const segment = segments[i]
      console.log(`[${jobId}] Processing segment ${i + 1}/${segments.length}: ${segment.imageUrl?.substring(0, 70) || 'NO URL'}...`)
      
      // Process image to fit vertical format (1080x1920) - show MORE of the image
      // Use scale with decrease + pad to show entire image (no cropping)
      // This is especially important for 3:2 aspect ratio images
      const clipPath = path.join(workDir, `clip-${i}.mp4`)
      const duration = segment.duration || 3
      
      // KEN BURNS EFFECT - ALWAYS APPLIED (user requirement: NO STATIC IMAGES)
      // Use ONLY zoompan filter for reliable, smooth zoom effect
      // Simplified implementation that always works
      const startZoom = 1.0
      const endZoom = 1.12 // 12% zoom in (subtle, professional)
      const zoomSpeed = (endZoom - startZoom) / (duration * fps)
      
      // Scale image larger to allow zoom room, then apply zoompan
      // Use decrease+pad to show MORE of the image (especially for 3:2 images)
      // Scale to 120% to allow zoom without showing edges
      const scaleFactor = 1.2
      const scaledWidth = Math.round(width * scaleFactor)
      const scaledHeight = Math.round(height * scaleFactor)
      
      // First scale and pad to show full image (no cropping), then zoom
      // This ensures 3:2 images show more content instead of being cut off
      const kenBurnsFilter = `scale=${scaledWidth}:${scaledHeight}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${scaledWidth}:${scaledHeight}:(ow-iw)/2:(oh-ih)/2:black,zoompan=z='min(zoom+${zoomSpeed.toFixed(6)},${endZoom})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(duration * fps)}:s=${width}x${height}`
      
      console.log(`[${jobId}] Segment ${i + 1}: Applying Ken Burns zoom effect (${startZoom.toFixed(2)}x → ${endZoom.toFixed(2)}x over ${duration.toFixed(2)}s)`)
      
      let videoFilter = kenBurnsFilter
      
      if (segment.textOverlay) {
        // SMART TEXT OVERLAY THAT ALWAYS FITS THE FRAME
        // Simple, reliable approach: Fixed font sizes with character limits
        let fontSize: number
        let maxCharsPerLine: number
        
        if (segment.type === 'opener') {
          fontSize = 42 // Readable but not too large
          maxCharsPerLine = 30 // ~30 chars fit at 42px on 1080px width
        } else if (segment.type === 'cta') {
          fontSize = 52 // Larger for call-to-action
          maxCharsPerLine = 25 // ~25 chars fit at 52px
        } else {
          fontSize = 38 // Standard for features
          maxCharsPerLine = 32 // ~32 chars fit at 38px
        }
        
        // Wrap text to fit character limit per line
        const wrappedText = wrapTextSimple(segment.textOverlay, maxCharsPerLine)
        const lines = wrappedText.split('\n')
        const maxLineLength = Math.max(...lines.map(l => l.length))
        
        // Calculate line spacing and position
        const lineSpacing = Math.max(8, Math.floor(fontSize * 0.2)) // 20% of font size
        const totalTextHeight = (fontSize + lineSpacing) * lines.length - lineSpacing
        let yPosition: string
        
        if (segment.type === 'opener') {
          yPosition = '60' // Top area
        } else if (segment.type === 'cta') {
          yPosition = 'h-th-150' // Bottom area
        } else {
          yPosition = '100' // Middle-top area
        }
        
        // Escape text for FFmpeg drawtext filter
        const escapedText = wrappedText
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
          .replace(/"/g, '\\"')
          .replace(/\(/g, '\\(')
          .replace(/\)/g, '\\)')
          .replace(/\[/g, '\\[')
          .replace(/\]/g, '\\]')
          .replace(/\{/g, '\\{')
          .replace(/\}/g, '\\}')
          .replace(/\n/g, '\\n') // Escape newlines for FFmpeg
        
        // Use textTiming if provided, otherwise show for entire duration
        const textStart = segment.textTiming?.start ?? 0
        const textDuration = segment.textTiming?.duration ?? duration
        const textEnd = Math.min(textStart + textDuration, duration)
        
        // Log text timing and sizing for debugging
        console.log(`[${jobId}] Segment ${i} text overlay: "${wrappedText.substring(0, 60).replace(/\n/g, ' | ')}..." (${lines.length} lines, ${maxLineLength} chars/line, font: ${fontSize}px) timing: ${textStart}s-${textEnd}s`)
        
        // Use modern font (DejaVu Sans Bold for clean, modern look)
        // Modern fonts installed in Docker: DejaVu Sans, Liberation Sans, Noto Sans
        const fontPaths = [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', // DejaVu Sans Bold (modern, clean, bold)
          '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', // Liberation Sans Bold (fallback)
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', // DejaVu Sans Regular (fallback)
        ]
        
        // Check which font is available (for local dev vs Docker)
        let fontfileParam = ''
        try {
          // Try to find an available font
          for (const fontPath of fontPaths) {
            if (existsSync(fontPath)) {
              // Escape font path for FFmpeg (escape colons and special chars)
              const escapedFontPath = fontPath.replace(/:/g, '\\:').replace(/'/g, "\\'")
              fontfileParam = `fontfile='${escapedFontPath}':`
              console.log(`[${jobId}] Using modern font: ${fontPath}`)
              break
            }
          }
          // If no font found, FFmpeg will use system default (still modern on most systems)
          if (!fontfileParam) {
            console.log(`[${jobId}] No custom font found, using FFmpeg default font`)
          }
        } catch (error) {
          // If font check fails, use default (FFmpeg will handle it)
          console.log(`[${jobId}] Font check failed, using default`)
        }
        
        // Use drawtext with modern font and manual wrapping (newlines) to ensure text fits frame
        // fix_bounds=1 ensures text doesn't go outside frame boundaries
        // x=(w-text_w)/2 centers horizontally using actual text width
        // box=1 creates background box that scales with text
        // line_spacing controls spacing between wrapped lines
        // fontfile uses modern DejaVu Sans Bold for clean, professional look
        const textFilter = `drawtext=${fontfileParam}text='${escapedText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPosition}:box=1:boxcolor=black@0.85:boxborderw=14:fix_bounds=1:line_spacing=${lineSpacing}:enable='between(t,${textStart},${textEnd})'`
        videoFilter += `,${textFilter}`
      }

      // Create video clip from image
      // Use HIGH QUALITY settings for better output
      // Use array format to avoid shell escaping issues
      const ffmpegArgs = [
        '-y',
        '-loop', '1',
        '-i', imagePaths[i],
        '-t', duration.toString(),
        '-vf', videoFilter,
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Use ultrafast to minimize memory usage
        '-crf', '23', // Balanced quality
        '-pix_fmt', 'yuv420p',
        '-r', fps.toString(),
        '-threads', '1', // Single thread to save memory
        '-tune', 'fastdecode', // Optimize for faster decoding (saves memory)
        '-movflags', '+faststart', // Enable fast start for web playback
        clipPath,
      ]

      try {
        await execFFmpeg(ffmpegArgs, workDir, jobId, 120000) // 2 min timeout per clip
        clipPaths.push(clipPath)
        console.log(`[${jobId}] ✓ Created clip ${i + 1}/${segments.length}: ${clipPath}`)
        
        // Force garbage collection hint after each clip to free memory
        if (global.gc && i % 3 === 0) {
          global.gc()
        }
      } catch (error) {
        console.error(`[${jobId}] Error creating clip ${i}:`, error)
        throw new Error(`Failed to create clip ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }
    
    console.log(`[${jobId}] ✓ Created ${clipPaths.length} clips (expected ${segments.length})`)
    if (clipPaths.length !== segments.length) {
      console.warn(`[${jobId}] WARNING: Clip count mismatch! Expected ${segments.length}, got ${clipPaths.length}`)
    }
    console.log(`[${jobId}] ✓ Ken Burns effect applied to all ${clipPaths.length} clips (zoom 1.0x → 1.12x)`)
    console.log(`[${jobId}] ✓ Image scaling: Using pad (no crop) to show more of images, especially 3:2 aspect ratio`)
    onProgress?.({ stage: 'clips_created', progress: 50 })

    // Step 4: Concatenate clips with transitions
    console.log(`[${jobId}] Concatenating clips with ${transitionType} transitions...`)
    onProgress?.({ stage: 'concatenating', progress: 55 })
    const finalVideoPath = path.join(workDir, 'final.mp4')

    if (segments.length === 1) {
      // Single clip, no transition needed
      await execAsync(`cp "${clipPaths[0]}" "${finalVideoPath}"`)
    } else if (transitionType === 'none' || clipPaths.length > 10) {
      // Use concat demuxer for faster concatenation (no transitions)
      // This is much faster than filter_complex and avoids Railway timeouts
      const concatListPath = path.join(workDir, 'concat-list.txt')
      const concatList = clipPaths.map(clip => `file '${clip}'`).join('\n')
      await writeFile(concatListPath, concatList)
      
      const concatArgs = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy', // Copy streams (no re-encoding = much faster!)
        '-movflags', '+faststart',
        finalVideoPath,
      ]

      try {
        console.log(`[${jobId}] Starting fast concatenation (no transitions) with ${clipPaths.length} clips...`)
        await execFFmpeg(concatArgs, workDir, jobId, 60000) // 1 min timeout (much faster!)
        console.log(`[${jobId}] ✓ Concatenation complete: ${finalVideoPath}`)
        onProgress?.({ stage: 'concatenated', progress: 70 })
      } catch (error) {
        console.error(`[${jobId}] Error concatenating clips:`, error)
        throw new Error(`Failed to concatenate clips: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    } else {
      // Use xfade filter for transitions (only for small number of clips)
      const segmentDurations = segments.map(s => s.duration || 3)
      const filterComplex = buildTransitionFilter(clipPaths, transitionType, transitionDuration, fps, segmentDurations)
      
      const concatArgs = [
        '-y',
        ...clipPaths.flatMap((clip, i) => ['-i', clip]),
        '-filter_complex', filterComplex,
        '-map', '[v]',
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Use ultrafast for Railway (was 'fast')
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-r', fps.toString(),
        '-threads', '1',
        '-movflags', '+faststart',
        finalVideoPath,
      ]

      try {
        console.log(`[${jobId}] Starting concatenation with transitions (${clipPaths.length} clips)...`)
        await execFFmpeg(concatArgs, workDir, jobId, 180000) // 3 min timeout (reduced from 5)
        console.log(`[${jobId}] ✓ Concatenation complete: ${finalVideoPath}`)
      } catch (error) {
        console.error(`[${jobId}] Error concatenating clips:`, error)
        // Fallback to simple concat if transitions fail
        console.log(`[${jobId}] Falling back to simple concatenation...`)
        const concatListPath = path.join(workDir, 'concat-list.txt')
        const concatList = clipPaths.map(clip => `file '${clip}'`).join('\n')
        await writeFile(concatListPath, concatList)
        await execFFmpeg([
          '-y', '-f', 'concat', '-safe', '0', '-i', concatListPath,
          '-c', 'copy', '-movflags', '+faststart', finalVideoPath,
        ], workDir, jobId, 60000)
        console.log(`[${jobId}] ✓ Fallback concatenation complete`)
      }
    }

    // Step 5: Match video duration to audio duration exactly
    console.log(`[${jobId}] Matching video duration to audio...`)
    onProgress?.({ stage: 'matching_duration', progress: 75 })
    
    // Calculate actual video duration from segments
    const calculatedVideoDuration = segments.reduce((sum, s) => sum + (s.duration || 0), 0)
    
    // Get actual audio duration using ffprobe - CRITICAL: Must succeed to prevent audio cutoff
    try {
      const probeResult = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`)
      const probedDuration = parseFloat(probeResult.stdout.trim())
      
      if (!probedDuration || isNaN(probedDuration) || probedDuration <= 0) {
        throw new Error(`Invalid audio duration from ffprobe: ${probeResult.stdout.trim()}`)
      }
      
      actualAudioDuration = probedDuration
      console.log(`[${jobId}] ✓ Audio duration from ffprobe: ${actualAudioDuration.toFixed(2)}s, Video duration: ${calculatedVideoDuration.toFixed(2)}s`)
    } catch (error) {
      console.error(`[${jobId}] ❌ CRITICAL: Failed to probe audio duration:`, error)
      throw new Error(`Failed to get audio duration - cannot proceed safely. Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
    
    // Ensure video duration matches audio duration exactly
    let videoForAudio = finalVideoPath
    const durationDiff = actualAudioDuration - calculatedVideoDuration
    
    if (Math.abs(durationDiff) > 0.1) { // More than 0.1s difference
      console.log(`[${jobId}] Duration mismatch: audio=${actualAudioDuration.toFixed(2)}s, video=${calculatedVideoDuration.toFixed(2)}s, diff=${durationDiff.toFixed(2)}s`)
      
      const matchedVideoPath = path.join(workDir, 'video-matched.mp4')
      
      if (durationDiff > 0) {
        // Audio is longer - extend video to match audio duration
        // Use tpad filter to add padding frames at the end (cloning last frame)
        console.log(`[${jobId}] Extending video to match audio duration (${durationDiff.toFixed(2)}s longer)...`)
        const extendArgs = [
          '-y',
          '-i', finalVideoPath,
          '-vf', `tpad=stop_mode=clone:stop_duration=${durationDiff.toFixed(3)}`, // Add durationDiff seconds at end
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          matchedVideoPath,
        ]
        await execFFmpeg(extendArgs, workDir, jobId, 30000)
        videoForAudio = matchedVideoPath
      } else {
        // Audio is shorter - trim video to match audio
        console.log(`[${jobId}] Trimming video to match audio duration...`)
        const trimArgs = [
          '-y',
          '-i', finalVideoPath,
          '-t', actualAudioDuration.toFixed(3), // Set exact duration
          '-c:v', 'copy', // Copy video stream (fast)
          matchedVideoPath,
        ]
        await execFFmpeg(trimArgs, workDir, jobId, 30000)
        videoForAudio = matchedVideoPath
      }
    }
    
    // Step 6: Add audio
    console.log(`[${jobId}] Adding audio track...`)
    console.log(`[${jobId}] Video file: ${videoForAudio}`)
    console.log(`[${jobId}] Audio file: ${audioPath}`)
    console.log(`[${jobId}] Audio duration: ${actualAudioDuration.toFixed(3)}s`)
    
    // Verify files exist before attempting merge
    try {
      const fsPromises = await import('fs/promises')
      const videoStats = await fsPromises.stat(videoForAudio)
      const audioStats = await fsPromises.stat(audioPath)
      console.log(`[${jobId}] Files verified: video=${videoStats.size} bytes, audio=${audioStats.size} bytes`)
      
      if (videoStats.size === 0) {
        throw new Error('Video file is empty')
      }
      if (audioStats.size === 0) {
        throw new Error('Audio file is empty')
      }
    } catch (statError) {
      console.error(`[${jobId}] ❌ File verification failed:`, statError)
      throw new Error(`File verification failed: ${statError instanceof Error ? statError.message : 'Unknown error'}`)
    }
    
    onProgress?.({ stage: 'adding_audio', progress: 80 })
    const videoWithAudioPath = path.join(workDir, 'video-with-audio.mp4')
    
    // CRITICAL FIX: Use exact duration matching instead of -shortest
    // -shortest can cut off audio if there's any timing mismatch
    // Instead, use -t to set exact duration from audio
    const audioArgs = [
      '-y',
      '-i', videoForAudio,
      '-i', audioPath,
      '-c:v', 'copy', // Copy video stream (no re-encoding)
      '-c:a', 'aac', // Encode audio to AAC
      '-b:a', '192k', // Audio bitrate
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-t', actualAudioDuration.toFixed(3), // Use exact audio duration (CRITICAL: prevents cut-off)
      videoWithAudioPath,
    ]

    try {
      console.log(`[${jobId}] Executing FFmpeg audio merge command...`)
      await execFFmpeg(audioArgs, workDir, jobId, 120000) // 2 min timeout for audio merge
      
      // Verify output file was created
      const fsPromises = await import('fs/promises')
      const outputStats = await fsPromises.stat(videoWithAudioPath)
      console.log(`[${jobId}] ✓ Audio merge complete: ${videoWithAudioPath} (${outputStats.size} bytes)`)
      
      if (outputStats.size === 0) {
        throw new Error('Output video file is empty after audio merge')
      }
      
      onProgress?.({ stage: 'audio_added', progress: 85 })
      
      // VALIDATION: Verify final video has audio and correct duration - CRITICAL CHECK
      try {
        const verifyResult = await execAsync(`ffprobe -v error -show_entries format=duration,stream=codec_type -of default=noprint_wrappers=1 "${videoWithAudioPath}"`)
        const hasAudio = verifyResult.stdout.includes('codec_type=audio')
        const durationMatch = verifyResult.stdout.match(/duration=([\d.]+)/)
        const finalDuration = durationMatch ? parseFloat(durationMatch[1]) : 0
        
        console.log(`[${jobId}] Validation check: hasAudio=${hasAudio}, finalDuration=${finalDuration.toFixed(2)}s, expected=${actualAudioDuration.toFixed(2)}s`)
        
        if (!hasAudio) {
          console.error(`[${jobId}] ❌ CRITICAL: Final video has no audio track`)
          throw new Error('CRITICAL: Final video has no audio track')
        }
        
        const durationDiff = Math.abs(finalDuration - actualAudioDuration)
        if (durationDiff > 0.5) {
          // Allow 0.5s tolerance for encoding differences (increased from 0.3s)
          console.error(`[${jobId}] ❌ CRITICAL: Duration mismatch - expected ${actualAudioDuration.toFixed(2)}s, got ${finalDuration.toFixed(2)}s (diff: ${durationDiff.toFixed(2)}s)`)
          throw new Error(`CRITICAL: Duration mismatch - expected ${actualAudioDuration.toFixed(2)}s, got ${finalDuration.toFixed(2)}s (diff: ${durationDiff.toFixed(2)}s)`)
        }
        
        console.log(`[${jobId}] ✓ Validation passed: audio=${hasAudio}, duration=${finalDuration.toFixed(2)}s (expected: ${actualAudioDuration.toFixed(2)}s, diff: ${durationDiff.toFixed(2)}s)`)
      } catch (verifyError) {
        console.error(`[${jobId}] ❌ CRITICAL VALIDATION FAILED:`, verifyError)
        console.error(`[${jobId}] Validation error details:`, verifyError instanceof Error ? verifyError.stack : verifyError)
        // Fail the job if validation fails - audio cutoff is unacceptable
        throw new Error(`Video validation failed: ${verifyError instanceof Error ? verifyError.message : 'Unknown error'}`)
      }
    } catch (error) {
      console.error(`[${jobId}] Error adding audio:`, error)
      throw new Error(`Failed to add audio: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

    // Step 6: Read final video
    onProgress?.({ stage: 'reading_video', progress: 90 })
    const finalVideo = await readFile(videoWithAudioPath)

    if (!finalVideo || finalVideo.length === 0) {
      throw new Error('Final video file is empty or could not be read')
    }

    // Step 7: Cleanup
    await cleanup(workDir)

    console.log(`[${jobId}] Video render complete: ${finalVideo.length} bytes`)
    onProgress?.({ stage: 'complete', progress: 95 })

    // Return video as base64 (client will upload to blob storage)
    const videoBase64 = finalVideo.toString('base64')
    const videoDataUrl = `data:video/mp4;base64,${videoBase64}`
    
    if (!videoDataUrl || videoDataUrl.length < 100) {
      throw new Error('Failed to encode video as base64 data URL')
    }
    
    // Use actual audio duration as the final video duration (more accurate)
    const result = {
      videoUrl: videoDataUrl,
      videoSize: finalVideo.length,
      duration: actualAudioDuration || segments.reduce((sum, s) => sum + (s.duration || 3), 0),
    }
    
    console.log(`[${jobId}] ✓ Result prepared: videoUrl length=${result.videoUrl.length}, videoSize=${result.videoSize}, duration=${result.duration.toFixed(2)}s`)
    
    return result
  } catch (error) {
    console.error(`[${jobId}] Render error:`, error)
    
    // Cleanup on error
    try {
      await cleanup(workDir)
    } catch (cleanupError) {
      console.error(`[${jobId}] Cleanup error:`, cleanupError)
    }

    throw error // Re-throw to be caught by caller
  }
}

/**
 * Simple, reliable text wrapping at word boundaries
 * Wraps text to fit within maxCharsPerLine
 */
function wrapTextSimple(text: string, maxCharsPerLine: number): string {
  // If text already has newlines (like opener), wrap each line separately
  if (text.includes('\n')) {
    return text.split('\n').map(line => wrapLine(line, maxCharsPerLine)).join('\n')
  }
  
  return wrapLine(text, maxCharsPerLine)
}

/**
 * Wrap a single line at word boundaries
 */
function wrapLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  
  const words = text.split(' ')
  const lines: string[] = []
  let currentLine = ''
  
  for (const word of words) {
    // If adding this word exceeds limit, start new line
    if (currentLine && (currentLine + ' ' + word).length > maxChars) {
      lines.push(currentLine)
      currentLine = word
    } else {
      currentLine = currentLine ? currentLine + ' ' + word : word
    }
  }
  
  if (currentLine) {
    lines.push(currentLine)
  }
  
  return lines.join('\n')
}

/**
 * Build FFmpeg filter complex for transitions
 */
function buildTransitionFilter(
  clipPaths: string[],
  transitionType: string,
  transitionDuration: number,
  fps: number,
  segmentDurations: number[]
): string {
  const numClips = clipPaths.length
  
  // Build filter chain
  const filters: string[] = []
  
  // Scale all inputs - use pad instead of crop to show MORE of the image
  for (let i = 0; i < numClips; i++) {
    // Scale to fit vertical format while showing whole image (no cropping)
    // Use decrease+pad to show more content, especially for 3:2 images
    // This matches the individual clip processing for consistency
    filters.push(`[${i}:v]scale=1080:1920:flags=lanczos:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${i}]`)
  }
  
  // Apply transitions
  let currentOutput = 'v0'
  let currentTime = segmentDurations[0] || 3
  
  for (let i = 1; i < numClips; i++) {
    const prevOutput = currentOutput
    const currentInput = `v${i}`
    const outputName = i === numClips - 1 ? 'v' : `v${i}out`
    
    // Calculate offset (when transition starts)
    // Transition starts at the end of previous clip minus transition duration
    const offset = currentTime - transitionDuration
    
    const transitionName = getTransitionName(transitionType)
    filters.push(`[${prevOutput}][${currentInput}]xfade=transition=${transitionName}:duration=${transitionDuration}:offset=${offset}[${outputName}]`)
    
    currentOutput = outputName
    currentTime += segmentDurations[i] || 3
  }
  
  return filters.join(';')
}

/**
 * Get FFmpeg xfade transition name
 */
function getTransitionName(type: string): string {
  const transitions: Record<string, string> = {
    fade: 'fade',
    crossfade: 'fade',
    dissolve: 'fade',
    wipe: 'wipeleft',
    wipeleft: 'wipeleft',
    wiperight: 'wiperight',
    wipeup: 'wipeup',
    wipedown: 'wipedown',
    zoom: 'zoomin',
    zoomin: 'zoomin',
    zoomout: 'zoomout',
    slide: 'slideleft',
    slideleft: 'slideleft',
    slideright: 'slideright',
  }
  
  return transitions[type.toLowerCase()] || 'fade'
}

/**
 * Cleanup temporary files
 */
async function cleanup(workDir: string) {
  if (existsSync(workDir)) {
    try {
      await execAsync(`rm -rf "${workDir}"`)
    } catch (error) {
      console.error('Cleanup error:', error)
    }
  }
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`FFmpeg Video Rendering Service running on port ${PORT}`)
  console.log(`Health check: http://localhost:${PORT}/health`)
  console.log(`Render endpoint: POST http://localhost:${PORT}/render`)
})

