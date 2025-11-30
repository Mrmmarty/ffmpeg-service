/**
 * Font Management for FFmpeg Service
 * 
 * Downloads and caches Google Fonts for use in video rendering.
 * Fonts are downloaded as TTF files and stored in /tmp/fonts/
 */

import { mkdir, writeFile, access } from 'fs/promises'
import path from 'path'
import { constants } from 'fs'

export interface FontInfo {
  name: string
  family: string
  weight: number
  style: 'normal' | 'italic'
  localPath: string
  url: string
}

// Font storage directory
const FONT_DIR = '/tmp/fonts'

/**
 * Selected Google Fonts - Direct TTF download URLs
 * These are the actual font files, not CSS
 */
const GOOGLE_FONTS: Record<string, { url: string; weight: number; style: 'normal' | 'italic' }> = {
  // Bebas Neue - Ultra-condensed display font
  'BebasNeue-Regular': {
    url: 'https://github.com/googlefonts/bebas-neue/raw/main/fonts/BebasNeue-Regular.ttf',
    weight: 400,
    style: 'normal',
  },
  
  // Oswald - Condensed sans-serif
  'Oswald-SemiBold': {
    url: 'https://github.com/googlefonts/OswaldFont/raw/main/fonts/ttf/Oswald-SemiBold.ttf',
    weight: 600,
    style: 'normal',
  },
  'Oswald-Bold': {
    url: 'https://github.com/googlefonts/OswaldFont/raw/main/fonts/ttf/Oswald-Bold.ttf',
    weight: 700,
    style: 'normal',
  },
  
  // Barlow Condensed - Modern condensed
  'BarlowCondensed-SemiBold': {
    url: 'https://github.com/jpt/barlow/raw/main/fonts/ttf/BarlowCondensed-SemiBold.ttf',
    weight: 600,
    style: 'normal',
  },
  'BarlowCondensed-Bold': {
    url: 'https://github.com/jpt/barlow/raw/main/fonts/ttf/BarlowCondensed-Bold.ttf',
    weight: 700,
    style: 'normal',
  },
  
  // Roboto Condensed - Highly legible
  'RobotoCondensed-Bold': {
    url: 'https://github.com/googlefonts/roboto/raw/main/src/hinted/RobotoCondensed-Bold.ttf',
    weight: 700,
    style: 'normal',
  },
  
  // Anton - Bold display
  'Anton-Regular': {
    url: 'https://github.com/googlefonts/AntonFont/raw/main/fonts/Anton-Regular.ttf',
    weight: 400,
    style: 'normal',
  },
}

// Fallback fonts that ship with most Linux systems
const SYSTEM_FONTS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Download a font file
 */
async function downloadFont(url: string, destPath: string): Promise<boolean> {
  try {
    console.log(`[Fonts] Downloading font from ${url}...`)
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShowroomReels/1.0)',
      },
    })
    
    if (!response.ok) {
      console.warn(`[Fonts] Failed to download font: ${response.status} ${response.statusText}`)
      return false
    }
    
    const buffer = await response.arrayBuffer()
    await writeFile(destPath, Buffer.from(buffer))
    console.log(`[Fonts] Downloaded font to ${destPath}`)
    return true
  } catch (error) {
    console.warn(`[Fonts] Error downloading font:`, error)
    return false
  }
}

/**
 * Ensure font directory exists
 */
async function ensureFontDir(): Promise<void> {
  try {
    await mkdir(FONT_DIR, { recursive: true })
  } catch (error) {
    // Directory may already exist
  }
}

/**
 * Get the best available font for a use case
 * Falls back to system fonts if Google Fonts unavailable
 */
export async function getBestFont(
  useCase: 'title' | 'feature' | 'price' | 'cta' | 'general'
): Promise<string | null> {
  await ensureFontDir()
  
  // Map use cases to preferred fonts
  const fontPreferences: Record<string, string[]> = {
    title: ['BebasNeue-Regular', 'Anton-Regular', 'Oswald-Bold'],
    feature: ['Oswald-SemiBold', 'BarlowCondensed-SemiBold', 'RobotoCondensed-Bold'],
    price: ['BarlowCondensed-Bold', 'Oswald-Bold', 'RobotoCondensed-Bold'],
    cta: ['Anton-Regular', 'BebasNeue-Regular', 'Oswald-Bold'],
    general: ['RobotoCondensed-Bold', 'Oswald-SemiBold', 'BarlowCondensed-SemiBold'],
  }
  
  const preferredFonts = fontPreferences[useCase] || fontPreferences.general
  
  // Try to get preferred Google fonts
  for (const fontName of preferredFonts) {
    const fontInfo = GOOGLE_FONTS[fontName]
    if (!fontInfo) continue
    
    const localPath = path.join(FONT_DIR, `${fontName}.ttf`)
    
    // Check if already downloaded
    if (await fileExists(localPath)) {
      return localPath
    }
    
    // Try to download
    const success = await downloadFont(fontInfo.url, localPath)
    if (success) {
      return localPath
    }
  }
  
  // Fall back to system fonts
  for (const systemFont of SYSTEM_FONTS) {
    if (await fileExists(systemFont)) {
      console.log(`[Fonts] Using system font: ${systemFont}`)
      return systemFont
    }
  }
  
  console.warn('[Fonts] No fonts available!')
  return null
}

/**
 * Preload all fonts (call at service startup)
 */
export async function preloadFonts(): Promise<void> {
  console.log('[Fonts] Preloading fonts...')
  await ensureFontDir()
  
  const downloadPromises = Object.entries(GOOGLE_FONTS).map(async ([name, info]) => {
    const localPath = path.join(FONT_DIR, `${name}.ttf`)
    
    if (await fileExists(localPath)) {
      console.log(`[Fonts] Font already cached: ${name}`)
      return
    }
    
    await downloadFont(info.url, localPath)
  })
  
  await Promise.allSettled(downloadPromises)
  console.log('[Fonts] Font preload complete')
}

/**
 * Get all available font paths
 */
export async function getAvailableFonts(): Promise<FontInfo[]> {
  await ensureFontDir()
  
  const available: FontInfo[] = []
  
  // Check Google fonts
  for (const [name, info] of Object.entries(GOOGLE_FONTS)) {
    const localPath = path.join(FONT_DIR, `${name}.ttf`)
    if (await fileExists(localPath)) {
      available.push({
        name,
        family: name.split('-')[0],
        weight: info.weight,
        style: info.style,
        localPath,
        url: info.url,
      })
    }
  }
  
  // Check system fonts
  for (const systemFont of SYSTEM_FONTS) {
    if (await fileExists(systemFont)) {
      const name = path.basename(systemFont, '.ttf')
      available.push({
        name,
        family: name.split('-')[0],
        weight: name.includes('Bold') ? 700 : 400,
        style: 'normal',
        localPath: systemFont,
        url: '',
      })
    }
  }
  
  return available
}

/**
 * Get font path by name
 */
export async function getFontPath(fontName: string): Promise<string | null> {
  await ensureFontDir()
  
  const localPath = path.join(FONT_DIR, `${fontName}.ttf`)
  if (await fileExists(localPath)) {
    return localPath
  }
  
  // Try to download if it's a known font
  const fontInfo = GOOGLE_FONTS[fontName]
  if (fontInfo) {
    const success = await downloadFont(fontInfo.url, localPath)
    if (success) {
      return localPath
    }
  }
  
  return null
}

