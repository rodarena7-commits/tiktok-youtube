const { execSync, exec } = require('child_process')
const path = require('path')
const os = require('os')

function getTempPath(jobId) {
  return path.join(os.tmpdir(), `tiktok_${jobId}.mp4`)
}

// Obtiene metadatos del video sin descargar
async function getTikTokMeta(url) {
  return new Promise((resolve, reject) => {
    exec(`yt-dlp --dump-json --no-playlist "${url}"`, { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null) // no fatal, metadatos son opcionales
      try {
        const meta = JSON.parse(stdout.trim())
        resolve({
          title: meta.description || meta.title || '',
          duration: meta.duration || 0,
          uploader: meta.uploader || meta.creator || '',
        })
      } catch {
        resolve(null)
      }
    })
  })
}

// Descarga el video
async function downloadTikTok(url, outputPath) {
  return new Promise((resolve, reject) => {
    // -f bestvideo+bestaudio / best — TikTok suele tener un solo formato
    const cmd = `yt-dlp -o "${outputPath}" --no-playlist --merge-output-format mp4 "${url}"`
    exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message))
      resolve(outputPath)
    })
  })
}

module.exports = { downloadTikTok, getTikTokMeta, getTempPath }
