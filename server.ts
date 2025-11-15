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
        
        console.error(`[${jobId}] ${errorMsg}`)
        if (stderr) {
          console.error(`[${jobId}] FFmpeg stderr: ${stderr.slice(-1000)}`) // Last 1000 chars
        }
        if (stdout) {
          console.error(`[${jobId}] FFmpeg stdout: ${stdout.slice(-1000)}`)
        }
        
        reject(new Error(`${errorMsg}. ${hasOutput ? 'Check logs above for details.' : 'No output received.'}`))
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
      res.write(JSON.stringify(update) + '\n')
    })
    
    // Send final result
    res.write(JSON.stringify({
      success: true,
      ...result,
      status: 'completed',
    }) + '\n')
    res.end()
  } catch (error) {
    res.write(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      status: 'failed',
    }) + '\n')
    res.end()
  }
})

async function processVideoAsync(
  jobId: string, 
  workDir: string, 
  body: any,
  onProgress?: (update: any) => void
) {
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
    console.log(`[${jobId}] Downloading audio...`)
    onProgress?.({ stage: 'downloading_audio', progress: 20 })
    const audioPath = path.join(workDir, 'audio.mp3')
    try {
      const audioResponse = await fetch(audioUrl)
      if (!audioResponse.ok) {
        throw new Error(`Failed to download audio: ${audioResponse.status}`)
      }
      const audioBuffer = await audioResponse.arrayBuffer()
      await writeFile(audioPath, Buffer.from(audioBuffer))
      onProgress?.({ stage: 'audio_downloaded', progress: 25 })
    } catch (error) {
      console.error(`[${jobId}] Error downloading audio:`, error)
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
      
      // Process image to fit vertical format (1080x1920) - show whole car
      // Use scale and crop to maintain aspect ratio while fitting vertical format
      const clipPath = path.join(workDir, `clip-${i}.mp4`)
      const duration = segment.duration || 3
      
      // Build FFmpeg filter - scale to fit vertical format while showing whole car
      // Use scale with fit to maintain aspect ratio and show entire image
      // This ensures we see the whole car, not cropped
      // Add Ken Burns effect (slow zoom/pan) for dynamic movement
      
      // Ken Burns parameters:
      // - Start zoom: 1.0 (no zoom)
      // - End zoom: 1.1 (10% zoom in)
      // - Pan: slight movement (optional)
      const startZoom = 1.0
      const endZoom = 1.1
      const zoomSpeed = (endZoom - startZoom) / (duration * fps) // Increment per frame
      
      // Scale image larger first to allow zoom room (scale to 120% to allow zoom to 110%)
      const scaleFactor = 1.2
      const scaledWidth = Math.round(width * scaleFactor)
      const scaledHeight = Math.round(height * scaleFactor)
      
      // Step 1: Scale image larger with padding (to allow zoom room)
      // Step 2: Apply Ken Burns zoom effect
      // zoompan syntax: z='zoom+increment':d=duration_in_frames:s=output_size
      // z='zoom+0.0005' means zoom increases by 0.0005 per frame
      // Use high-quality scaling algorithm (lanczos for better quality)
      // force_original_aspect_ratio=decrease ensures whole image is visible
      // Use smart crop: scale to fill, then crop center (no black bars!)
      // This fills the vertical frame instead of padding with black bars
      const kenBurnsFilter = `scale=${scaledWidth}:${scaledHeight}:flags=lanczos:force_original_aspect_ratio=increase,crop=${scaledWidth}:${scaledHeight}:(iw-ow)/2:(ih-oh)/2,zoompan=z='min(zoom+${zoomSpeed.toFixed(6)},${endZoom})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(duration * fps)}:s=${width}x${height}`
      
      let videoFilter = kenBurnsFilter
      
      if (segment.textOverlay) {
        // Escape text for FFmpeg drawtext filter
        const escapedText = segment.textOverlay
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
        
        // Determine font size and position based on segment type
        const fontSize = segment.type === 'cta' ? 72 : segment.type === 'opener' ? 64 : 52
        const yPosition = segment.type === 'cta' ? 'h-th-150' : segment.type === 'opener' ? '100' : '120'
        
        // Use textTiming if provided, otherwise show for entire duration
        const textStart = segment.textTiming?.start ?? 0
        const textDuration = segment.textTiming?.duration ?? duration
        const textEnd = Math.min(textStart + textDuration, duration) // Don't exceed clip duration
        
        // Log text timing for debugging
        console.log(`[${jobId}] Segment ${i} text overlay: "${escapedText.substring(0, 30)}..." timing: ${textStart}s-${textEnd}s (duration: ${textDuration}s)`)
        
        // Use escaped text in drawtext filter with timing
        // enable='between(t,start,end)' controls when text appears
        // Make text more visible with better styling (thicker border, darker background, larger font)
        const textFilter = `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPosition}:box=1:boxcolor=black@0.8:boxborderw=10:enable='between(t,${textStart},${textEnd})'`
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
    
    console.log(`[${jobId}] Created ${clipPaths.length} clips (expected ${segments.length})`)
    if (clipPaths.length !== segments.length) {
      console.warn(`[${jobId}] WARNING: Clip count mismatch! Expected ${segments.length}, got ${clipPaths.length}`)
    }
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

    // Step 5: Add audio
    console.log(`[${jobId}] Adding audio track...`)
    onProgress?.({ stage: 'adding_audio', progress: 75 })
    const videoWithAudioPath = path.join(workDir, 'video-with-audio.mp4')
    
    const audioArgs = [
      '-y',
      '-i', finalVideoPath,
      '-i', audioPath,
      '-c:v', 'copy', // Copy video stream (no re-encoding)
      '-c:a', 'aac', // Encode audio to AAC
      '-b:a', '192k', // Audio bitrate
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest', // End when shortest stream ends
      videoWithAudioPath,
    ]

    try {
      await execFFmpeg(audioArgs, workDir, jobId, 60000) // 1 min timeout for audio merge
      console.log(`[${jobId}] ✓ Audio added: ${videoWithAudioPath}`)
      onProgress?.({ stage: 'audio_added', progress: 85 })
    } catch (error) {
      console.error(`[${jobId}] Error adding audio:`, error)
      throw new Error(`Failed to add audio: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

    // Step 6: Read final video
    onProgress?.({ stage: 'reading_video', progress: 90 })
    const finalVideo = await readFile(videoWithAudioPath)

    // Step 7: Cleanup
    await cleanup(workDir)

    console.log(`[${jobId}] Video render complete: ${finalVideo.length} bytes`)
    onProgress?.({ stage: 'complete', progress: 95 })

    // Return video as base64 (client will upload to blob storage)
    const videoBase64 = finalVideo.toString('base64')
    const videoDataUrl = `data:video/mp4;base64,${videoBase64}`
    
    return {
      videoUrl: videoDataUrl,
      videoSize: finalVideo.length,
      duration: segments.reduce((sum, s) => sum + (s.duration || 3), 0),
    }
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
  
  // Scale all inputs
  for (let i = 0; i < numClips; i++) {
    // Scale to fit vertical format while showing whole car (no cropping)
    // Use high-quality scaling for concatenation
    // Use smart crop: scale to fill, then crop center (no black bars!)
    filters.push(`[${i}:v]scale=1080:1920:flags=lanczos:force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)/2:(ih-oh)/2,setsar=1[v${i}]`)
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

