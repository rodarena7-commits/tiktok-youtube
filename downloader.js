/**
 * downloader.js — Descarga audio/video de Pixabay y los combina con FFmpeg
 */

const https        = require('https')
const http         = require('http')
const fs           = require('fs')
const path         = require('path')
const os           = require('os')
const { spawn }    = require('child_process')
const ffmpegBin    = require('ffmpeg-static')

function getTempPath(id, ext = 'mp4') {
  return path.join(os.tmpdir(), `music_${id}.${ext}`)
}

const MB  = bytes => (bytes / 1048576).toFixed(1)
const fmt = secs  => {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`
}

// ── Descarga binaria con progreso ─────────────────────────────
// onProgress({ pct, receivedMB, totalMB, elapsed, done })
function downloadFile(fileUrl, outputPath, onProgress = null, redirects = 0) {
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
        return downloadFile(res.headers.location, outputPath, onProgress, redirects + 1)
          .then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} descargando archivo`))
      }

      const total     = parseInt(res.headers['content-length'] || '0')
      let received    = 0
      let lastPctStep = -1
      const startTime = Date.now()

      const file = fs.createWriteStream(outputPath)
      res.on('data', chunk => {
        received += chunk.length
        file.write(chunk)
        if (onProgress && total > 0) {
          const pct  = Math.floor(received / total * 100)
          const step = Math.floor(pct / 25) * 25  // reportar en 0, 25, 50, 75
          if (step > lastPctStep) {
            lastPctStep = step
            onProgress({
              pct:        step,
              receivedMB: MB(received),
              totalMB:    MB(total),
              elapsed:    (Date.now() - startTime) / 1000,
            })
          }
        }
      })
      res.on('end', () => {
        file.end()
        if (onProgress) {
          onProgress({
            pct:        100,
            receivedMB: MB(received),
            totalMB:    MB(total || received),
            elapsed:    (Date.now() - startTime) / 1000,
            done:       true,
          })
        }
        resolve(outputPath)
      })
      file.on('error', err => { file.close(); reject(err) })
    })
    req.on('error', reject)
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Timeout descargando')) })
  })
}

// ── Combinar audio + video de fondo con FFmpeg ────────────────
// durationSecs: duración del audio (para calcular % de progreso)
// onProgress({ pct, elapsed, remaining, done })
function createVideo(audioPath, bgVideoPath, outputPath, durationSecs = 0, onProgress = null) {
  return new Promise((resolve, reject) => {
    const args = [
      '-progress', 'pipe:1',    // progreso machine-readable a stdout
      '-loglevel',  'error',    // solo errores a stderr
      '-stream_loop', '-1',
      '-i', bgVideoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '32',
      '-threads', '1',
      '-vf', 'scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ]

    const proc      = spawn(ffmpegBin, args)
    let stderr      = ''
    let lastPct     = -1
    const startTime = Date.now()
    let buf         = ''

    proc.stdout.on('data', data => {
      buf += data.toString()
      // FFmpeg emite bloques terminados en \n\n; procesar cuando tengamos suficiente
      const lines = buf.split('\n')
      buf = lines.pop()  // guardar línea incompleta
      for (const line of lines) {
        const m = line.match(/^out_time_ms=(\d+)/)
        if (m && durationSecs > 0 && onProgress) {
          const currentSecs = parseInt(m[1]) / 1000000
          const pct         = Math.min(99, Math.floor(currentSecs / durationSecs * 100))
          if (pct >= lastPct + 20) {  // reportar cada 20%
            lastPct = pct
            const elapsed    = (Date.now() - startTime) / 1000
            const remaining  = pct > 5 ? (elapsed / pct * (100 - pct)) : null
            onProgress({ pct, elapsed, remaining })
          }
        }
      }
    })

    proc.stderr.on('data', d => { stderr += d.toString() })

    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`FFmpeg (código ${code}): ${stderr.slice(-400)}`))
      }
      const elapsed = (Date.now() - startTime) / 1000
      if (onProgress) onProgress({ pct: 100, elapsed, done: true })
      resolve(outputPath)
    })

    // Timeout de seguridad
    setTimeout(() => {
      proc.kill()
      reject(new Error('FFmpeg timeout (10 min)'))
    }, 600000)
  })
}

module.exports = { downloadFile, createVideo, getTempPath, fmt, MB }
