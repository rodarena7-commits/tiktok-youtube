const express = require('express')
const fs = require('fs')
const path = require('path')
const { getAuthUrl, handleCallback, uploadToYoutube } = require('./youtube')
const { downloadTikTok, getTikTokMeta, getTempPath } = require('./downloader')
const { startScheduler, triggerRun, getSchedulerStatus, loadHistory } = require('./scheduler')

const app = express()
app.use(express.json())
app.use(express.static('public'))

const PORT = process.env.PORT || 3000
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || 'admin123'

// Jobs en memoria: { jobId: { status, progress, error, videoUrl } }
const jobs = new Map()

// ── Auth YouTube ────────────────────────────────────────────
app.get('/auth', (req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    return res.status(500).send(`
      <h2>❌ Faltan variables de entorno</h2>
      <p>Configurá en Render:</p>
      <ul>
        <li><b>YOUTUBE_CLIENT_ID</b></li>
        <li><b>YOUTUBE_CLIENT_SECRET</b></li>
        <li><b>YOUTUBE_REDIRECT_URI</b> → https://tu-app.onrender.com/auth/callback</li>
      </ul>
    `)
  }
  res.redirect(getAuthUrl())
})

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query
  if (!code) return res.status(400).send('Código faltante')
  try {
    const refreshToken = await handleCallback(code)
    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head><meta charset="UTF-8"><title>Autenticado</title>
      <style>body{font-family:sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem}
      code{background:#f3f4f6;padding:0.5rem 1rem;border-radius:8px;display:block;word-break:break-all;margin:1rem 0;font-size:0.85rem}
      .ok{color:#16a34a;font-size:1.5rem}</style></head>
      <body>
        <p class="ok">✅ Canal de YouTube autenticado</p>
        <h2>Copiá este Refresh Token</h2>
        <code>${refreshToken}</code>
        <h3>Próximo paso:</h3>
        <ol>
          <li>Andá a tu servicio en <b>Render → Environment</b></li>
          <li>Agregá la variable: <b>YOUTUBE_REFRESH_TOKEN</b> = el token de arriba</li>
          <li>Redeploy el servicio</li>
          <li>Listo — podés cerrar esta ventana</li>
        </ol>
        <a href="/">← Volver al inicio</a>
      </body></html>
    `)
  } catch (e) {
    res.status(500).send(`<h2>❌ Error: ${e.message}</h2><a href="/auth">Intentar de nuevo</a>`)
  }
})

// ── Obtener metadatos del TikTok (subida manual) ────────────
app.post('/meta', async (req, res) => {
  const { password, url } = req.body
  if (password !== UPLOAD_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' })
  if (!url) return res.status(400).json({ error: 'URL requerida' })
  const meta = await getTikTokMeta(url)
  res.json(meta || {})
})

// ── Iniciar descarga + subida manual ───────────────────────
app.post('/upload', async (req, res) => {
  const { password, url, title, description, tags, privacy } = req.body
  if (password !== UPLOAD_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' })
  if (!url) return res.status(400).json({ error: 'URL de TikTok requerida' })
  if (!process.env.YOUTUBE_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'YouTube no autenticado. Visitá /auth primero.' })
  }

  const jobId = Date.now().toString()
  jobs.set(jobId, { status: 'downloading', progress: 0, error: null, videoUrl: null })
  res.json({ jobId })

  const videoPath = getTempPath(jobId)
  ;(async () => {
    try {
      jobs.set(jobId, { status: 'downloading', progress: 0, error: null, videoUrl: null })
      await downloadTikTok(url, videoPath)

      jobs.set(jobId, { status: 'uploading', progress: 0, error: null, videoUrl: null })
      const tagList = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []

      const result = await uploadToYoutube({
        videoPath,
        title: title || 'Video de TikTok',
        description: description || '',
        tags: tagList,
        privacy: privacy || 'public',
        onProgress: pct => {
          const current = jobs.get(jobId)
          jobs.set(jobId, { ...current, progress: pct })
        },
      })

      const videoUrl = `https://www.youtube.com/watch?v=${result.id}`
      jobs.set(jobId, { status: 'done', progress: 100, error: null, videoUrl })
      console.log(`✅ Subido manualmente: ${title} → ${videoUrl}`)

    } catch (e) {
      console.error(`❌ Job ${jobId}: ${e.message}`)
      jobs.set(jobId, { status: 'error', progress: 0, error: e.message, videoUrl: null })
    } finally {
      try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath) } catch {}
      setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000)
    }
  })()
})

// ── Estado de un job de subida manual ──────────────────────
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job no encontrado' })
  res.json(job)
})

// ── Auto-upload: estado del scheduler ──────────────────────
app.get('/auto/status', (req, res) => {
  res.json(getSchedulerStatus())
})

// ── Auto-upload: forzar ejecución manual ────────────────────
app.post('/auto/run', (req, res) => {
  const { password } = req.body
  if (password !== UPLOAD_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' })
  const result = triggerRun('manual')
  if (result.error) return res.status(409).json(result)
  res.json({ ok: true, message: 'Auto-upload iniciado en segundo plano' })
})

// ── Auto-upload: historial de videos subidos ────────────────
app.get('/auto/history', (req, res) => {
  const history = loadHistory()
  // Ordenar de más reciente a más antiguo
  const sorted = [...history.uploaded].reverse()
  res.json({ total: sorted.length, videos: sorted })
})

// ── Health check ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:              true,
    ytConfigured:    !!process.env.YOUTUBE_REFRESH_TOKEN,
    clientConfigured:!!process.env.YOUTUBE_CLIENT_ID,
    tiktokUsername:  process.env.TIKTOK_USERNAME || 'mrbeats',
    schedulerActive: !!process.env.YOUTUBE_REFRESH_TOKEN,
  })
})

app.listen(PORT, () => {
  console.log(`🚀 TikTok→YouTube en http://localhost:${PORT}`)
  // Arrancar el scheduler solo si YouTube está configurado
  if (process.env.YOUTUBE_REFRESH_TOKEN) {
    startScheduler()
  } else {
    console.log('⚠️  Scheduler pausado — falta YOUTUBE_REFRESH_TOKEN. Autenticá en /auth')
  }
})
