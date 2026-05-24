const { execSync, exec } = require('child_process')
const path = require('path')
const fs   = require('fs')
const os   = require('os')

function getTempPath(jobId) {
  return path.join(os.tmpdir(), `tiktok_${jobId}.mp4`)
}

// Devuelve el argumento --cookies si la variable de entorno está configurada
function cookiesArg() {
  const content = process.env.TIKTOK_COOKIES
  if (!content || !content.trim()) return ''
  const p = path.join(os.tmpdir(), 'tiktok_cookies.txt')
  fs.writeFileSync(p, content)
  return `--cookies "${p}"`
}

const UA = '--add-header "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"'

// Obtiene metadatos del video sin descargar
async function getTikTokMeta(url) {
  return new Promise((resolve) => {
    const cmd = `yt-dlp --dump-json --no-playlist ${cookiesArg()} ${UA} "${url}"`
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        const meta = JSON.parse(stdout.trim())
        resolve({
          title:    meta.description || meta.title || '',
          duration: meta.duration    || 0,
          uploader: meta.uploader    || meta.creator || '',
        })
      } catch { resolve(null) }
    })
  })
}

// Descarga el video
async function downloadTikTok(url, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = [
      'yt-dlp',
      `-o "${outputPath}"`,
      '--no-playlist',
      '--merge-output-format mp4',
      cookiesArg(),
      UA,
      `"${url}"`,
    ].filter(Boolean).join(' ')

    exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message))
      resolve(outputPath)
    })
  })
}

module.exports = { downloadTikTok, getTikTokMeta, getTempPath }
