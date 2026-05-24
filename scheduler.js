/**
 * scheduler.js — Auto-upload de TikTok → YouTube
 *
 * Escanea el perfil de TikTok configurado, detecta videos nuevos
 * y los sube automáticamente a YouTube.
 *
 * Persistencia del historial:
 *   - Se guarda en uploaded.json junto al código.
 *   - En Render FREE el filesystem se resetea con cada deploy;
 *     activar "Disk" en Render ($0.25/GB/mes) para persistencia real.
 */

const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { downloadTikTok, getTempPath } = require('./downloader')
const { uploadToYoutube } = require('./youtube')

const HISTORY_FILE = path.join(__dirname, 'uploaded.json')

// Escribe las cookies (desde env var) a un archivo temporal y devuelve la ruta
function getCookiesArg() {
  const content = process.env.TIKTOK_COOKIES
  if (!content || !content.trim()) return ''
  const cookiesPath = path.join(os.tmpdir(), 'tiktok_cookies.txt')
  fs.writeFileSync(cookiesPath, content)
  return `--cookies "${cookiesPath}"`
}

// ── Historial ───────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) }
  catch { return { uploaded: [] } }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
}

// ── Obtener lista de videos del perfil de TikTok ────────────
function fetchProfileVideos(username, limit = 20) {
  return new Promise((resolve, reject) => {
    const cookiesArg = getCookiesArg()
    // yt-dlp lista el perfil sin descargar nada (--flat-playlist)
    const cmd = [
      'yt-dlp',
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--ignore-errors',
      '--impersonate chrome',
      `--playlist-end ${limit}`,
      cookiesArg,
      `"https://www.tiktok.com/@${username}"`,
    ].filter(Boolean).join(' ')

    exec(cmd, { timeout: 90000 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message))
      const videos = stdout.trim().split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line) } catch { return null } })
        .filter(Boolean)
      resolve(videos)
    })
  })
}

// ── Lógica principal de auto-subida ─────────────────────────
async function runAutoUpload(options = {}) {
  const log = options.onLog || console.log

  const username    = process.env.TIKTOK_USERNAME || 'mrbeats'
  const maxPerRun   = parseInt(process.env.MAX_VIDEOS_PER_RUN || '5')
  const privacy     = process.env.AUTO_PRIVACY || 'public'
  const extraTags   = (process.env.AUTO_TAGS || 'mrbeats,tiktok,shorts,beats,música')
    .split(',').map(t => t.trim()).filter(Boolean)
  const extraDesc   = process.env.AUTO_DESCRIPTION || ''

  if (!process.env.YOUTUBE_REFRESH_TOKEN) {
    throw new Error('YouTube no autenticado. Visitá /auth primero.')
  }

  log(`🔍 Escaneando TikTok @${username}...`)

  const history    = loadHistory()
  const uploadedIds = new Set(history.uploaded.map(v => v.tiktokId))

  let videos
  try {
    videos = await fetchProfileVideos(username, 30)
  } catch (e) {
    throw new Error(`Error al listar TikTok @${username}: ${e.message}`)
  }

  log(`📋 ${videos.length} videos encontrados en TikTok`)

  const newVideos = videos.filter(v => v.id && !uploadedIds.has(v.id))
  log(`🆕 ${newVideos.length} videos nuevos para subir`)

  if (newVideos.length === 0) {
    log('✅ Sin novedades — ya están todos subidos')
    return { uploaded: 0, skipped: videos.length, newFound: 0 }
  }

  // Subir de más antiguo a más nuevo (slice desde el final)
  const toUpload = newVideos.slice(-maxPerRun)
  let uploadedCount = 0
  const results = []

  for (let i = 0; i < toUpload.length; i++) {
    const video = toUpload[i]
    const tiktokUrl = video.webpage_url || `https://www.tiktok.com/@${username}/video/${video.id}`

    // Título: descripción del TikTok (max 100 chars)
    const rawTitle = (video.description || video.title || '').replace(/\n/g, ' ').trim()
    const title = (rawTitle || `Beat de @${username}`).slice(0, 100)

    const description = [
      rawTitle,
      '',
      `Video original de @${username} en TikTok.`,
      tiktokUrl,
      extraDesc,
      '',
      '#Shorts #' + username + ' #TikTok #Beats',
    ].filter(l => l !== undefined).join('\n').trim()

    log(`[${i + 1}/${toUpload.length}] ⬇️  Descargando: ${title}`)

    const jobId = `auto_${video.id}`
    const videoPath = getTempPath(jobId)

    try {
      await downloadTikTok(tiktokUrl, videoPath)

      log(`[${i + 1}/${toUpload.length}] ⬆️  Subiendo: ${title}`)

      const result = await uploadToYoutube({
        videoPath,
        title,
        description,
        tags: extraTags,
        privacy,
      })

      const ytUrl = `https://www.youtube.com/watch?v=${result.id}`
      log(`[${i + 1}/${toUpload.length}] ✅ ${ytUrl}`)

      const entry = {
        tiktokId:   video.id,
        tiktokUrl,
        youtubeId:  result.id,
        youtubeUrl: ytUrl,
        title,
        uploadedAt: new Date().toISOString(),
      }
      history.uploaded.push(entry)
      saveHistory(history)
      results.push(entry)
      uploadedCount++

    } catch (e) {
      log(`[${i + 1}/${toUpload.length}] ❌ Error en ${video.id}: ${e.message}`)
      results.push({ tiktokId: video.id, error: e.message })
    } finally {
      try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath) } catch {}
    }

    // Pausa de 15s entre subidas para no saturar la API de YouTube
    if (i < toUpload.length - 1) {
      await new Promise(r => setTimeout(r, 15000))
    }
  }

  return {
    uploaded:  uploadedCount,
    failed:    toUpload.length - uploadedCount,
    newFound:  newVideos.length,
    skipped:   videos.length - newVideos.length,
    results,
  }
}

// ── Iniciar scheduler periódico ──────────────────────────────
let schedulerTimer = null
let lastRunAt      = null
let lastRunResult  = null
let isRunning      = false

function startScheduler() {
  const hours = parseFloat(process.env.AUTO_INTERVAL_HOURS || '6')
  const ms    = Math.max(1, hours) * 60 * 60 * 1000

  console.log(`⏰ Scheduler iniciado — revisará TikTok cada ${hours}h`)

  // Primera ejecución al arrancar (con 30s de delay para que YouTube esté listo)
  setTimeout(() => triggerRun('startup'), 30 * 1000)

  // Luego cada N horas
  schedulerTimer = setInterval(() => triggerRun('scheduled'), ms)
}

function stopScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null }
}

function triggerRun(source = 'manual') {
  if (isRunning) return { error: 'Ya hay una subida en curso' }
  isRunning = true
  lastRunAt = new Date().toISOString()
  lastRunResult = null

  const logs = []
  const onLog = msg => { console.log(msg); logs.push({ time: new Date().toISOString(), msg }) }

  onLog(`🚀 [${source}] Iniciando auto-upload...`)

  runAutoUpload({ onLog })
    .then(result => {
      lastRunResult = { ok: true, ...result, logs, finishedAt: new Date().toISOString() }
      onLog(`🏁 Finalizado: ${result.uploaded} subidos, ${result.skipped} ya existentes`)
    })
    .catch(err => {
      lastRunResult = { ok: false, error: err.message, logs, finishedAt: new Date().toISOString() }
      console.error(`❌ Auto-upload falló: ${err.message}`)
    })
    .finally(() => { isRunning = false })

  return { started: true }
}

function getSchedulerStatus() {
  return {
    running:        isRunning,
    lastRunAt,
    lastRunResult,
    intervalHours:  parseFloat(process.env.AUTO_INTERVAL_HOURS || '6'),
    tiktokUsername: process.env.TIKTOK_USERNAME || 'mrbeats',
    ytConfigured:   !!process.env.YOUTUBE_REFRESH_TOKEN,
  }
}

module.exports = { startScheduler, stopScheduler, triggerRun, getSchedulerStatus, loadHistory }
