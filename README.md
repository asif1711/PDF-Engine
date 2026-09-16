# PDF Engine (PDF Generator & Field Mapper)

Enterprise Gravity Forms → PDF Mapping, Ingestion & Real-Time Automation Platform.

---

## 📌 Overview

**PDF Engine** is a high-performance, full-stack application designed to seamlessly bridge **WordPress Gravity Forms** submissions with standard PDF templates (AcroForms). It provides an intuitive visual field mapper, automated template analyzer, real-time webhook generation pipeline, and automated dispatch that attaches completed PDFs back to WordPress entries with email notifications.

The application is built with a **unified full-stack architecture**:
- **Frontend**: A modern React 19 Single Page Application (SPA) powered by Vite, providing interactive PDF page previews, drag-and-match field mapping, and live submission dispatch testing.
- **Backend**: An Express 5 Node.js server that simultaneously serves the compiled React frontend and handles high-throughput REST and Webhook API endpoints (`/api/*`).
- **Engine**: 100% pure JavaScript PDF manipulation using `pdf-lib` and `pdfjs-dist`. **No headless browsers (Chromium/Puppeteer), Java runtimes, or native OS binaries required.**

---

## 🚀 Key Features

1. **Interactive AcroForm Field Mapper**
   - Live visual layout of PDF form fields alongside Gravity Forms fields.
   - Intelligent auto-matching based on field names, IDs, labels, and coordinate heuristics.
   - Format controls for dates (e.g. `DD/MM/YYYY`, `YYYY-MM-DD`, `DD Month YYYY`), checkboxes, dropdowns, text areas, and radio groups.
   - Support for multiple document uploads: automatically embeds or merges student/client uploaded documents (images, PDFs) directly into the generated document.

2. **Template Ingestion & Deep Analysis**
   - Automatically inspects PDF templates to extract technical AcroForm fields (Layer 1) and printed textual context coordinates (Layer 2) using `pdfjs-dist`.
   - Supports templates organized by institutional category (e.g., `AIBT`, `AIBT-I`, `AVTA`, `NPA`, `BIC`, `REACH`, `HJ`, `Pivot`, `Profound`, `Others`).
   - Integrated with Google Cloud Storage (GCS) and CDN caching (`cdn.vconsultancy.com.au`).

3. **Real-Time Automated Webhook Dispatch**
   - Endpoint: `/api/generate-pdf`.
   - Accepts real-time webhook payloads from Gravity Forms upon form submission.
   - Automatically locates matching saved mappings in `/mappings/form-{formId}/`.
   - Generates the filled PDF, writes a local copy to `/generated/`, and pushes the completed file directly to WordPress REST endpoints (`/wp-json/pdf-generator/v1/entries/{entryId}/pdf?send_notification=1`).
   - Handles test pings from WordPress admin with 0ms latency verification.

4. **WordPress CORS & REST Proxy**
   - Built-in `/api/wp-proxy` endpoint eliminates browser cross-origin (CORS) blocks when communicating with WordPress REST APIs across different domains, local development tunnels, or ngrok endpoints.

---

## 🏗️ Project Structure

```text
├── package.json                   # Root package manifest & npm scripts
├── server.js                      # Express 5 backend server & static SPA host
├── analyze-template.js            # Pure JS PDF parser (AcroForm + text analysis)
├── sources-and-templates.json     # Primary registry of forms, templates & categories
├── .env.example                   # Environment variable template
├── gravity-forms-reader.php       # WordPress helper plugin for Gravity Forms integration
├── local-pdf-server.js            # Optional standalone local worker for offline LocalWP dev
├── mappings/                      # Single source of truth for saved form-to-PDF mappings
│   └── form-{id}/                 # Organized per Gravity Form ID
│       └── {templateId}.json      # Normalized field mapping definitions
├── generated/                     # Cache directory for generated output PDFs
└── pdf-mapper/                    # Frontend React 19 application
    ├── index.html                 # HTML entry point (title: "PDF Engine")
    ├── vite.config.js             # Vite configuration with embedded dev API middleware
    ├── package.json               # Frontend dependencies & workspace config
    ├── public/
    │   ├── favicon.svg            # Crimson PDF badge favicon
    │   └── templates/             # Local offline template storage by category
    └── src/
        ├── App.jsx                # Main application state, toolbar & tabs
        ├── connectionManager.js   # WordPress REST API, GCS & registry sync
        ├── pdfGenerator.js        # Core pure-JS PDF fill & document embed engine
        ├── mappingUtils.js        # Mapping normalization and resolution logic
        ├── submissionService.js   # Live entry retrieval and cache management
        └── components/
            ├── TopNavigation.jsx  # Primary app navigation & branding
            ├── VisualFieldMapper.jsx
            ├── TemplateIngestionPage.jsx
            └── AutomationDispatchPage.jsx
```

---

## 📦 Dependencies & Prerequisites

### Runtime Requirements
- **Node.js**: Version `20.x` or `22.x` (LTS recommended, tested on `v22.23.2`).
- **NPM**: Version `10.x` or higher (workspace-enabled).

### Core Libraries

| Package | Purpose |
| :--- | :--- |
| `express` (`^5.1.0`) | High-performance backend routing, body parsing, static hosting, and REST endpoints. |
| `pdf-lib` (`^1.17.1`) | Pure JavaScript PDF creation, AcroForm manipulation, page merging, and file embedding. |
| `pdfjs-dist` (`^6.3.289`) | In-browser canvas PDF rendering and server-side textual coordinate extraction. |
| `react` / `react-dom` (`^19.2.8`) | Reactive UI framework for the mapping and ingestion interface. |
| `lucide-react` (`^1.46.0`) | Clean, accessible vector icons throughout the application interface. |
| `vite` (`^8.3.0`) | Fast frontend bundler and HMR development server. |

---

## 🛠️ Setup & Installation

### 1. Clone the Repository
```bash
git clone <repository-url>
cd pdf-generator
```

### 2. Install Dependencies
Run `npm install` from the **root directory**. Because the project uses npm workspaces (`"workspaces": ["pdf-mapper"]`), this command installs all root and frontend dependencies in one step:
```bash
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to create `.env`:
```bash
cp .env.example .env
```
Edit `.env` as needed:
```env
# Server Port (Render and Cloud Run will set PORT automatically)
PORT=3000

# Optional: Default WordPress Connection
VITE_WORDPRESS_FORMS_URL=https://your-wordpress-site.com
VITE_WORDPRESS_API_KEY=your_secret_api_key

# Optional: Google Cloud Storage Template Sync
GCS_BUCKET_NAME=cdn.vconsultancy.com.au
GCS_PROJECT_ID=aibt-244204
GCS_ACCESS_TOKEN=
GCS_SERVICE_ACCOUNT_JSON=
GOOGLE_APPLICATION_CREDENTIALS=
```

---

## 💻 Running the Application

### Development Mode (with Live Reload)
Starts the Vite dev server with embedded backend middleware on `http://localhost:3000`:
```bash
npm run dev
```

### Production Build & Run
1. **Build the React frontend** into `/pdf-mapper/dist`:
   ```bash
   npm run build
   ```
2. **Start the Express unified server**:
   ```bash
   npm start
   ```
The unified production server will listen on `http://0.0.0.0:3000` (or the port specified by `$PORT`), serving both the React UI and all `/api/*` endpoints.

### Code Linting
Run ESLint across the codebase:
```bash
npm run lint
```

---

## 🔄 Complete Data Flow

```text
[User Form Submission]
         │
         ▼
[WordPress Gravity Forms]
         │
         ▼  (HTTP POST Webhook with form_id, entry_id, & form values)
[PDF Engine Server] (/api/generate-pdf)
         │
         ├─► 1. Loads mapping file (/mappings/form-{form_id}/{template}.json)
         ├─► 2. Reads PDF template bytes (from disk or GCS CDN)
         ├─► 3. Normalizes field values (names, dates, checkboxes, signatures)
         ├─► 4. Fetches & embeds uploaded student documents / photos
         ├─► 5. Generates filled AcroForm PDF using pdf-lib
         ├─► 6. Caches output in /generated/
         │
         ▼
[Pushback to WordPress] (POST /wp-json/pdf-generator/v1/entries/{id}/pdf)
         │
         ├─► Attaches generated PDF to Gravity Forms entry
         └─► Dispatches customer/admin email notifications with PDF attached
```

---

## 🌐 API Reference

### Health Check
- **`GET /health`** or **`GET /api/health`**
  - **Response**: `{ status: "ok", service: "pdf-generator", time: "..." }`

### PDF Generation & Webhook
- **`POST /api/generate-pdf`**
  - **Payload**:
    ```json
    {
      "form_id": "1",
      "entry_id": "105",
      "entry": {
        "1.3": "John",
        "1.6": "Doe",
        "2": "john@example.com",
        "date_created": "2026-09-16"
      },
      "wordpress_url": "https://your-wordpress-site.com",
      "wordpress_api_key": "your_api_key"
    }
    ```
  - **Behavior**: Generates the PDF, stores it locally, pushes it back to WordPress, and returns binary PDF stream (or Base64 JSON if `Accept: application/json` is sent).
- **`GET /api/generate-pdf`**
  - **Response**: Diagnostic ping confirming webhook availability.

### Mappings Persistence
- **`GET /api/mappings?formId={formId}&templateId={templateId}`**
  - Retrieves saved mapping configuration for a specific form and template.
- **`GET /api/mappings`**
  - Lists all configured mappings across all forms.
- **`POST /api/save-mapping`**
  - Saves field mapping JSON directly into `/mappings/form-{formId}/{templateId}.json`.

### Template Analysis
- **`POST /api/analyze-template`**
  - **Payload**: `{ filename: "template.pdf", fileBytesBase64: "..." }`
  - **Response**: Extracted AcroForm fields, types, and visual page text coordinates.

### WordPress Proxy
- **`ALL /api/wp-proxy?url={targetUrl}&apiKey={key}`**
  - Bypasses CORS and ngrok browser warning headers for live WordPress requests.

---

## ☁️ Deployment Guide (Render)

PDF Engine is fully architected to deploy as a **single Render Web Service** without any code changes:

1. **Create Service**: In the Render Dashboard, click **New +** → **Web Service**.
2. **Connect Repo**: Link your GitHub/GitLab repository.
3. **Settings**:
   - **Service Type**: `Web Service`
   - **Runtime**: `Node`
   - **Root Directory**: `.` (leave empty)
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
4. **Environment Variables**:
   - `NODE_VERSION`: `22`
   - *(Optional)* `WORDPRESS_FORMS_URL`: your live WordPress base URL
   - *(Optional)* `WORDPRESS_API_KEY`: your secret API key
   - *(Optional)* `GCS_SERVICE_ACCOUNT_JSON`: for Google Cloud Storage sync
5. **Persistent Disk (Optional)**:
   - If creating new mappings live on Render without committing them to Git, attach a Render Persistent Disk mounted at `/app/mappings`.

---

## 📝 License

Private & Proprietary. Developed for Gravity Forms & Enterprise PDF Ingestion.
