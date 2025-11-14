/**
 * FFmpeg Video Rendering Service
 * 
 * Deploy this on Railway/Render/Fly.io for professional video rendering
 * with proper transitions, text overlays, and audio mixing.
 */

import express, { Request, Response } from 'express'
import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

const execAsync = promisify(exec)
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
  
  try {
    // Create work directory
    await mkdir(workDir, { recursive: true })

    const { segments, audioUrl, carData, options } = req.body

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: 'Segments array is required' })
    }

    if (!audioUrl) {
      return res.status(400).json({ error: 'audioUrl is required' })
    }

    const transitionType = options?.transitionType || 'crossfade'
    const transitionDuration = options?.transitionDuration || 0.5
    const width = options?.width || 1080
    const height = options?.height || 1920
    const fps = options?.fps || 30

    console.log(`[${jobId}] Starting video render:`, {
      segments: segments.length,
      transitionType,
      transitionDuration,
      dimensions: `${width}x${height}`,
    })

    // Step 1: Download images
    console.log(`[${jobId}] Downloading ${segments.length} images...`)
    const imagePaths: string[] = []
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const imagePath = path.join(workDir, `image-${i}.jpg`)
      
      try {
        const response = await fetch(segment.imageUrl)
        if (!response.ok) {
          throw new Error(`Failed to download image ${i}: ${response.status}`)
        }
        const buffer = await response.arrayBuffer()
        await writeFile(imagePath, Buffer.from(buffer))
        imagePaths.push(imagePath)
      } catch (error) {
        console.error(`[${jobId}] Error downloading image ${i}:`, error)
        throw new Error(`Failed to download image ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    // Step 2: Download audio
    console.log(`[${jobId}] Downloading audio...`)
    const audioPath = path.join(workDir, 'audio.mp3')
    try {
      const audioResponse = await fetch(audioUrl)
      if (!audioResponse.ok) {
        throw new Error(`Failed to download audio: ${audioResponse.status}`)
      }
      const audioBuffer = await audioResponse.arrayBuffer()
      await writeFile(audioPath, Buffer.from(audioBuffer))
    } catch (error) {
      console.error(`[${jobId}] Error downloading audio:`, error)
      throw new Error(`Failed to download audio: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

    // Step 3: Create video clips from images with text overlays
    console.log(`[${jobId}] Creating video clips...`)
    const clipPaths: string[] = []
    
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const clipPath = path.join(workDir, `clip-${i}.mp4`)
      const duration = segment.duration || 3
      
      // Build FFmpeg filter for text overlay
      let textFilter = ''
      if (segment.textOverlay) {
        // Escape text for FFmpeg
        const escapedText = segment.textOverlay
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
          .replace(/"/g, '\\"')
        
        const fontSize = segment.type === 'cta' ? 72 : segment.type === 'opener' ? 56 : 48
        const yPosition = segment.type === 'cta' ? 'h-th-150' : segment.type === 'opener' ? '100' : '80'
        
        textFilter = `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPosition}:box=1:boxcolor=black@0.5:boxborderw=5`
      }

      // Create video clip from image
      const ffmpegCmd = [
        'ffmpeg',
        '-y', // Overwrite output
        '-loop', '1',
        '-i', imagePaths[i],
        '-t', duration.toString(),
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}${textFilter ? ',' + textFilter : ''}`,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-r', fps.toString(),
        clipPath,
      ].filter(Boolean).join(' ')

      try {
        await execAsync(ffmpegCmd)
        clipPaths.push(clipPath)
      } catch (error) {
        console.error(`[${jobId}] Error creating clip ${i}:`, error)
        throw new Error(`Failed to create clip ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    // Step 4: Concatenate clips with transitions
    console.log(`[${jobId}] Concatenating clips with ${transitionType} transitions...`)
    const finalVideoPath = path.join(workDir, 'final.mp4')

    if (segments.length === 1) {
      // Single clip, no transition needed
      await execAsync(`cp "${clipPaths[0]}" "${finalVideoPath}"`)
    } else {
      // Multiple clips - use xfade filter for transitions
      const segmentDurations = segments.map(s => s.duration || 3)
      const filterComplex = buildTransitionFilter(clipPaths, transitionType, transitionDuration, fps, segmentDurations)
      
      const concatCmd = [
        'ffmpeg',
        '-y',
        ...clipPaths.flatMap((clip, i) => ['-i', clip]),
        '-filter_complex', filterComplex,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-r', fps.toString(),
        finalVideoPath,
      ].join(' ')

      try {
        await execAsync(concatCmd)
      } catch (error) {
        console.error(`[${jobId}] Error concatenating clips:`, error)
        throw new Error(`Failed to concatenate clips: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    // Step 5: Add audio
    console.log(`[${jobId}] Adding audio track...`)
    const videoWithAudioPath = path.join(workDir, 'video-with-audio.mp4')
    
    const audioCmd = [
      'ffmpeg',
      '-y',
      '-i', finalVideoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest',
      videoWithAudioPath,
    ].join(' ')

    try {
      await execAsync(audioCmd)
    } catch (error) {
      console.error(`[${jobId}] Error adding audio:`, error)
      throw new Error(`Failed to add audio: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

    // Step 6: Read final video
    const finalVideo = await readFile(videoWithAudioPath)

    // Step 7: Cleanup
    await cleanup(workDir)

    console.log(`[${jobId}] Video render complete: ${finalVideo.length} bytes`)

    // Return video as base64 or upload to storage
    // For now, return as base64 (in production, upload to S3/Blob storage)
    const videoBase64 = finalVideo.toString('base64')
    const videoDataUrl = `data:video/mp4;base64,${videoBase64}`

    res.json({
      success: true,
      videoUrl: videoDataUrl,
      videoSize: finalVideo.length,
      duration: segments.reduce((sum, s) => sum + (s.duration || 3), 0),
    })
  } catch (error) {
    console.error(`[${jobId}] Render error:`, error)
    
    // Cleanup on error
    try {
      await cleanup(workDir)
    } catch (cleanupError) {
      console.error(`[${jobId}] Cleanup error:`, cleanupError)
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

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
    filters.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v${i}]`)
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

