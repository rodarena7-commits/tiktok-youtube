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

const https = require('https')
const http  = require('http')
const fs    = require('fs')
const path  = require('path')
const zlib  = require('zlib')
const { downloadTikTok, getTempPath } = require('./downloader')
const { uploadToYoutube } = require('./youtube')

const HISTORY_FILE = path.join(__dirname, 'uploaded.json')

// ── Petición GET → JSON (con headers extra opcionales) ─────
function fetchJson(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.tikwm.com/',
        ...extraHeaders,
      }
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchJson(res.headers.location, extraHeaders).then(resolve).catch(reject)
      }
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error(`Respuesta no JSON (HTTP ${res.statusCode}): ${data.slice(0, 300)}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')) })
    req.end()
  })
}

// ── Fetch de HTML/texto con descompresión gzip/deflate ─────
function fetchText(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        ...extraHeaders,
      }
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchText(res.headers.location, extraHeaders).then(resolve).catch(reject)
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const enc = (res.headers['content-encoding'] || '').toLowerCase()
        const done = (err, d) => err ? reject(err) : resolve(d.toString('utf8'))
        if (enc === 'gzip')    zlib.gunzip(buf, done)
        else if (enc === 'deflate') zlib.inflate(buf, done)
        else resolve(buf.toString('utf8'))
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

// ── Historial ───────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) }
  catch { return { uploaded: [] } }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
}

// ── Método A: TikTok API interna (ajax endpoints de tiktok.com) ─
async function fetchTikTokDirect(username, limit) {
  const base = 'aid=1988&app_name=tiktok_web&device_platform=web_pc&region=US&priority_region=US&os=web'

  // Paso 1: obtener secUid del usuario
  let secUid
  try {
    const raw = await fetchText(
      `https://www.tiktok.com/api/user/detail/?uniqueId=${encodeURIComponent(username)}&${base}`,
      { 'Referer': 'https://www.tiktok.com/', 'Accept': 'application/json' }
    )
    const json = JSON.parse(raw)
    secUid = json?.userInfo?.user?.secUid
    if (!secUid) throw new Error(`secUid no encontrado — statusCode=${json?.statusCode}`)
  } catch (e) {
    throw new Error(`user/detail: ${e.message}`)
  }

  // Paso 2: obtener lista de videos
  const raw2 = await fetchText(
    `https://www.tiktok.com/api/post/item_list/?secUid=${encodeURIComponent(secUid)}&count=${limit}&cursor=0&type=1&${base}`,
    { 'Referer': `https://www.tiktok.com/@${username}`, 'Accept': 'application/json' }
  )
  const json2 = JSON.parse(raw2)

  if (!Array.isArray(json2?.itemList) || json2.itemList.length === 0) {
    throw new Error(`itemList vacío — statusCode=${json2?.statusCode}`)
  }

  console.log(`✅ Fuente: TikTok API interna (${json2.itemList.length} videos)`)
  return json2.itemList.map(v => ({
    id:          v.id,
    webpage_url: `https://www.tiktok.com/@${username}/video/${v.id}`,
    description: v.desc || '',
    title:       v.desc || '',
  }))
}

// ── Método B: Proxitok RSS (instancias públicas) ───────────
const PROXITOK_INSTANCES = [
  'https://proxitok.pabloferreiro.es',
  'https://tiktok.privacydev.net',
  'https://tok.habedieeh.re',
  'https://proxitok.heitkonig.net',
]

function parseRssVideos(xml, limit) {
  const videos = []
  // Handle both RSS (<item>) and Atom (<entry>) formats
  const re = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g
  let m
  while ((m = re.exec(xml)) && videos.length < limit) {
    const block = m[1]
    // Atom: <link href="..."/> or RSS: <link>...</link>
    const link = (block.match(/<link[^>]+href="([^"]+)"/) ||
                  block.match(/<link>\s*(.*?)\s*<\/link>/) || [])[1] || ''
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''
    const clean = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').trim()
    const idMatch = link.match(/\/video\/(\d+)/)
    if (idMatch) {
      videos.push({
        id:          idMatch[1],
        webpage_url: link.split('?')[0],
        description: clean(title),
        title:       clean(title),
      })
    }
  }
  return videos
}

async function fetchTikTokProxitok(username, limit) {
  const errors = []
  for (const inst of PROXITOK_INSTANCES) {
    try {
      const xml = await fetchText(`${inst}/@${username}/rss`)
      if (!xml.includes('<item')) throw new Error(`Respuesta no RSS (${xml.length} chars)`)
      const videos = parseRssVideos(xml, limit)
      if (videos.length > 0) {
        console.log(`✅ Fuente: Proxitok ${inst} (${videos.length} videos)`)
        return videos
      }
      throw new Error('Feed RSS vacío (0 items)')
    } catch (e) {
      errors.push(`${inst.replace('https://', '')}: ${e.message}`)
    }
  }
  throw new Error(`Proxitok: ${errors.join(' | ')}`)
}

// ── Método C: RapidAPI tiktok-api23 (requiere RAPIDAPI_KEY) ─
async function fetchTikTokRapidAPI(username, limit) {
  const url = `https://tiktok-api23.p.rapidapi.com/api/user/posts?unique_id=${encodeURIComponent('@' + username)}&count=${limit}&cursor=0`
  const data = await fetchJson(url, {
    'x-rapidapi-key':  process.env.RAPIDAPI_KEY,
    'x-rapidapi-host': 'tiktok-api23.p.rapidapi.com',
  })
  if (data.code === 0 && Array.isArray(data.data?.videos)) {
    console.log(`✅ Fuente: RapidAPI (${data.data.videos.length} videos)`)
    return data.data.videos.map(v => ({
      id:          v.video_id || v.id,
      webpage_url: `https://www.tiktok.com/@${username}/video/${v.video_id || v.id}`,
      description: v.title || v.desc || '',
      title:       v.title || v.desc || '',
    }))
  }
  throw new Error(`RapidAPI: code=${data.code} msg=${data.msg || JSON.stringify(data).slice(0, 80)}`)
}

// ── Obtener lista de videos del perfil — 4 métodos de respaldo ─
async function fetchProfileVideos(username, limit = 30) {

  // A: Scraping directo tiktok.com (gratis, sin clave)
  try {
    return await fetchTikTokDirect(username, limit)
  } catch (e) {
    console.log(`⚠️  TikTok directo: ${e.message}`)
  }

  // B: Proxitok RSS (gratis, sin clave)
  try {
    return await fetchTikTokProxitok(username, limit)
  } catch (e) {
    console.log(`⚠️  Proxitok: ${e.message}`)
  }

  // C: RapidAPI (si está configurado)
  if (process.env.RAPIDAPI_KEY) {
    try {
      return await fetchTikTokRapidAPI(username, limit)
    } catch (e) {
      console.log(`⚠️  RapidAPI: ${e.message}`)
    }
  } else {
    console.log('ℹ️  Sin RAPIDAPI_KEY — omitiendo RapidAPI (agregala en Render para mayor fiabilidad)')
  }

  // D: TikWM (fallback original, bloqueado por Cloudflare desde servidores cloud)
  try {
    const url  = `https://www.tikwm.com/api/user/posts?unique_id=${encodeURIComponent(username)}&count=${limit}&cursor=0&web=1`
    const data = await fetchJson(url)
    if (data.code === 0 && Array.isArray(data.data?.videos)) {
      console.log('✅ Fuente: TikWM /api/user/posts')
      return data.data.videos.map(v => ({
        id:          v.video_id,
        webpage_url: `https://www.tiktok.com/@${username}/video/${v.video_id}`,
        description: v.title || '',
        title:       v.title || '',
      }))
    }
    console.log(`⚠️  TikWM: code=${data.code} msg=${data.msg}`)
  } catch (e) {
    console.log(`⚠️  TikWM: ${e.message}`)
  }

  throw new Error(
    'Todas las fuentes de videos fallaron.\n' +
    '  • Si los métodos gratuitos siguen fallando, configurá RAPIDAPI_KEY en Render.\n' +
    '  • Registrarse en rapidapi.com → buscar "tiktok-api23" → copiar la API Key.'
  )
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
