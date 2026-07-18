const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const pdfParse = require('pdf-parse');
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

// --- Format-specific extraction ---

/** Unzip an EPUB buffer and parse its XHTML/HTML files into chapters */
async function extractEpubChapters(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = [];

  for (const [filepath, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    if (!/\.(xhtml|html|htm)$/i.test(filepath)) continue;

    const fileBuffer = await zipEntry.async('nodebuffer');
    entries.push({ filename: path.basename(filepath), buffer: fileBuffer });
  }

  if (entries.length === 0) {
    throw Object.assign(new Error('No XHTML/HTML files found in the EPUB.'), { status: 400 });
  }

  // Sort for consistent chapter ordering, then extract text
  entries.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));

  let chapterNum = 0;
  const chapters = entries
    .map((entry) => parseChapter(entry.buffer, entry.filename, ++chapterNum))
    .filter(Boolean);

  return { chapters, sourceTitle: null };
}

/** Lines that look like chapter headings in extracted PDF text */
const PDF_HEADING_RE = /^\s*((?:chapter|part|book|section)\s+(?:\d+|[IVXLC]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b[^\n]{0,80}|\d{1,2}\.?\s+[A-Z][^\n]{3,80})\s*$/gim;

/** Parse a PDF buffer into chapters, using heading detection with a chunking fallback */
async function extractPdfChapters(buffer) {
  const data = await pdfParse(buffer);
  const fullText = (data.text || '').replace(/\r\n/g, '\n');

  // Embedded document title, if the PDF has a meaningful one
  const metaTitle = (data.info && typeof data.info.Title === 'string')
    ? data.info.Title.replace(/\s+/g, ' ').trim()
    : '';
  const sourceTitle = metaTitle.length >= 8 ? metaTitle : null;

  if (fullText.replace(/\s+/g, ' ').trim().length < 300) {
    throw Object.assign(
      new Error('No extractable text found in the PDF. It may be a scanned/image-only document.'),
      { status: 400 },
    );
  }

  // 1. Try to split on chapter-like headings.
  // The regex is case-insensitive for word headings ("Chapter 3", "PART II").
  // Numbered headings ("7. Evaluation") are re-checked case-sensitively and
  // must look like a title, not prose or a footnote ("16 loops back to...",
  // "1 Clearly, a"): capitalized first word and no sentence punctuation.
  const headings = [...fullText.matchAll(PDF_HEADING_RE)].filter((m) => {
    const h = m[1];
    if (!/^\d/.test(h)) return true;
    // Titles don't contain sentence punctuation, code, or trailing hyphenation
    // (colons are allowed: "2. Overview: Example Tracing Run")
    if (/[,;=()\[\]{}]|-$/.test(h)) return false;
    // "7. Evaluation" (dot style), or "7 Evaluation Results" (no dot, >=2 words)
    return /^\d{1,2}\.\s+[A-Z]/.test(h) || /^\d{1,2}\s+[A-Z]\S*\s+\S/.test(h);
  });
  let chapters = [];

  if (headings.length >= 2) {
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index;
      const end = i + 1 < headings.length ? headings[i + 1].index : fullText.length;
      const title = headings[i][1].replace(/\s+/g, ' ').trim();
      const body = fullText.slice(start, end).replace(/\s+/g, ' ').trim();

      if (body.length < 300) continue;
      chapters.push({
        chapterNumber: chapters.length + 1,
        chapterTitle: title,
        chapterText: body.substring(0, 15000),
      });
    }
  }

  // 2. Fallback: split into evenly-sized sections at paragraph boundaries
  if (chapters.length < 2) {
    chapters = chunkTextIntoSections(fullText);
  }

  return { chapters, sourceTitle };
}

/** Split plain text into ~12k-char sections, breaking at paragraph boundaries */
function chunkTextIntoSections(fullText, chunkSize = 12000) {
  const paragraphs = fullText.split(/\n\s*\n/);
  const sections = [];
  let current = '';

  const flush = () => {
    const text = current.replace(/\s+/g, ' ').trim();
    if (text.length >= 300) {
      sections.push({
        chapterNumber: sections.length + 1,
        chapterTitle: `Section ${sections.length + 1}`,
        chapterText: text.substring(0, 15000),
      });
    }
    current = '';
  };

  for (const para of paragraphs) {
    if (current.length + para.length > chunkSize && current.length > 0) flush();
    current += para + '\n\n';
  }
  flush();

  return sections;
}

// --- Networking ---

/**
 * Rewrite localhost URLs so they resolve from inside the Docker container.
 * The user enters "http://localhost:5678/..." in the browser (which runs on
 * the host), but the fetch happens inside the container where "localhost"
 * points to the container itself.  `host.docker.internal` is the Docker-
 * provided alias that reaches the host machine.
 */
function resolveWebhookUrl(url) {
  const DOCKER_HOST = process.env.DOCKER_HOST_ALIAS || 'host.docker.internal';
  return url.replace(
    /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)/i,
    `$1${DOCKER_HOST}$3`,
  );
}

// --- Server ---

app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Main endpoint: accept one or more EPUB/PDF files, extract + merge chapters, forward JSON to n8n
app.post('/api/analyze', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files;
    const webhookUrl = req.body.webhookUrl;

    if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });
    if (!webhookUrl) return res.status(400).json({ error: 'No webhook URL provided.' });

    // 1. Extract chapters from each file
    const multiSource = files.length > 1;
    const chapters = [];

    for (const file of files) {
      const ext = (file.originalname.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
      let extracted;

      try {
        if (ext === 'pdf') {
          extracted = await extractPdfChapters(file.buffer);
        } else if (ext === 'epub') {
          extracted = await extractEpubChapters(file.buffer);
        } else {
          return res.status(400).json({
            error: `Unsupported file type: "${file.originalname}". Please upload EPUB or PDF files.`,
          });
        }
      } catch (err) {
        err.message = `${file.originalname}: ${err.message}`;
        throw err;
      }

      // When combining multiple papers, prefix each chapter with its source
      // so the AI can attribute content and synthesize across papers.
      if (multiSource) {
        const source = extracted.sourceTitle || file.originalname.replace(/\.\w+$/, '');
        extracted.chapters.forEach((ch) => {
          ch.chapterTitle = `[${source}] ${ch.chapterTitle}`;
        });
      }

      chapters.push(...extracted.chapters);
    }

    // 2. Re-number across all files
    chapters.forEach((ch, i) => { ch.chapterNumber = i + 1; });

    if (chapters.length === 0) {
      return res.status(400).json({ error: 'No chapters with enough content found in the uploaded files.' });
    }

    const targetUrl = resolveWebhookUrl(webhookUrl);
    const fileNames = files.map((f) => `"${f.originalname}"`).join(', ');
    console.log(`Extracted ${chapters.length} chapters from ${files.length} file(s) (${fileNames}), sending to n8n: ${targetUrl}`);

    // 3. Send pre-parsed chapters as JSON to n8n (uses the workflow's JSON fallback path)
    const n8nResponse = await fetch(targetUrl, {
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
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Book Analyzer backend running on port ${PORT}`);
});
