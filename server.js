const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3001;

// Temp directory for processing
const TEMP_DIR = '/tmp/osvasa-video';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Multer for file uploads
const storage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Health check
app.get('/health', async (req, res) => {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version']);
    const version = stdout.split('\n')[0];
    res.json({ status: 'ok', ffmpeg: version });
  } catch (err) {
    res.status(500).json({ status: 'error', error: 'ffmpeg not found' });
  }
});

// ── POST /generate-video ──
// Accepts: video clips (as URLs or files), audio file/URL
// Returns: merged video with audio as a downloadable file or URL
app.post('/generate-video', upload.fields([
  { name: 'clips', maxCount: 20 },
  { name: 'audio', maxCount: 1 },
]), async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const { clip_urls, audio_url } = req.body;
    const clipFiles = req.files?.clips || [];
    const audioFiles = req.files?.audio || [];

    // Collect clip paths — from uploaded files or download from URLs
    const clipPaths = [];

    // Handle uploaded clip files
    for (const file of clipFiles) {
      clipPaths.push(file.path);
    }

    // Handle clip URLs — download them
    if (clip_urls) {
      const urls = Array.isArray(clip_urls) ? clip_urls : JSON.parse(clip_urls);
      for (let i = 0; i < urls.length; i++) {
        const clipPath = path.join(jobDir, `clip-${i}.mp4`);
        await downloadFile(urls[i], clipPath);
        clipPaths.push(clipPath);
      }
    }

    if (clipPaths.length === 0) {
      return res.status(400).json({ error: 'No video clips provided' });
    }

    // Get audio path — from upload or URL
    let audioPath = null;
    if (audioFiles.length > 0) {
      audioPath = audioFiles[0].path;
    } else if (audio_url) {
      audioPath = path.join(jobDir, 'audio.mp3');
      await downloadFile(audio_url, audioPath);
    }

    console.log(`[${jobId}] Processing ${clipPaths.length} clips, audio: ${!!audioPath}`);

    // Step 1: Concatenate clips
    const concatListPath = path.join(jobDir, 'concat.txt');
    const concatContent = clipPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    const mergedPath = path.join(jobDir, 'merged.mp4');

    if (clipPaths.length === 1) {
      fs.copyFileSync(clipPaths[0], mergedPath);
    } else {
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        mergedPath,
      ], { maxBuffer: 100 * 1024 * 1024 });
    }
    console.log(`[${jobId}] Clips merged`);

    // Step 2: Add audio if provided
    const finalPath = path.join(jobDir, 'final.mp4');

    if (audioPath) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', mergedPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k',
        '-map', '0:v:0', '-map', '1:a:0',
        '-shortest',
        '-movflags', '+faststart',
        finalPath,
      ], { maxBuffer: 100 * 1024 * 1024 });
      console.log(`[${jobId}] Audio added`);
    } else {
      fs.copyFileSync(mergedPath, finalPath);
    }

    // Return the final video
    const stat = fs.statSync(finalPath);
    console.log(`[${jobId}] Final video: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="osvasa-${jobId}.mp4"`);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);
    stream.on('end', () => cleanup(jobDir, clipPaths, audioPath));
    stream.on('error', () => cleanup(jobDir, clipPaths, audioPath));

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    cleanup(jobDir);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /merge-audio ──
// Mix two audio files (voiceover + music at lower volume)
app.post('/merge-audio', upload.fields([
  { name: 'voiceover', maxCount: 1 },
  { name: 'music', maxCount: 1 },
]), async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const { voiceover_url, music_url, music_volume = '0.2' } = req.body;
    const voiceoverFiles = req.files?.voiceover || [];
    const musicFiles = req.files?.music || [];

    let voiceoverPath = voiceoverFiles[0]?.path;
    let musicPath = musicFiles[0]?.path;

    if (!voiceoverPath && voiceover_url) {
      voiceoverPath = path.join(jobDir, 'voiceover.mp3');
      await downloadFile(voiceover_url, voiceoverPath);
    }
    if (!musicPath && music_url) {
      musicPath = path.join(jobDir, 'music.mp3');
      await downloadFile(music_url, musicPath);
    }

    if (!voiceoverPath) {
      return res.status(400).json({ error: 'No voiceover provided' });
    }

    const outputPath = path.join(jobDir, 'mixed.mp3');

    if (musicPath) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', voiceoverPath,
        '-i', musicPath,
        '-filter_complex',
        `[1:a]volume=${music_volume}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[out]`,
        '-map', '[out]',
        outputPath,
      ]);
    } else {
      fs.copyFileSync(voiceoverPath, outputPath);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="mixed-${jobId}.mp3"`);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => cleanup(jobDir));
    stream.on('error', () => cleanup(jobDir));

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    cleanup(jobDir);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ──

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

function cleanup(jobDir, extraFiles = []) {
  try {
    for (const f of extraFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
    fs.rmSync(jobDir, { recursive: true, force: true });
  } catch {}
}

app.listen(PORT, () => {
  console.log(`Osvasa Video Service running on port ${PORT}`);
});
