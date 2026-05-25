const express = require('express')
const fs      = require('fs')
const path    = require('path')
const { getAuthUrl, handleCallback } = require('./youtube')
const { startScheduler, triggerRun, getSchedulerStatus, loadHistory } = require('./scheduler')

const app  = express()
app.use(express.json())
app.use(express.static('public'))

const PORT            = process.env.PORT || 3000
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || 'admin123'

// ── Auth YouTube ─────────────────────────────────────────────
app.get('/auth', (req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    return res.status(500).send(`
      <h2>❌ Faltan variables de entorno</h2>
      <p>Configurá en Render → Environment:</p>
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
    res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Autenticado</title>
<style>
  body { font-family: sans-serif; max-width: 600px; margin: 3rem auto; padding: 0 1rem }
  code { background: #f3f4f6; padding: .5rem 1rem; border-radius: 8px; display: block;
         word-break: break-all; margin: 1rem 0; font-size: .85rem }
  .ok  { color: #16a34a; font-size: 1.5rem }
</style></head>
<body>
  <p class="ok">✅ Canal de YouTube autenticado</p>
  <h2>Copiá este Refresh Token</h2>
  <code>${refreshToken}</code>
  <h3>Próximos pasos:</h3>
  <ol>
    <li>Render → Environment → agregar <b>YOUTUBE_REFRESH_TOKEN</b> = el token de arriba</li>
    <li>Redeploy el servicio</li>
    <li>Listo — el scheduler comenzará a subir videos automáticamente</li>
  </ol>
  <a href="/">← Volver al inicio</a>
</body></html>`)
  } catch (e) {
    res.status(500).send(`<h2>❌ Error: ${e.message}</h2><a href="/auth">Intentar de nuevo</a>`)
  }
})

// ── Estado del scheduler ─────────────────────────────────────
app.get('/auto/status', (req, res) => {
  res.json(getSchedulerStatus())
})

// ── Forzar generación manual ─────────────────────────────────
app.post('/auto/run', (req, res) => {
  const { password } = req.body
  if (password !== UPLOAD_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' })
  const result = triggerRun('manual')
  if (result.error) return res.status(409).json(result)
  res.json({ ok: true, message: 'Generación iniciada en segundo plano' })
})

// ── Historial de videos subidos ──────────────────────────────
app.get('/auto/history', (req, res) => {
  const history = loadHistory()
  const sorted  = [...history.uploaded].reverse()
  res.json({ total: sorted.length, videos: sorted })
})

// ── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:                true,
    ytConfigured:      !!process.env.YOUTUBE_REFRESH_TOKEN,
    clientConfigured:  !!process.env.YOUTUBE_CLIENT_ID,
    jamendoConfigured: !!process.env.JAMENDO_CLIENT_ID,
    pixabayConfigured: !!process.env.PIXABAY_API_KEY,
    categories:        (process.env.MUSIC_CATEGORIES || 'sleep,study,focus,travel,ambient').split(','),
    schedulerActive:   !!(process.env.YOUTUBE_REFRESH_TOKEN && process.env.JAMENDO_CLIENT_ID && process.env.PIXABAY_API_KEY),
  })
})

app.listen(PORT, () => {
  console.log(`🎵 Music Auto-Upload en http://localhost:${PORT}`)
  const ready = process.env.YOUTUBE_REFRESH_TOKEN && process.env.JAMENDO_CLIENT_ID && process.env.PIXABAY_API_KEY
  if (ready) {
    startScheduler()
  } else {
    if (!process.env.YOUTUBE_REFRESH_TOKEN) console.log('⚠️  Falta YOUTUBE_REFRESH_TOKEN — autenticá en /auth')
    if (!process.env.JAMENDO_CLIENT_ID)     console.log('⚠️  Falta JAMENDO_CLIENT_ID — obtenerlo gratis en developer.jamendo.com')
    if (!process.env.PIXABAY_API_KEY)       console.log('⚠️  Falta PIXABAY_API_KEY — obtenerla gratis en pixabay.com/api/')
  }
})
