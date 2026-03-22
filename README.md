# Book Analyzer

A web application that transforms EPUB books into beautifully crafted HTML reference guides — complete with chapter summaries, flashcards, key takeaways, argument chains, and theoretical frameworks.

Upload an EPUB, sit back, and receive a comprehensive study companion powered by AI.

## How It Works

The application sits between you and an **n8n workflow** that does the heavy lifting:

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│              │      │              │      │              │      │              │
│  You upload  │─────▶│  Backend     │─────▶│  n8n         │─────▶│  HTML        │
│  an EPUB     │      │  extracts    │      │  workflow    │      │  Reference   │
│              │      │  XHTML files │      │  analyzes    │      │  Guide       │
│              │      │  from ZIP    │      │  via OpenAI  │      │              │
└──────────────┘      └──────────────┘      └──────────────┘      └──────────────┘
```

1. **EPUB Upload** — You drag-and-drop (or browse) an `.epub` file into the web interface.
2. **Chapter Extraction** — The backend unpacks the EPUB (which is just a ZIP archive) and pulls out all `.xhtml` / `.html` chapter files.
3. **n8n Analysis Pipeline** — Those chapter files are forwarded as a multipart POST to your n8n webhook, which:
   - Strips HTML tags and extracts plain text per chapter
   - Sends each chapter to OpenAI for individual summarization (key points, themes, analytical summary)
   - Aggregates all chapter results
   - Runs a second AI pass for cross-book synthesis (flashcards, takeaways, argument chain, theoretical frameworks, metadata)
   - Assembles everything into a self-contained HTML reference guide
4. **Result** — The HTML guide is returned to the webapp, displayed in a live preview, and available for download.

## What You Get

The generated reference guide includes five sections:

| Section | What's in it |
|---|---|
| **Book Overview** | Central thesis, book structure analysis |
| **Chapters** | Expandable per-chapter summaries with key points |
| **Flashcards** | Interactive term/definition cards, filterable by category |
| **Key Takeaways** | Top insights with an argument chain visualization |
| **Theoretical Frameworks** | Academic and intellectual frameworks referenced in the book |

The output is a single, self-contained HTML file — no dependencies, works offline, looks great on any device.

## Prerequisites

- **Docker** and **Docker Compose** installed on your machine
- A running **n8n instance** with the "XHTML Book Analyzer → Reference Guide" workflow imported and active
- An **OpenAI API key** configured in your n8n credentials

## Setup

### 1. Import the n8n Workflow

If you haven't already, import the workflow JSON into your n8n instance:

1. Open your n8n dashboard
2. Go to **Workflows** → **Import from File**
3. Select the `XHTML Book Analyzer → Reference Guide (OpenAI) v2.json` file
4. Configure the OpenAI credentials in the workflow's HTTP Request nodes
5. **Activate** the workflow (the toggle in the top-right)
6. Note down your webhook URL — it will look something like:
   ```
   https://your-n8n-instance.com/webhook/analyze-book
   ```
   Or if running n8n locally:
   ```
   http://localhost:5678/webhook/analyze-book
   ```

### 2. Build and Run the App

```bash
# Clone or navigate to the project
cd BookAnalyzer

# Build and start the container
docker compose up --build -d
```

That's it. The app is now running on **http://localhost:3080**.

### 3. Use It

1. Open **http://localhost:3080** in your browser
2. Paste your n8n webhook URL into the **Webhook** field at the bottom of the upload zone (this is saved in your browser's local storage for next time)
3. Drag an `.epub` file onto the upload zone, or click to browse
4. Click **Generate Reference Guide**
5. Wait for the analysis to complete (this can take a few minutes for longer books — each chapter goes through OpenAI individually)
6. Preview the result in the embedded frame, or click **Download HTML** to save it

## Project Structure

```
BookAnalyzer/
├── docker-compose.yml          # Single-service Docker stack
├── .dockerignore
├── backend/
│   ├── Dockerfile              # Node 20 Alpine image
│   ├── package.json            # Express, JSZip, multer, form-data, node-fetch
│   └── server.js               # EPUB extraction + n8n webhook proxy
└── frontend/
    └── index.html              # Self-contained SPA (HTML + CSS + JS)
```

### Backend (`server.js`)

A lightweight Express server with two responsibilities:

- **Serve the frontend** — static files from `frontend/`
- **`POST /api/analyze`** — accepts the EPUB upload, extracts chapter files, and proxies them to the n8n webhook. Returns the HTML response from n8n directly to the browser.

The server runs in-memory (no disk writes) and supports EPUBs up to 100 MB.

### Frontend (`index.html`)

A single self-contained HTML file with inline CSS and JavaScript. No build step, no framework, no dependencies beyond two Google Fonts.

Features:
- Drag-and-drop upload with visual feedback
- Webhook URL field with localStorage persistence
- Step-by-step progress indicator
- Inline preview via sandboxed iframe
- One-click HTML download

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Internal port the Node server listens on |
| `NODE_ENV` | `production` | Node environment |

The Docker Compose file maps internal port 3000 to host port **3080**. Change this in `docker-compose.yml` if needed:

```yaml
ports:
  - "8080:3000"   # Use port 8080 instead
```

## Networking Notes

The webhook URL you enter in the browser is called **from the Docker container**, not from your browser. This matters when n8n runs locally:

- If n8n runs on the same machine via Docker, use `http://host.docker.internal:5678/webhook/analyze-book` (macOS/Windows) or the Docker bridge IP on Linux.
- If n8n runs on a remote server, use its public URL.
- If n8n runs on the same Docker network, you can use the container name as hostname.

## Troubleshooting

| Problem | Solution |
|---|---|
| **"No XHTML/HTML files found"** | The EPUB might use a non-standard structure, or it's a DRM-protected file. Try a different EPUB. |
| **Timeout / no response** | Large books with many chapters can take 5-10 minutes. The timeout is set to 10 minutes. Check n8n execution logs for errors. |
| **"n8n webhook returned 404"** | Make sure the workflow is **activated** in n8n, and the webhook path matches (`/webhook/analyze-book`). |
| **"n8n webhook returned 502"** | n8n likely hit an error during processing. Check the n8n execution history for details (often an OpenAI rate limit or timeout). |
| **Container can't reach n8n** | See the [Networking Notes](#networking-notes) section above. |

## Stopping the App

```bash
docker compose down
```

To rebuild after making changes:

```bash
docker compose up --build -d
```

## License

MIT
