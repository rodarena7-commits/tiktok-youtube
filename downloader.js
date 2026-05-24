/**
 * downloader.js — Descarga videos de TikTok usando la API de TikWM
 * Sin yt-dlp, sin Python, sin dependencias externas.
 * TikWM es una API pública gratuita: https://www.tikwm.com/
 */

const https = require('https')
const http  = require('http')
const fs    = require('fs')
const path  = require('path')
const os    = require('os')

function getTempPath(jobId) {
  return path.join(os.tmpdir(), `tiktok_${jobId}.mp4`)
}

// ── Petición HTTP/HTTPS genérica ───────────────────────────
function fetchJson(url, postBody = null) {
  return new Promise((resolve, reject) => {
    const isHttps  = url.startsWith('https')
    const client   = isHttps ? https : http
    const headers  = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':     'application/json',
    }

    let reqOpts
    let body = null

    if (postBody) {
      body = new URLSearchParams(postBody).toString()
      const urlObj = new URL(url)
      reqOpts = {
        hostname: urlObj.hostname,
        path:     urlObj.pathname + urlObj.search,
        method:   'POST',
        headers:  { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }
    } else {
      reqOpts = url
    }

    const req = client.request(reqOpts, res => {
      // Seguir redirecciones
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchJson(res.headers.location, postBody).then(resolve).catch(reject)
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error(`Respuesta no válida de la API: ${data.slice(0, 200)}`)) }
      })
    })

    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout al consultar la API')) })
    if (body) req.write(body)
    req.end()
  })
}

// ── Descarga binaria de un archivo ────────────────────────
function downloadFile(fileUrl, outputPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Demasiadas redirecciones'))
    const isHttps = fileUrl.startsWith('https')
    const client  = isHttps ? https : http

    const req = client.get(fileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://www.tiktok.com/',
      },
    }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        return downloadFile(res.headers.location, outputPath, redirects + 1).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Error HTTP ${res.statusCode} al descargar el video`))
      }
      const file = fs.createWriteStream(outputPath)
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve(outputPath) })
      file.on('error', reject)
    })

    req.on('error', reject)
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Timeout al descargar el video')) })
  })
}

// ── Obtener metadatos de un video por URL ─────────────────
async function getTikTokMeta(url) {
  try {
    const data = await fetchJson('https://www.tikwm.com/api/', { url, hd: 1 })
    if (data.code !== 0) return null
    return {
      title:    data.data.title    || '',
      duration: data.data.duration || 0,
      uploader: data.data.author?.unique_id || data.data.author?.nickname || '',
    }
  } catch { return null }
}

// ── Descargar un video de TikTok por su URL pública ───────
async function downloadTikTok(tiktokUrl, outputPath) {
  const data = await fetchJson('https://www.tikwm.com/api/', { url: tiktokUrl, hd: 1 })

  if (data.code !== 0) {
    throw new Error(`TikWM: ${data.msg || 'error desconocido'}`)
  }

  // hdplay = sin marca de agua en HD; play = con marca de agua (fallback)
  const videoUrl = data.data.hdplay || data.data.play
  if (!videoUrl) throw new Error('No se encontró URL de descarga en la respuesta de TikWM')

  await downloadFile(videoUrl, outputPath)
  return outputPath
}

module.exports = { downloadTikTok, getTikTokMeta, getTempPath }
