/**
 * downloader.js — Descarga audio/video de Pixabay y los combina con FFmpeg
 */

const https          = require('https')
const http           = require('http')
const fs             = require('fs')
const path           = require('path')
const os             = require('os')
const { execFile }   = require('child_process')
const ffmpegBin      = require('ffmpeg-static')

function getTempPath(id, ext = 'mp4') {
  return path.join(os.tmpdir(), `music_${id}.${ext}`)
}

// ── Descarga binaria (audio MP3 o video MP4) ──────────────
function downloadFile(fileUrl, outputPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Demasiadas redirecciones'))
    const client = fileUrl.startsWith('https') ? https : http
    const req = client.get(fileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer':    'https://pixabay.com/',
      }
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return downloadFile(res.headers.location, outputPath, redirects + 1).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} descargando archivo`))
      }
      const file = fs.createWriteStream(outputPath)
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve(outputPath) })
      file.on('error', err => { file.close(); reject(err) })
    })
    req.on('error', reject)
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Timeout descargando')) })
  })
}

// ── Combinar audio + video de fondo con FFmpeg ────────────
// El video de fondo se repite en loop hasta que termine el audio.
function createVideo(audioPath, bgVideoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-stream_loop', '-1',       // loop infinito del video de fondo
      '-i', bgVideoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '30',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=24',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ]
    execFile(ffmpegBin, args, { timeout: 600000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`FFmpeg: ${(stderr || '').slice(-400)}`))
      resolve(outputPath)
    })
  })
}

module.exports = { downloadFile, createVideo, getTempPath }
