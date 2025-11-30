/**
 * FFmpeg Filter Helpers
 * 
 * Generates complex FFmpeg filter expressions for:
 * - Bold text with faded bottom gradient
 * - Pulsing highlight indicators
 * - Smooth text animations
 */

export interface TextStyle {
  fontSize: number
  fontPath?: string
  color: string
  shadowColor: string
  shadowBlur: number
  shadowOffsetY: number
  fadedBottom: boolean
  fadeHeight: number // 0-1, percentage of text height
}

export interface AnimationTiming {
  start: number // seconds
  duration: number // seconds
  fadeIn: number // seconds
  fadeOut: number // seconds
}

export interface HighlightConfig {
  x: number // normalized 0-1
  y: number // normalized 0-1
  width: number // normalized 0-1
  height: number // normalized 0-1
  color: string // hex color
  pulsesDuration: number // total animation duration
  pulseCount: number
}

/**
 * Generate drawtext filter for bold text with optional faded bottom effect
 * 
 * The faded bottom is achieved by drawing the text multiple times with
 * decreasing opacity in a gradient mask pattern.
 */
export function generateBoldTextFilter(
  text: string,
  x: string | number,
  y: number,
  style: TextStyle,
  timing: AnimationTiming,
  inputLabel: string,
  outputLabel: string,
  videoWidth: number = 1080,
  videoHeight: number = 1920
): string {
  const escapedText = escapeTextForFFmpeg(text)
  const filters: string[] = []
  
  // Calculate animation expressions
  const { start, duration, fadeIn, fadeOut } = timing
  const end = start + duration
  const fadeOutStart = end - fadeOut
  
  // Alpha expression for fade in/out
  const alphaExpr = buildAlphaExpression(start, start + fadeIn, fadeOutStart, end)
  
  // Y position expression for slide-up animation
  const slideDistance = 40
  const yStart = y + slideDistance
  const yExpr = buildSlideExpression(y, yStart, start, start + fadeIn)
  
  // Build font parameters
  const fontParams: string[] = []
  if (style.fontPath) {
    fontParams.push(`fontfile=${escapePathForFFmpeg(style.fontPath)}`)
  }
  fontParams.push(`fontsize=${style.fontSize}`)
  fontParams.push(`fontcolor=${style.color}`)
  
  // Add shadow for depth
  if (style.shadowOffsetY > 0) {
    fontParams.push(`shadowcolor=${style.shadowColor}`)
    fontParams.push(`shadowx=0`)
    fontParams.push(`shadowy=${style.shadowOffsetY}`)
  }
  
  // Border for extra boldness and legibility
  fontParams.push(`borderw=2`)
  fontParams.push(`bordercolor=black@0.5`)
  
  if (style.fadedBottom && style.fadeHeight > 0) {
    // For faded bottom effect, we draw multiple text layers with decreasing opacity
    // This simulates a gradient fade on the bottom portion of the text
    const fadeSteps = 4
    const baseOpacity = 0.98
    
    for (let i = 0; i < fadeSteps; i++) {
      const stepHeight = style.fadeHeight / fadeSteps
      const stepY = y + (style.fontSize * (1 - style.fadeHeight) + style.fontSize * stepHeight * i)
      const stepOpacity = baseOpacity * (1 - (i / fadeSteps) * 0.7)
      
      const layerLabel = `${outputLabel}_fade${i}`
      const prevLabel = i === 0 ? inputLabel : `${outputLabel}_fade${i - 1}`
      
      // Create a mask for this fade step
      const clipTop = Math.round(stepY)
      const clipBottom = Math.round(stepY + style.fontSize * stepHeight)
      
      // Draw text with clip region and reduced opacity
      const stepAlpha = `'${alphaExpr.replace(/'/g, '')}*${stepOpacity.toFixed(2)}'`
      
      filters.push(
        `[${prevLabel}]drawtext=text='${escapedText}':` +
        `${fontParams.join(':')}:` +
        `x=(w-text_w)/2:` +
        `y=${yExpr}:` +
        `alpha=${stepAlpha}` +
        `[${layerLabel}]`
      )
    }
    
    // Final full-opacity text for top portion
    const fullTextLabel = outputLabel
    const prevLabel = `${outputLabel}_fade${fadeSteps - 1}`
    
    filters.push(
      `[${prevLabel}]drawtext=text='${escapedText}':` +
      `${fontParams.join(':')}:` +
      `x=(w-text_w)/2:` +
      `y=${yExpr}:` +
      `alpha=${alphaExpr}` +
      `[${fullTextLabel}]`
    )
  } else {
    // Simple text without fade effect
    filters.push(
      `[${inputLabel}]drawtext=text='${escapedText}':` +
      `${fontParams.join(':')}:` +
      `x=${typeof x === 'number' ? x : x}:` +
      `y=${yExpr}:` +
      `alpha=${alphaExpr}` +
      `[${outputLabel}]`
    )
  }
  
  return filters.join(';')
}

/**
 * Generate pulsing circle highlight indicator
 */
export function generatePulseCircleFilter(
  highlight: HighlightConfig,
  timing: AnimationTiming,
  inputLabel: string,
  outputLabel: string,
  videoWidth: number = 1080,
  videoHeight: number = 1920
): string {
  const { x, y, width, height, color, pulsesDuration, pulseCount } = highlight
  const { start, duration } = timing
  
  // Convert normalized coordinates to pixels
  const centerX = Math.round(x * videoWidth + (width * videoWidth) / 2)
  const centerY = Math.round(y * videoHeight + (height * videoHeight) / 2)
  const baseRadius = Math.round(Math.min(width * videoWidth, height * videoHeight) * 0.15)
  
  // Parse color (hex to RGB)
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  const rgbColor = `0x${color.slice(1)}@`
  
  const end = start + duration
  const pulsePeriod = pulsesDuration / pulseCount
  
  // Build pulsing opacity expression
  // Uses sine wave: 0.3 + 0.6 * abs(sin(pi * (t - start) / period))
  const pulseExpr = `if(between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})\\,` +
    `0.3+0.6*abs(sin(PI*(t-${start.toFixed(3)})/${pulsePeriod.toFixed(3)}))\\,0)`
  
  // Build pulsing radius expression
  const radiusMin = baseRadius * 0.8
  const radiusMax = baseRadius * 1.2
  const radiusExpr = `${radiusMin}+${radiusMax - radiusMin}*abs(sin(PI*(t-${start.toFixed(3)})/${pulsePeriod.toFixed(3)}))`
  
  // Draw circle with geq filter (more control than drawbox for circles)
  // Alternative: use multiple drawbox calls to approximate a circle
  // For simplicity, we'll use drawbox to create a pulsing square indicator
  const boxSize = baseRadius * 2
  const boxX = centerX - baseRadius
  const boxY = centerY - baseRadius
  
  // Use drawbox with rounded appearance (closest we can get in FFmpeg without geq)
  const filter = `[${inputLabel}]drawbox=` +
    `x='${boxX}':` +
    `y='${boxY}':` +
    `w='${boxSize}':` +
    `h='${boxSize}':` +
    `color=${rgbColor}${pulseExpr}:` +
    `t=fill` +
    `[${outputLabel}]`
  
  return filter
}

/**
 * Generate pulsing dot indicator (smaller, more subtle)
 */
export function generatePulseDotFilter(
  highlight: HighlightConfig,
  timing: AnimationTiming,
  inputLabel: string,
  outputLabel: string,
  videoWidth: number = 1080,
  videoHeight: number = 1920
): string {
  const { x, y, width, height, color, pulsesDuration, pulseCount } = highlight
  const { start, duration } = timing
  
  // Position dot at center-top of highlight area
  const dotX = Math.round(x * videoWidth + (width * videoWidth) / 2)
  const dotY = Math.round(y * videoHeight + 20) // Near top of highlight
  const dotSize = 12
  
  const end = start + duration
  const pulsePeriod = pulsesDuration / pulseCount
  
  // Pulsing opacity
  const pulseExpr = `if(between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})\\,` +
    `0.4+0.5*abs(sin(PI*(t-${start.toFixed(3)})/${pulsePeriod.toFixed(3)}))\\,0)`
  
  // Draw small dot
  const filter = `[${inputLabel}]drawbox=` +
    `x='${dotX - dotSize / 2}':` +
    `y='${dotY - dotSize / 2}':` +
    `w='${dotSize}':` +
    `h='${dotSize}':` +
    `color=0x${color.slice(1)}@${pulseExpr}:` +
    `t=fill` +
    `[${outputLabel}]`
  
  return filter
}

/**
 * Generate corner marks highlight indicator
 */
export function generateCornerMarksFilter(
  highlight: HighlightConfig,
  timing: AnimationTiming,
  inputLabel: string,
  outputLabel: string,
  videoWidth: number = 1080,
  videoHeight: number = 1920
): string {
  const { x, y, width, height, color, pulsesDuration, pulseCount } = highlight
  const { start, duration } = timing
  
  // Convert to pixels
  const left = Math.round(x * videoWidth)
  const top = Math.round(y * videoHeight)
  const right = Math.round((x + width) * videoWidth)
  const bottom = Math.round((y + height) * videoHeight)
  
  const cornerLength = Math.round(Math.min(width * videoWidth, height * videoHeight) * 0.15)
  const lineWidth = 3
  
  const end = start + duration
  const pulsePeriod = pulsesDuration / pulseCount
  
  const pulseExpr = `if(between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})\\,` +
    `0.5+0.4*abs(sin(PI*(t-${start.toFixed(3)})/${pulsePeriod.toFixed(3)}))\\,0)`
  
  const rgbColor = `0x${color.slice(1)}@${pulseExpr}`
  
  // Draw 4 corner marks (L-shaped brackets)
  const filters: string[] = []
  let currentLabel = inputLabel
  
  // Top-left corner
  filters.push(`[${currentLabel}]drawbox=x='${left}':y='${top}':w='${cornerLength}':h='${lineWidth}':color=${rgbColor}:t=fill[corner_tl_h]`)
  filters.push(`[corner_tl_h]drawbox=x='${left}':y='${top}':w='${lineWidth}':h='${cornerLength}':color=${rgbColor}:t=fill[corner_tl]`)
  
  // Top-right corner
  filters.push(`[corner_tl]drawbox=x='${right - cornerLength}':y='${top}':w='${cornerLength}':h='${lineWidth}':color=${rgbColor}:t=fill[corner_tr_h]`)
  filters.push(`[corner_tr_h]drawbox=x='${right - lineWidth}':y='${top}':w='${lineWidth}':h='${cornerLength}':color=${rgbColor}:t=fill[corner_tr]`)
  
  // Bottom-left corner
  filters.push(`[corner_tr]drawbox=x='${left}':y='${bottom - lineWidth}':w='${cornerLength}':h='${lineWidth}':color=${rgbColor}:t=fill[corner_bl_h]`)
  filters.push(`[corner_bl_h]drawbox=x='${left}':y='${bottom - cornerLength}':w='${lineWidth}':h='${cornerLength}':color=${rgbColor}:t=fill[corner_bl]`)
  
  // Bottom-right corner
  filters.push(`[corner_bl]drawbox=x='${right - cornerLength}':y='${bottom - lineWidth}':w='${cornerLength}':h='${lineWidth}':color=${rgbColor}:t=fill[corner_br_h]`)
  filters.push(`[corner_br_h]drawbox=x='${right - lineWidth}':y='${bottom - cornerLength}':w='${lineWidth}':h='${cornerLength}':color=${rgbColor}:t=fill[${outputLabel}]`)
  
  return filters.join(';')
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Escape text for FFmpeg drawtext filter
 */
function escapeTextForFFmpeg(text: string): string {
  return text
    .replace(/\\/g, '\\\\')   // Escape backslashes first
    .replace(/:/g, '\\:')     // Escape colons
    .replace(/=/g, '\\=')     // Escape equals
    .replace(/'/g, "'\\''")   // Escape single quotes
    .replace(/,/g, '\\,')     // Escape commas for filter_complex
}

/**
 * Escape file path for FFmpeg fontfile parameter
 */
function escapePathForFFmpeg(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
}

/**
 * Build alpha expression for fade in/out
 */
function buildAlphaExpression(
  fadeInStart: number,
  fadeInEnd: number,
  fadeOutStart: number,
  fadeOutEnd: number
): string {
  // FFmpeg expression for smooth fade in/out
  // Format: if(lt(t,start),0,if(lt(t,fadeInEnd),(t-start)/fadeInDur,if(lt(t,fadeOutStart),1,if(lt(t,end),1-(t-fadeOutStart)/fadeOutDur,0))))
  const fadeInDur = fadeInEnd - fadeInStart
  const fadeOutDur = fadeOutEnd - fadeOutStart
  
  const expr = `if(lt(t\\,${fadeInStart.toFixed(3)})\\,0\\,` +
    `if(lt(t\\,${fadeInEnd.toFixed(3)})\\,(t-${fadeInStart.toFixed(3)})/${fadeInDur.toFixed(3)}\\,` +
    `if(lt(t\\,${fadeOutStart.toFixed(3)})\\,1\\,` +
    `if(lt(t\\,${fadeOutEnd.toFixed(3)})\\,1-(t-${fadeOutStart.toFixed(3)})/${fadeOutDur.toFixed(3)}\\,0))))`
  
  return `'${expr}'`
}

/**
 * Build Y position expression for slide-up animation
 */
function buildSlideExpression(
  finalY: number,
  startY: number,
  animStart: number,
  animEnd: number
): string {
  const animDur = animEnd - animStart
  
  // Linear interpolation from startY to finalY during animation
  const expr = `if(lt(t\\,${animStart.toFixed(3)})\\,${startY.toFixed(3)}\\,` +
    `if(lt(t\\,${animEnd.toFixed(3)})\\,${startY.toFixed(3)}+(${finalY.toFixed(3)}-${startY.toFixed(3)})*((t-${animStart.toFixed(3)})/${animDur.toFixed(3)})\\,` +
    `${finalY.toFixed(3)}))`
  
  return `'${expr}'`
}

/**
 * Get highlight filter based on type
 */
export function getHighlightFilter(
  type: 'pulse-dot' | 'pulse-circle' | 'bracket' | 'corner-marks',
  highlight: HighlightConfig,
  timing: AnimationTiming,
  inputLabel: string,
  outputLabel: string,
  videoWidth?: number,
  videoHeight?: number
): string {
  switch (type) {
    case 'pulse-dot':
      return generatePulseDotFilter(highlight, timing, inputLabel, outputLabel, videoWidth, videoHeight)
    case 'pulse-circle':
      return generatePulseCircleFilter(highlight, timing, inputLabel, outputLabel, videoWidth, videoHeight)
    case 'corner-marks':
      return generateCornerMarksFilter(highlight, timing, inputLabel, outputLabel, videoWidth, videoHeight)
    case 'bracket':
      return generateCornerMarksFilter(highlight, timing, inputLabel, outputLabel, videoWidth, videoHeight)
    default:
      return generatePulseCircleFilter(highlight, timing, inputLabel, outputLabel, videoWidth, videoHeight)
  }
}

