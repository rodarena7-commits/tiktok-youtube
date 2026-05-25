/**
 * scheduler.js — Auto-generación de videos de música libre de derechos → YouTube
 *
 * Pipeline:
 *   1. Busca pistas en Pixabay Music API (gratis, sin atribución requerida)
 *   2. Obtiene un video de fondo de Pixabay Videos API
 *   3. Combina audio + video con FFmpeg
 *   4. Sube el resultado a YouTube automáticamente
 */

const https        = require('https')
const http         = require('http')
const fs           = require('fs')
const path         = require('path')
const { downloadFile, createVideo, getTempPath } = require('./downloader')
const { uploadToYoutube }                        = require('./youtube')

const HISTORY_FILE = path.join(__dirname, 'uploaded.json')

// ── Definición de categorías musicales ───────────────────────
const MUSIC_CATEGORIES = [
  {
    id:      'sleep',
    label:   'para Dormir',
    emoji:   '🌙',
    query:   'sleep relaxing calm peaceful night',
    bgQuery: 'night stars moon ocean waves',
    tags:    ['sleep music', 'música para dormir', 'relaxing music', 'calm music', 'no copyright music', 'free music'],
    desc:    'Música relajante y suave para conciliar el sueño. Sin derechos de autor.',
  },
  {
    id:      'study',
    label:   'para Estudiar',
    emoji:   '📚',
    query:   'study lofi piano acoustic background',
    bgQuery: 'rain window cozy coffee autumn',
    tags:    ['study music', 'música para estudiar', 'lofi music', 'focus music', 'no copyright music', 'free music'],
    desc:    'Música instrumental de fondo para estudiar y memorizar. Sin derechos de autor.',
  },
  {
    id:      'focus',
    label:   'para Concentrarse',
    emoji:   '🎯',
    query:   'focus concentration work productivity instrumental',
    bgQuery: 'abstract minimal flowing geometric blue',
    tags:    ['focus music', 'música para concentrarse', 'productivity music', 'work music', 'no copyright music'],
    desc:    'Música instrumental para mejorar la concentración y productividad. Sin derechos de autor.',
  },
  {
    id:      'travel',
    label:   'para Viajar',
    emoji:   '✈️',
    query:   'travel adventure journey cinematic epic',
    bgQuery: 'mountains landscape sunset road aerial',
    tags:    ['travel music', 'música para viajar', 'adventure music', 'cinematic music', 'no copyright music'],
    desc:    'Música épica e inspiradora para tus viajes y aventuras. Sin derechos de autor.',
  },
  {
    id:      'ambient',
    label:   'Ambiente',
    emoji:   '🌿',
    query:   'ambient nature atmosphere atmospheric meditation',
    bgQuery: 'forest nature water stream river peaceful',
    tags:    ['ambient music', 'música ambiente', 'nature sounds', 'meditation music', 'no copyright music'],
    desc:    'Música de ambiente y naturaleza para relajar la mente. Sin derechos de autor.',
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
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
        catch { reject(new Error(`No JSON (HTTP ${res.statusCode}): ${Buffer.concat(chunks).toString().slice(0, 100)}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')) })
    req.end()
  })
}

// ── Pixabay Music API ────────────────────────────────────────
async function fetchMusicTracks(cat) {
  const key = process.env.PIXABAY_API_KEY
  const url = `https://pixabay.com/api/music/?key=${key}&q=${encodeURIComponent(cat.query)}&per_page=20&order=popular`
  const data = await fetchJson(url)
  if (!Array.isArray(data.hits)) throw new Error(`Pixabay Music: ${JSON.stringify(data).slice(0, 100)}`)
  return data.hits.map(h => ({
    id:        `${cat.id}_${h.id}`,
    pixabayId: String(h.id),
    title:     h.title || (h.tags || '').split(',')[0]?.trim() || 'Track',
    audioUrl:  h.audio,
    duration:  h.duration || 0,
    category:  cat,
  }))
}

// ── Pixabay Videos API (fondos) ─────────────────────────────
async function fetchBackgroundVideoUrl(cat) {
  const key = process.env.PIXABAY_API_KEY
  const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(cat.bgQuery)}&per_page=10&order=popular`
  const data = await fetchJson(url)
  if (!Array.isArray(data.hits) || data.hits.length === 0) {
    throw new Error(`Sin videos de fondo para "${cat.bgQuery}"`)
  }
  // Elegir al azar entre los primeros resultados para variedad
  const pick    = data.hits[Math.floor(Math.random() * data.hits.length)]
  const videoUrl = pick.videos?.medium?.url || pick.videos?.small?.url || pick.videos?.large?.url
  if (!videoUrl) throw new Error('Sin URL en respuesta de Pixabay Videos')
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
  const uploadedIds = new Set(history.uploaded.map(v => v.pixabayId))

  log(`🎵 Buscando música libre de derechos en ${enabledCats.length} categorías...`)

  // Recolectar tracks nuevos de todas las categorías
  const newTracks = []
  for (const catId of enabledCats) {
    const cat = MUSIC_CATEGORIES.find(c => c.id === catId)
    if (!cat) { log(`   ⚠️  Categoría desconocida: ${catId}`); continue }
    try {
      const tracks = await fetchMusicTracks(cat)
      const fresh  = tracks.filter(t => !uploadedIds.has(t.pixabayId))
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

  const toUpload      = newTracks.slice(0, maxPerRun)
  let uploadedCount   = 0
  const results       = []

  for (let i = 0; i < toUpload.length; i++) {
    const track   = toUpload[i]
    const cat     = track.category
    const jobId   = `${cat.id}_${track.pixabayId}`
    const safeTitle = track.title.replace(/[<>:"\/\\|?*\n]/g, ' ').trim().slice(0, 60)
    const ytTitle   = `${cat.emoji} Música ${cat.label} - ${safeTitle} | Sin Derechos de Autor`

    const description = [
      `${ytTitle}`,
      '',
      cat.desc,
      '',
      '🎵 Música 100% libre de derechos de autor.',
      'Podés usarla en tus propios videos sin restricciones.',
      '',
      `Fuente de audio: Pixabay Music — https://pixabay.com/music/`,
      `Fuente de video: Pixabay — https://pixabay.com/videos/`,
      '(Licencia libre de derechos Pixabay — no se requiere atribución)',
      '',
      '#MusicaLibre #SinDerechos #NocopyrightMusic #FreeMusic #RoyaltyFree',
    ].join('\n')

    const audioPath  = getTempPath(jobId, 'mp3')
    const bgPath     = getTempPath(jobId + '_bg', 'mp4')
    const outputPath = getTempPath(jobId + '_out', 'mp4')

    try {
      log(`[${i + 1}/${toUpload.length}] ${cat.emoji} "${safeTitle}" (${Math.floor(track.duration / 60)}m${track.duration % 60}s)`)
      log(`[${i + 1}/${toUpload.length}] ⬇️  Descargando audio...`)
      await downloadFile(track.audioUrl, audioPath)

      log(`[${i + 1}/${toUpload.length}] 🎬  Obteniendo video de fondo...`)
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
        pixabayId:  track.pixabayId,
        category:   cat.id,
        title:      track.title,
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
      results.push({ pixabayId: track.pixabayId, error: e.message })
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
  isRunning  = true
  lastRunAt  = new Date().toISOString()
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
    running:           isRunning,
    lastRunAt,
    lastRunResult,
    intervalHours:     parseFloat(process.env.AUTO_INTERVAL_HOURS || '6'),
    categories:        (process.env.MUSIC_CATEGORIES || 'sleep,study,focus,travel,ambient').split(','),
    ytConfigured:      !!process.env.YOUTUBE_REFRESH_TOKEN,
    pixabayConfigured: !!process.env.PIXABAY_API_KEY,
  }
}

module.exports = { startScheduler, stopScheduler, triggerRun, getSchedulerStatus, loadHistory }
