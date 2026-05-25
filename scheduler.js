/**
 * scheduler.js — Auto-generación de videos de música libre de derechos → YouTube
 *
 * Música:          Jamendo API  (gratis, CC licensed, requiere JAMENDO_CLIENT_ID)
 * Video de fondo:  Pixabay Videos API (gratis, requiere PIXABAY_API_KEY)
 * Creación video:  FFmpeg (ffmpeg-static)
 */

const https        = require('https')
const http         = require('http')
const fs           = require('fs')
const path         = require('path')
const { downloadFile, createVideo, getTempPath } = require('./downloader')
const { uploadToYoutube }                        = require('./youtube')

const HISTORY_FILE = path.join(__dirname, 'uploaded.json')

// ── Categorías musicales ─────────────────────────────────────
const MUSIC_CATEGORIES = [
  {
    id:        'sleep',
    label:     'para Dormir',
    emoji:     '🌙',
    fuzzytags: 'sleep ambient calm relaxing',
    bgQuery:   'night stars moon ocean waves',
    tags:      ['sleep music', 'música para dormir', 'relaxing music', 'calm music', 'no copyright music', 'free music'],
    desc:      'Música relajante y suave para conciliar el sueño. Licencia Creative Commons — libre de derechos.',
  },
  {
    id:        'study',
    label:     'para Estudiar',
    emoji:     '📚',
    fuzzytags: 'study lofi piano acoustic focus',
    bgQuery:   'rain window cozy coffee autumn leaves',
    tags:      ['study music', 'música para estudiar', 'lofi music', 'focus music', 'no copyright music', 'free music'],
    desc:      'Música instrumental de fondo para estudiar y memorizar. Licencia Creative Commons.',
  },
  {
    id:        'focus',
    label:     'para Concentrarse',
    emoji:     '🎯',
    fuzzytags: 'focus concentration work productivity electronic',
    bgQuery:   'abstract minimal flowing geometric blue',
    tags:      ['focus music', 'música para concentrarse', 'productivity music', 'work music', 'no copyright music'],
    desc:      'Música instrumental para mejorar la concentración y productividad. Licencia Creative Commons.',
  },
  {
    id:        'travel',
    label:     'para Viajar',
    emoji:     '✈️',
    fuzzytags: 'travel adventure journey cinematic epic',
    bgQuery:   'mountains landscape sunset road aerial',
    tags:      ['travel music', 'música para viajar', 'adventure music', 'cinematic music', 'no copyright music'],
    desc:      'Música épica e inspiradora para tus viajes y aventuras. Licencia Creative Commons.',
  },
  {
    id:        'ambient',
    label:     'Ambiente',
    emoji:     '🌿',
    fuzzytags: 'ambient nature atmospheric meditation relaxing',
    bgQuery:   'forest nature water stream river peaceful',
    tags:      ['ambient music', 'música ambiente', 'nature sounds', 'meditation music', 'no copyright music'],
    desc:      'Música de ambiente y naturaleza para relajar la mente. Licencia Creative Commons.',
  },
]

// ── HTTP GET → JSON ──────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve).catch(reject)
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        try { resolve(JSON.parse(raw)) }
        catch { reject(new Error(`No JSON (HTTP ${res.statusCode}): ${raw.slice(0, 120)}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')) })
    req.end()
  })
}

// ── Jamendo Music API ────────────────────────────────────────
// Documentación: https://developer.jamendo.com/v3.0/tracks
async function fetchMusicTracks(cat) {
  const clientId = process.env.JAMENDO_CLIENT_ID
  if (!clientId) throw new Error('Falta JAMENDO_CLIENT_ID')

  const url = [
    'https://api.jamendo.com/v3.0/tracks/',
    `?client_id=${encodeURIComponent(clientId)}`,
    '&format=json',
    '&limit=20',
    `&fuzzytags=${encodeURIComponent(cat.fuzzytags)}`,
    '&audioformat=mp32',       // MP3 128kbps
    '&order=popularity_total', // más populares primero
    '&include=musicinfo',
  ].join('')

  const data = await fetchJson(url)

  if (data.headers?.status !== 'success') {
    throw new Error(`Jamendo: ${data.headers?.error_message || JSON.stringify(data.headers).slice(0, 100)}`)
  }
  if (!Array.isArray(data.results) || data.results.length === 0) {
    throw new Error(`Jamendo: 0 resultados para "${cat.fuzzytags}"`)
  }

  return data.results.map(t => ({
    id:       `${cat.id}_${t.id}`,
    trackId:  String(t.id),
    title:    t.name || 'Track',
    audioUrl: t.audiodownload || t.audio,
    duration: t.duration || 0,
    artist:   t.artist_name || '',
    license:  t.license_ccurl || 'https://creativecommons.org/licenses/by/4.0/',
    category: cat,
  })).filter(t => t.audioUrl)
}

// ── Pixabay Videos API (fondos) ─────────────────────────────
async function fetchBackgroundVideoUrl(cat) {
  const key = process.env.PIXABAY_API_KEY
  if (!key) throw new Error('Falta PIXABAY_API_KEY')

  const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(cat.bgQuery)}&per_page=10&order=popular`
  const data = await fetchJson(url)

  if (!Array.isArray(data.hits) || data.hits.length === 0) {
    throw new Error(`Sin videos de fondo para "${cat.bgQuery}"`)
  }
  const pick     = data.hits[Math.floor(Math.random() * data.hits.length)]
  const videoUrl = pick.videos?.medium?.url || pick.videos?.small?.url || pick.videos?.large?.url
  if (!videoUrl) throw new Error('Sin URL de video en respuesta de Pixabay')
  return videoUrl
}

// ── Historial ────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) }
  catch { return { uploaded: [] } }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
}

// ── Pipeline principal ───────────────────────────────────────
async function runAutoUpload(options = {}) {
  const log = options.onLog || console.log

  if (!process.env.JAMENDO_CLIENT_ID) {
    throw new Error('Falta JAMENDO_CLIENT_ID. Obtenerlo gratis en developer.jamendo.com y configurarlo en Render.')
  }
  if (!process.env.PIXABAY_API_KEY) {
    throw new Error('Falta PIXABAY_API_KEY. Obtenerla gratis en pixabay.com/api/ y configurarla en Render.')
  }
  if (!process.env.YOUTUBE_REFRESH_TOKEN) {
    throw new Error('YouTube no autenticado. Visitá /auth primero.')
  }

  const maxPerRun   = parseInt(process.env.MAX_VIDEOS_PER_RUN || '3')
  const privacy     = process.env.AUTO_PRIVACY || 'public'
  const enabledCats = (process.env.MUSIC_CATEGORIES || 'sleep,study,focus,travel,ambient')
    .split(',').map(s => s.trim()).filter(Boolean)

  const history     = loadHistory()
  const uploadedIds = new Set(history.uploaded.map(v => v.trackId))

  log(`🎵 Buscando música en Jamendo (${enabledCats.length} categorías)...`)

  const newTracks = []
  for (const catId of enabledCats) {
    const cat = MUSIC_CATEGORIES.find(c => c.id === catId)
    if (!cat) { log(`   ⚠️  Categoría desconocida: ${catId}`); continue }
    try {
      const tracks = await fetchMusicTracks(cat)
      const fresh  = tracks.filter(t => !uploadedIds.has(t.trackId))
      log(`   ${cat.emoji} ${cat.label}: ${fresh.length} pistas nuevas de ${tracks.length}`)
      newTracks.push(...fresh)
    } catch (e) {
      log(`   ⚠️  ${catId}: ${e.message}`)
    }
  }

  if (newTracks.length === 0) {
    log('✅ Sin novedades — todos los tracks ya están en YouTube')
    return { uploaded: 0, skipped: history.uploaded.length, newFound: 0 }
  }

  log(`🆕 ${newTracks.length} pistas nuevas — procesando hasta ${maxPerRun}`)

  const toUpload    = newTracks.slice(0, maxPerRun)
  let uploadedCount = 0
  const results     = []

  for (let i = 0; i < toUpload.length; i++) {
    const track      = toUpload[i]
    const cat        = track.category
    const jobId      = `${cat.id}_${track.trackId}`
    const safeTitle  = track.title.replace(/[<>:"\/\\|?*\n]/g, ' ').trim().slice(0, 60)
    const ytTitle    = `${cat.emoji} Música ${cat.label} - ${safeTitle} | Sin Derechos de Autor`
    const dur        = `${Math.floor(track.duration / 60)}m${String(track.duration % 60).padStart(2, '0')}s`

    const description = [
      ytTitle,
      '',
      cat.desc,
      '',
      '🎵 Música libre de derechos de autor (licencia Creative Commons).',
      'Podés usarla en tus propios videos sin restricciones.',
      '',
      `🎼 Artista: ${track.artist}`,
      `📀 Título:  ${track.title}`,
      `⚖️  Licencia: ${track.license}`,
      `🔗 Fuente:  https://www.jamendo.com`,
      '',
      'Video de fondo: Pixabay (https://pixabay.com/videos/)',
      '',
      '#MusicaLibre #SinDerechos #CreativeCommons #FreeMusic #RoyaltyFree #NocopyrightMusic',
    ].join('\n')

    const audioPath  = getTempPath(jobId, 'mp3')
    const bgPath     = getTempPath(jobId + '_bg', 'mp4')
    const outputPath = getTempPath(jobId + '_out', 'mp4')

    try {
      log(`[${i + 1}/${toUpload.length}] ${cat.emoji} "${safeTitle}" por ${track.artist} (${dur})`)

      log(`[${i + 1}/${toUpload.length}] ⬇️  Descargando audio de Jamendo...`)
      await downloadFile(track.audioUrl, audioPath)

      log(`[${i + 1}/${toUpload.length}] 🎬  Obteniendo video de fondo de Pixabay...`)
      const bgUrl = await fetchBackgroundVideoUrl(cat)
      await downloadFile(bgUrl, bgPath)

      log(`[${i + 1}/${toUpload.length}] 🎞️  Creando video con FFmpeg...`)
      await createVideo(audioPath, bgPath, outputPath)

      log(`[${i + 1}/${toUpload.length}] ⬆️  Subiendo a YouTube...`)
      const result = await uploadToYoutube({
        videoPath:   outputPath,
        title:       ytTitle.slice(0, 100),
        description,
        tags:        cat.tags,
        privacy,
      })

      const ytUrl = `https://www.youtube.com/watch?v=${result.id}`
      log(`[${i + 1}/${toUpload.length}] ✅ ${ytUrl}`)

      const entry = {
        trackId:    track.trackId,
        category:   cat.id,
        title:      track.title,
        artist:     track.artist,
        youtubeId:  result.id,
        youtubeUrl: ytUrl,
        uploadedAt: new Date().toISOString(),
      }
      history.uploaded.push(entry)
      saveHistory(history)
      results.push(entry)
      uploadedCount++

    } catch (e) {
      log(`[${i + 1}/${toUpload.length}] ❌ Error: ${e.message}`)
      results.push({ trackId: track.trackId, error: e.message })
    } finally {
      for (const p of [audioPath, bgPath, outputPath]) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch {}
      }
    }

    if (i < toUpload.length - 1) {
      await new Promise(r => setTimeout(r, 10000))
    }
  }

  return {
    uploaded: uploadedCount,
    failed:   toUpload.length - uploadedCount,
    newFound: newTracks.length,
    skipped:  history.uploaded.length,
    results,
  }
}

// ── Scheduler periódico ──────────────────────────────────────
let schedulerTimer = null
let lastRunAt      = null
let lastRunResult  = null
let isRunning      = false

function startScheduler() {
  const hours = parseFloat(process.env.AUTO_INTERVAL_HOURS || '6')
  const ms    = Math.max(1, hours) * 60 * 60 * 1000
  console.log(`⏰ Scheduler iniciado — generará videos cada ${hours}h`)
  setTimeout(() => triggerRun('startup'), 30 * 1000)
  schedulerTimer = setInterval(() => triggerRun('scheduled'), ms)
}

function stopScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null }
}

function triggerRun(source = 'manual') {
  if (isRunning) return { error: 'Ya hay una generación en curso' }
  isRunning     = true
  lastRunAt     = new Date().toISOString()
  lastRunResult = null

  const logs  = []
  const onLog = msg => { console.log(msg); logs.push({ time: new Date().toISOString(), msg }) }

  onLog(`🚀 [${source}] Iniciando generación de videos...`)

  runAutoUpload({ onLog })
    .then(result => {
      lastRunResult = { ok: true, ...result, logs, finishedAt: new Date().toISOString() }
      onLog(`🏁 Finalizado: ${result.uploaded} subidos, ${result.skipped} ya existentes`)
    })
    .catch(err => {
      lastRunResult = { ok: false, error: err.message, logs, finishedAt: new Date().toISOString() }
      console.error(`❌ Generación falló: ${err.message}`)
    })
    .finally(() => { isRunning = false })

  return { started: true }
}

function getSchedulerStatus() {
  return {
    running:          isRunning,
    lastRunAt,
    lastRunResult,
    intervalHours:    parseFloat(process.env.AUTO_INTERVAL_HOURS || '6'),
    categories:       (process.env.MUSIC_CATEGORIES || 'sleep,study,focus,travel,ambient').split(','),
    ytConfigured:     !!process.env.YOUTUBE_REFRESH_TOKEN,
    jamendoConfigured: !!process.env.JAMENDO_CLIENT_ID,
    pixabayConfigured: !!process.env.PIXABAY_API_KEY,
  }
}

module.exports = { startScheduler, stopScheduler, triggerRun, getSchedulerStatus, loadHistory }
