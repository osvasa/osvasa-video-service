const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 10000;
const TEMP = '/tmp/osvasa';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Ensure temp dir exists
if (!fs.existsSync(TEMP)) fs.mkdirSync(TEMP, { recursive: true });

// ── Helpers ──

async function download(url, destPath) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
  fs.writeFileSync(destPath, Buffer.from(res.data));
  console.log(`  Downloaded: ${path.basename(destPath)} (${(res.data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
}

async function ffprobe(filePath, entry) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet', '-show_entries', entry,
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ]);
  return stdout.trim();
}

function cleanup(files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
}

// ── Core pipeline ──

async function generateVideo({ clipUrls: rawClipUrls, musicUrl, textOverlays = [], outputFilename }) {
  const clipUrls = rawClipUrls.slice(0, 5);
  if (rawClipUrls.length > 5) console.log(`Limiting clips from ${rawClipUrls.length} to 5`);
  const jobId = uuidv4().slice(0, 8);
  const jobDir = path.join(TEMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const tempFiles = [];

  try {
    console.log(`[${jobId}] Starting pipeline: ${clipUrls.length} clips`);

    // ── 1. Download all clips ──
    console.log(`[${jobId}] Step 1: Downloading clips...`);
    const rawClipPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const p = path.join(jobDir, `raw-${i}.mp4`);
      await download(clipUrls[i], p);
      rawClipPaths.push(p);
      tempFiles.push(p);
    }

    // ── 2. Download music ──
    let musicPath = null;
    if (musicUrl) {
      console.log(`[${jobId}] Step 2: Downloading music...`);
      musicPath = path.join(jobDir, 'music.mp3');
      await download(musicUrl, musicPath);
      tempFiles.push(musicPath);
    }

    // ── 3. Process each clip: trim, scale 9:16, Ken Burns zoom ──
    console.log(`[${jobId}] Step 3: Processing clips (trim, scale, Ken Burns)...`);
    const processedPaths = [];
    for (let i = 0; i < rawClipPaths.length; i++) {
      const outPath = path.join(jobDir, `proc-${i}.mp4`);
      // Ken Burns: zoom from 1.05x down to 1.0x over clip duration
      // scale to cover 1080x1920, crop center
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', rawClipPaths[i],
        '-t', '2.5',
        '-filter_complex', [
          // Scale to cover 1080x1920 maintaining aspect ratio then crop center
          'scale=w=max(1080\\,ih*1080/iw):h=max(1920\\,iw*1920/ih):force_original_aspect_ratio=increase',
          'crop=1080:1920',
          // Ken Burns: subtle zoom from 1.05 to 1.0
          "zoompan=z='1.05-0.05*on/25':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30",
          'setsar=1',
          'fps=30',
        ].join(','),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-an',
        '-t', '2.5',
        outPath,
      ], { maxBuffer: 200 * 1024 * 1024 });

      processedPaths.push(outPath);
      tempFiles.push(outPath);
      console.log(`  Clip ${i + 1}/${rawClipPaths.length} processed`);
    }

    // ── 4. Concatenate clips ──
    console.log(`[${jobId}] Step 4: Concatenating clips...`);
    const concatListPath = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(concatListPath, processedPaths.map(p => `file '${p}'`).join('\n'));
    tempFiles.push(concatListPath);

    const concatPath = path.join(jobDir, 'concat.mp4');
    tempFiles.push(concatPath);

    await execFileAsync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatListPath,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-an',
      '-movflags', '+faststart',
      concatPath,
    ], { maxBuffer: 200 * 1024 * 1024 });

    // Get total video duration
    const totalDuration = parseFloat(await ffprobe(concatPath, 'format=duration'));
    console.log(`  Concatenated: ${totalDuration.toFixed(1)}s`);

    // ── 5. Add music track ──
    let withMusicPath = concatPath;
    if (musicPath) {
      console.log(`[${jobId}] Step 5: Adding music (volume 0.85, looped)...`);
      withMusicPath = path.join(jobDir, 'with-music.mp4');
      tempFiles.push(withMusicPath);

      await execFileAsync('ffmpeg', [
        '-y',
        '-i', concatPath,
        '-stream_loop', '-1', '-i', musicPath,
        '-filter_complex', '[1:a]volume=0.85[bg];[bg]atrim=0:' + totalDuration.toFixed(2) + '[a]',
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        '-movflags', '+faststart',
        withMusicPath,
      ], { maxBuffer: 200 * 1024 * 1024 });
      console.log('  Music added');
    }

    // ── 6. Add text overlays ──
    let finalInputPath = withMusicPath;
    if (textOverlays.length > 0) {
      console.log(`[${jobId}] Step 6: Adding ${textOverlays.length} text overlays...`);
      const overlayPath = path.join(jobDir, 'with-text.mp4');
      tempFiles.push(overlayPath);

      // Each overlay shows for 4 seconds, evenly spaced
      const overlayDuration = 4;
      const spacing = totalDuration / textOverlays.length;

      // Build drawtext filters
      const drawFilters = textOverlays.map((text, i) => {
        const startTime = i * spacing;
        const endTime = startTime + overlayDuration;
        // Escape special characters for ffmpeg drawtext
        const escaped = text
          .replace(/\\/g, '\\\\\\\\')
          .replace(/'/g, "'\\\\\\''")
          .replace(/:/g, '\\:')
          .replace(/%/g, '%%');

        return `drawtext=text='${escaped}':fontsize=72:fontcolor=white:shadowcolor=black:shadowx=3:shadowy=3:x=(w-text_w)/2:y=h*0.85-text_h/2:enable='between(t,${startTime.toFixed(2)},${endTime.toFixed(2)})'`;
      }).join(',');

      await execFileAsync('ffmpeg', [
        '-y',
        '-i', finalInputPath,
        '-vf', drawFilters,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        overlayPath,
      ], { maxBuffer: 200 * 1024 * 1024 });

      finalInputPath = overlayPath;
      console.log('  Text overlays added');
    }

    // ── 7. Final export at 1080x1920, 30fps, h264 ──
    const fname = (outputFilename || `osvasa-${jobId}`).replace(/\.mp4$/, '');
    const finalPath = path.join(jobDir, `${fname}.mp4`);
    tempFiles.push(finalPath);

    // Re-encode to ensure consistent output
    console.log(`[${jobId}] Step 7: Final export...`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', finalInputPath,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-r', '30',
      '-s', '1080x1920',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      finalPath,
    ], { maxBuffer: 200 * 1024 * 1024 });

    const stat = fs.statSync(finalPath);
    console.log(`[${jobId}] Done: ${fname}.mp4 (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);

    return { finalPath, jobDir, tempFiles, fname };

  } catch (err) {
    // Cleanup on error
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

// ── Routes ──

app.get('/health', async (req, res) => {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version']);
    res.json({ status: 'ok', ffmpeg: stdout.split('\n')[0] });
  } catch {
    res.status(500).json({ status: 'error', error: 'ffmpeg not found' });
  }
});

// Stream final video back as download
app.post('/generate-video', async (req, res) => {
  const { clipUrls, musicUrl, textOverlays, outputFilename } = req.body;

  if (!clipUrls || !Array.isArray(clipUrls) || clipUrls.length === 0) {
    return res.status(400).json({ error: 'clipUrls array required' });
  }

  try {
    const { finalPath, jobDir, fname } = await generateVideo({
      clipUrls, musicUrl, textOverlays, outputFilename,
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.mp4"`);
    res.setHeader('Content-Length', fs.statSync(finalPath).size);

    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);
    stream.on('close', () => {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    });
  } catch (err) {
    console.error('generate-video error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload final video to R2 and return public URL
app.post('/generate-video-url', async (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);

  const {
    clipUrls, musicUrl, textOverlays, outputFilename,
    r2Endpoint, r2AccessKey, r2SecretKey, r2Bucket, r2PublicUrl,
  } = req.body;

  if (!clipUrls || !Array.isArray(clipUrls) || clipUrls.length === 0) {
    return res.status(400).json({ error: 'clipUrls array required' });
  }
  if (!r2Endpoint || !r2AccessKey || !r2SecretKey || !r2Bucket || !r2PublicUrl) {
    return res.status(400).json({ error: 'R2 credentials required: r2Endpoint, r2AccessKey, r2SecretKey, r2Bucket, r2PublicUrl' });
  }

  let jobDir;
  try {
    const result = await generateVideo({
      clipUrls, musicUrl, textOverlays, outputFilename,
    });
    jobDir = result.jobDir;

    // Upload to R2
    console.log(`Uploading to R2...`);
    const r2 = new S3Client({
      region: 'auto',
      endpoint: r2Endpoint,
      credentials: { accessKeyId: r2AccessKey, secretAccessKey: r2SecretKey },
    });

    const videoKey = `videos/${result.fname}.mp4`;
    const videoBuffer = fs.readFileSync(result.finalPath);

    await r2.send(new PutObjectCommand({
      Bucket: r2Bucket,
      Key: videoKey,
      Body: videoBuffer,
      ContentType: 'video/mp4',
    }));

    const publicUrl = `${r2PublicUrl.replace(/\/+$/, '')}/${videoKey}`;
    console.log(`Uploaded: ${publicUrl}`);

    // Cleanup
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}

    res.json({ url: publicUrl, filename: `${result.fname}.mp4` });

  } catch (err) {
    if (jobDir) {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    }
    console.error('generate-video-url error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Osvasa Video Service running on port ${PORT}`);
});
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
