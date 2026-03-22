const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const FormData = require('form-data');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

// Serve frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Main endpoint: accept EPUB, extract xhtml, forward to n8n
app.post('/api/analyze', upload.single('epub'), async (req, res) => {
  try {
    const { file } = req;
    const webhookUrl = req.body.webhookUrl;

    if (!file) {
      return res.status(400).send('No EPUB file uploaded.');
    }

    if (!webhookUrl) {
      return res.status(400).send('No webhook URL provided.');
    }

    // Extract xhtml/html files from EPUB (which is a ZIP)
    const zip = await JSZip.loadAsync(file.buffer);
    const xhtmlFiles = [];

    for (const [filepath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;
      if (!/\.(xhtml|html|htm)$/i.test(filepath)) continue;

      const buffer = await zipEntry.async('nodebuffer');
      const filename = path.basename(filepath);

      xhtmlFiles.push({ filename, buffer });
    }

    if (xhtmlFiles.length === 0) {
      return res.status(400).send('No XHTML/HTML files found in the EPUB.');
    }

    // Sort by filename for consistent chapter ordering
    xhtmlFiles.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));

    // Build multipart form to send to n8n webhook
    const form = new FormData();
    xhtmlFiles.forEach((f, i) => {
      form.append(`file${i}`, f.buffer, {
        filename: f.filename,
        contentType: 'application/xhtml+xml',
      });
    });

    console.log(`Sending ${xhtmlFiles.length} files to n8n: ${webhookUrl}`);

    // Forward to n8n webhook
    const n8nResponse = await fetch(webhookUrl, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      timeout: 600000, // 10 min timeout for large books
    });

    if (!n8nResponse.ok) {
      const errBody = await n8nResponse.text();
      console.error('n8n error:', n8nResponse.status, errBody);
      return res.status(502).send(`n8n webhook returned ${n8nResponse.status}: ${errBody.substring(0, 200)}`);
    }

    // Stream the HTML response back
    const html = await n8nResponse.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (err) {
    console.error('Error:', err);
    res.status(500).send(err.message || 'Internal server error');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Book Analyzer backend running on port ${PORT}`);
});
