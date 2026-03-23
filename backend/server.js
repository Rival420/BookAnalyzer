const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

// --- Text extraction helpers ---

/** Strip HTML/XHTML tags and decode entities to plain text */
function stripHtml(text) {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract a chapter title from XHTML markup */
function extractTitle(text, filename) {
  const h1 = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h2 = text.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const raw = (h1 && h1[1]) || (h2 && h2[1]) || (title && title[1]) || filename.replace(/\.\w+$/, '');
  return raw.replace(/<[^>]*>/g, '').trim();
}

/** Parse a single XHTML buffer into a chapter object (or null if too short) */
function parseChapter(buffer, filename, chapterNumber) {
  const raw = buffer.toString('utf8');
  const plainText = stripHtml(raw);

  if (plainText.length < 300) return null;

  return {
    chapterNumber,
    chapterTitle: extractTitle(raw, filename),
    chapterText: plainText.substring(0, 15000),
  };
}

// --- Server ---

app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Main endpoint: accept EPUB, extract + parse chapters, forward JSON to n8n
app.post('/api/analyze', upload.single('epub'), async (req, res) => {
  try {
    const { file } = req;
    const webhookUrl = req.body.webhookUrl;

    if (!file) return res.status(400).json({ error: 'No EPUB file uploaded.' });
    if (!webhookUrl) return res.status(400).json({ error: 'No webhook URL provided.' });

    // 1. Unzip the EPUB and collect XHTML/HTML entries
    const zip = await JSZip.loadAsync(file.buffer);
    const entries = [];

    for (const [filepath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;
      if (!/\.(xhtml|html|htm)$/i.test(filepath)) continue;

      const buffer = await zipEntry.async('nodebuffer');
      entries.push({ filename: path.basename(filepath), buffer });
    }

    if (entries.length === 0) {
      return res.status(400).json({ error: 'No XHTML/HTML files found in the EPUB.' });
    }

    // 2. Sort for consistent chapter ordering, then extract text
    entries.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));

    let chapterNum = 0;
    const chapters = entries
      .map((entry) => parseChapter(entry.buffer, entry.filename, ++chapterNum))
      .filter(Boolean);

    // Re-number after filtering short entries
    chapters.forEach((ch, i) => { ch.chapterNumber = i + 1; });

    if (chapters.length === 0) {
      return res.status(400).json({ error: 'No chapters with enough content found in the EPUB.' });
    }

    console.log(`Extracted ${chapters.length} chapters from "${file.originalname}", sending to n8n: ${webhookUrl}`);

    // 3. Send pre-parsed chapters as JSON to n8n (uses the workflow's JSON fallback path)
    const n8nResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters }),
      timeout: 600000,
    });

    if (!n8nResponse.ok) {
      const errBody = await n8nResponse.text();
      console.error('n8n error:', n8nResponse.status, errBody);
      return res.status(502).json({
        error: `n8n webhook returned ${n8nResponse.status}`,
        detail: errBody.substring(0, 500),
      });
    }

    // 4. Relay the HTML guide back to the browser
    const html = await n8nResponse.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Book Analyzer backend running on port ${PORT}`);
});
