import templateAnalysis from "../../template-analysis.json";
import defaultPdfBytesUrl from "../../NPA_Credit Transfer Forms_V2.1.pdf";
import defaultRegistryJson from "../../sources-and-templates.json";
import { normalizeWpFormsUrl } from "./mappingUtils";
import { analyzePdfBytes } from "./templateAnalyzer";

const WP_CONNS_KEY = "pfgf_wp_connections_v2";
const ACTIVE_WP_CONN_KEY = "pfgf_active_wp_conn_id";
const PDF_TEMPLATES_KEY = "pfgf_pdf_templates_v2";
const ACTIVE_PDF_TPL_KEY = "pfgf_active_pdf_tpl_id";
const AUTOMATION_CONFIG_KEY = "pfgf_automation_config_v2";
const GCS_CREDENTIALS_KEY = "pfgf_gcs_credentials_v2";

export const GCS_CATEGORY_OPTIONS = [
    "AIBT",
    "AIBT-I",
    "AVTA",
    "NPA",
    "BIC",
    "REACH",
    "HJ",
    "Pivot",
    "Profound",
    "Others",
];

export const GCS_BUCKET = "cdn.vconsultancy.com.au";
export const GCS_PROJECT_ID = "aibt-244204";
export const GCS_BASE_PATH = "pdf-generator/templates";
export const GCS_CONSOLE_BASE_URL = `https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}?pageState=(%22StorageObjectListTable%22:(%22f%22:%22%255B%255D%22))&forceOnBucketsSortingFiltering=true&project=${GCS_PROJECT_ID}`;

export function getGcsConsoleCategoryUrl(category = "AIBT") {
    return `https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(category)}?project=${GCS_PROJECT_ID}`;
}

export function getGcsPublicCdnUrl(category = "AIBT", filename = "template.pdf") {
    return `https://${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`;
}

export function getGcsStorageUri(category = "AIBT", filename = "template.pdf") {
    return `gs://${GCS_BUCKET}/${GCS_BASE_PATH}/${category}/${filename}`;
}

export const DEFAULT_WP_CONNECTION = {
    id: "default-localwp",
    name: "LocalWP Tunnel (ngrok)",
    url: "https://tenisha-shapelier-elijah.ngrok-free.dev/wp-json/pdf-generator/v1/forms",
    apiKey: "aso107mzNrZId001GebX6ew8",
    basicUser: "",
    basicPass: "",
    isDefault: true,
};

export const DEFAULT_PDF_TEMPLATE = {
    id: "default-npa",
    name: "NPA_Credit Transfer Forms_V2.1.pdf",
    filename: "NPA_Credit Transfer Forms_V2.1.pdf",
    category: "NPA",
    isBuiltin: true,
    url: defaultPdfBytesUrl,
    analysis: templateAnalysis,
    gcsPath: "pdf-generator/templates/NPA/NPA_Credit Transfer Forms_V2.1.pdf",
    gcsUri: "gs://cdn.vconsultancy.com.au/pdf-generator/templates/NPA/NPA_Credit Transfer Forms_V2.1.pdf",
    cdnUrl: "https://cdn.vconsultancy.com.au/pdf-generator/templates/NPA/NPA_Credit Transfer Forms_V2.1.pdf",
    consoleUrl: "https://console.cloud.google.com/storage/browser/cdn.vconsultancy.com.au/pdf-generator/templates/NPA?project=aibt-244204",
};

export function getGcsCredentials() {
    try {
        const raw = localStorage.getItem(GCS_CREDENTIALS_KEY);
        if (raw) return JSON.parse(raw);
    } catch {
        // Fall back to empty credentials if storage fails
    }
    return {
        accessToken: "",
        serviceAccountKey: "",
    };
}

export function saveGcsCredentials(creds) {
    localStorage.setItem(GCS_CREDENTIALS_KEY, JSON.stringify(creds));
    return creds;
}

export async function uploadTemplateToGcs({ fileBytes, filename, category }) {
    const creds = getGcsCredentials();
    const tokenOrKey = creds.accessToken || creds.serviceAccountKey || "";

    // Convert Uint8Array to base64
    let binary = "";
    const len = fileBytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(fileBytes[i]);
    }
    const fileBytesBase64 = btoa(binary);

    const headers = {
        "Content-Type": "application/json",
    };
    if (tokenOrKey) {
        headers["x-gcs-token"] = tokenOrKey;
    }

    const res = await fetch("/api/gcs-upload", {
        method: "POST",
        headers,
        body: JSON.stringify({
            filename,
            category,
            fileBytesBase64,
        }),
    });

    if (!res.ok) {
        throw new Error(`Upload server responded with HTTP ${res.status}`);
    }

    return await res.json();
}

// =========================================================
// WORDPRESS CONNECTIONS
// =========================================================

export function getWpConnections() {
    try {
        const raw = localStorage.getItem(WP_CONNS_KEY);
        if (raw) {
            const list = JSON.parse(raw);
            if (Array.isArray(list) && list.length > 0) return list;
        }
    } catch {
        // Fallback
    }
    if (defaultRegistryJson && Array.isArray(defaultRegistryJson.gravityFormSources) && defaultRegistryJson.gravityFormSources.length > 0) {
        return defaultRegistryJson.gravityFormSources;
    }
    return [DEFAULT_WP_CONNECTION];
}

export function saveWpConnection(conn) {
    const list = getWpConnections();
    const existingIdx = list.findIndex((c) => c.id === conn.id);
    if (existingIdx >= 0) {
        list[existingIdx] = { ...list[existingIdx], ...conn };
    } else {
        list.push({ ...conn, id: conn.id || `conn-${Date.now()}` });
    }
    localStorage.setItem(WP_CONNS_KEY, JSON.stringify(list));
    syncRegistryToBackend();
    return list;
}

export function deleteWpConnection(id) {
    const list = getWpConnections().filter((c) => c.id !== id);
    if (list.length === 0) {
        list.push(DEFAULT_WP_CONNECTION);
    }
    localStorage.setItem(WP_CONNS_KEY, JSON.stringify(list));
    syncRegistryToBackend();
    return list;
}

export function getActiveWpConnection() {
    const list = getWpConnections();
    const activeId = localStorage.getItem(ACTIVE_WP_CONN_KEY);
    const found = list.find((c) => c.id === activeId);
    return found || list[0] || DEFAULT_WP_CONNECTION;
}

export function setActiveWpConnectionId(id) {
    localStorage.setItem(ACTIVE_WP_CONN_KEY, id);
}

/**
 * Perform a live connection check against a WordPress instance.
 */
export async function testWpConnection(conn) {
    if (!conn?.url) {
        return { ok: false, message: "URL is empty." };
    }
    const targetUrl = normalizeWpFormsUrl(conn.url);
    const headers = {
        Accept: "application/json",
        "ngrok-skip-browser-warning": "true",
    };
    if (conn.apiKey) {
        headers["X-PDF-API-Key"] = conn.apiKey;
    }
    if (conn.basicUser || conn.basicPass) {
        const authStr = `${conn.basicUser || ""}:${conn.basicPass || ""}`;
        headers["Authorization"] = `Basic ${btoa(authStr)}`;
    }

    try {
        // First try direct fetch
        let res = null;
        try {
            res = await fetch(targetUrl, { headers });
        } catch {
            // If CORS/network fails, retry through Vite proxy
            const proxyUrl = `/api/wp-proxy?url=${encodeURIComponent(targetUrl)}&apiKey=${encodeURIComponent(conn.apiKey || "")}&basicUser=${encodeURIComponent(conn.basicUser || "")}&basicPass=${encodeURIComponent(conn.basicPass || "")}`;
            res = await fetch(proxyUrl);
        }

        if (!res || !res.ok) {
            return {
                ok: false,
                status: res?.status,
                message: `HTTP ${res?.status || "error"}: Failed to reach endpoint.`,
            };
        }

        const data = await res.json();
        const forms = Array.isArray(data) ? data : data.forms || [];
        return {
            ok: true,
            status: res.status,
            formsCount: forms.length,
            forms: forms,
            message: `Connected successfully! Found ${forms.length} Gravity Form${forms.length === 1 ? "" : "s"}.`,
        };
    } catch (err) {
        return {
            ok: false,
            message: `Connection failed: ${err.message}`,
        };
    }
}

// =========================================================
// PDF TEMPLATES
// =========================================================

function getTemplateId(t, fallback = "") {
    const raw =
        t?.templateId ||
        t?.id ||
        t?.template?.id ||
        t?.template?.filename ||
        t?.filename ||
        t?.name ||
        fallback;

    if (!raw) return fallback || "template-default";

    return String(raw)
        .replace(/\.pdf$/i, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "template-default";
}

export function ensureTemplateAnalysis(t) {
    if (!t) return DEFAULT_PDF_TEMPLATE;
    const id = t.id || getTemplateId(t.analysis || t);
    const filename = t.filename || t.analysis?.template?.filename || t.name || `${id}.pdf`;
    const name = t.name || t.analysis?.template?.title || filename;
    const category = t.category || "AIBT";
    const cleanFilename = filename.replace(/%20/g, "_").replace(/ /g, "_");

    let url = t.url;
    if (!url || url.startsWith("blob:")) {
        if (id === DEFAULT_PDF_TEMPLATE.id || filename.includes("NPA_Credit")) {
            url = defaultPdfBytesUrl;
        } else if (cleanFilename) {
            url = `/templates/${encodeURIComponent(category)}/${encodeURIComponent(cleanFilename)}`;
        } else if (t.sourceUrl) {
            url = t.sourceUrl;
        }
    }

    const baseAnalysis = t.analysis || {};

    return {
        ...t,
        id,
        filename,
        name,
        category,
        url,
        analysis: {
            ...baseAnalysis,
            template: {
                id,
                filename,
                title: name,
                ...(baseAnalysis.template || {}),
            },
            technical: {
                pages: 1,
                fieldCount: 0,
                hasAcroForm: false,
                ...(baseAnalysis.technical || {}),
            },
            schema: {
                fields: [],
                ...(baseAnalysis.schema || {}),
            },
            context: {
                pages: [],
                ...(baseAnalysis.context || {}),
            },
        },
    };
}

export function resolvePdfUrl(tpl) {
    if (!tpl) return defaultPdfBytesUrl;
    if (typeof tpl === "string") {
        if (tpl.startsWith("blob:")) return tpl;
        if ((tpl.startsWith("http://") || tpl.startsWith("https://")) && typeof window !== "undefined" && !tpl.includes(window.location.host)) {
            return `/api/wp-proxy?url=${encodeURIComponent(tpl)}`;
        }
        return tpl;
    }

    const filename = tpl.filename || tpl.name || tpl.template?.filename || "";
    const cleanFilename = filename.replace(/%20/g, "_").replace(/ /g, "_");
    const category = tpl.category || "AIBT";

    if (tpl.id === DEFAULT_PDF_TEMPLATE.id || filename.includes("NPA_Credit Transfer Forms")) {
        return defaultPdfBytesUrl;
    }

    // If local templates exist in public
    if (cleanFilename) {
        const localCandidate = `/templates/${encodeURIComponent(category)}/${encodeURIComponent(cleanFilename)}`;
        if (tpl.url && (tpl.url === localCandidate || tpl.url.startsWith("/templates/"))) {
            return tpl.url;
        }
    }

    if (tpl.url && !tpl.url.startsWith("blob:")) {
        if ((tpl.url.startsWith("http://") || tpl.url.startsWith("https://")) && typeof window !== "undefined" && !tpl.url.includes(window.location.host)) {
            return `/api/wp-proxy?url=${encodeURIComponent(tpl.url)}`;
        }
        return tpl.url;
    }

    if (tpl.localUrl && !tpl.localUrl.startsWith("blob:")) {
        return tpl.localUrl;
    }

    if (cleanFilename) {
        return `/templates/${encodeURIComponent(category)}/${encodeURIComponent(cleanFilename)}`;
    }

    if (tpl.sourceUrl) {
        if ((tpl.sourceUrl.startsWith("http://") || tpl.sourceUrl.startsWith("https://")) && typeof window !== "undefined" && !tpl.sourceUrl.includes(window.location.host)) {
            return `/api/wp-proxy?url=${encodeURIComponent(tpl.sourceUrl)}`;
        }
        return tpl.sourceUrl;
    }

    if (tpl.cdnUrl) {
        if ((tpl.cdnUrl.startsWith("http://") || tpl.cdnUrl.startsWith("https://")) && typeof window !== "undefined" && !tpl.cdnUrl.includes(window.location.host)) {
            return `/api/wp-proxy?url=${encodeURIComponent(tpl.cdnUrl)}`;
        }
        return tpl.cdnUrl;
    }

    return tpl.url || defaultPdfBytesUrl;
}

export async function fetchPdfBytes(templateOrUrl) {
    if (!templateOrUrl) return null;
    if (templateOrUrl instanceof Uint8Array) return { bytes: templateOrUrl, successfulUrl: "" };
    if (templateOrUrl instanceof ArrayBuffer) return { bytes: new Uint8Array(templateOrUrl), successfulUrl: "" };

    const candidates = [];
    if (typeof templateOrUrl === "string") {
        candidates.push(templateOrUrl);
        if (templateOrUrl.startsWith("http://") || templateOrUrl.startsWith("https://")) {
            candidates.push(`/api/wp-proxy?url=${encodeURIComponent(templateOrUrl)}`);
        }
    } else {
        const tpl = templateOrUrl;
        const category = tpl.category || "AIBT";
        const rawFilename = tpl.filename || tpl.name || tpl.template?.filename || "";
        const cleanFilename = rawFilename.replace(/%20/g, "_").replace(/ /g, "_");

        if (tpl.id === DEFAULT_PDF_TEMPLATE.id || rawFilename.includes("NPA_Credit Transfer Forms")) {
            candidates.push(defaultPdfBytesUrl);
            candidates.push("/templates/NPA/NPA_Credit_Transfer_Forms_V2.1.pdf");
        }

        if (cleanFilename) {
            candidates.push(`/templates/${encodeURIComponent(category)}/${encodeURIComponent(cleanFilename)}`);
            candidates.push(`/templates/${encodeURIComponent(category)}/${encodeURIComponent(rawFilename)}`);
        }

        if (tpl.localUrl && !tpl.localUrl.startsWith("blob:")) {
            candidates.push(tpl.localUrl);
        }

        if (tpl.url && !tpl.url.startsWith("blob:")) {
            candidates.push(tpl.url);
        }

        if (tpl.sourceUrl) {
            candidates.push(tpl.sourceUrl);
        }

        if (tpl.cdnUrl) {
            candidates.push(tpl.cdnUrl);
        }

        if (tpl.url && tpl.url.startsWith("blob:")) {
            candidates.push(tpl.url);
        }
    }

    for (const url of candidates) {
        if (!url) continue;
        try {
            let targetUrl = url;
            if (typeof window !== "undefined") {
                const isExternal = (url.startsWith("http://") || url.startsWith("https://")) && !url.includes(window.location.host);
                if (isExternal && !url.startsWith("/api/wp-proxy")) {
                    targetUrl = `/api/wp-proxy?url=${encodeURIComponent(url)}`;
                }
            }
            const res = await fetch(targetUrl);
            if (res.ok) {
                const buf = await res.arrayBuffer();
                if (buf && buf.byteLength > 100) {
                    return { bytes: new Uint8Array(buf), successfulUrl: targetUrl };
                }
            }
        } catch {
            // continue to next candidate
        }
    }
    return null;
}

export function getPdfTemplates() {
    try {
        const raw = localStorage.getItem(PDF_TEMPLATES_KEY);
        if (raw) {
            const list = JSON.parse(raw);
            if (Array.isArray(list) && list.length > 0) {
                // Ensure default is always present
                const hasDefault = list.some((t) => t.id === DEFAULT_PDF_TEMPLATE.id);
                if (!hasDefault) list.unshift(DEFAULT_PDF_TEMPLATE);
                return list.map((t) => {
                    if ((t.id === DEFAULT_PDF_TEMPLATE.id || t.filename === DEFAULT_PDF_TEMPLATE.filename) && (!t.analysis || !t.url)) {
                        return {
                            ...DEFAULT_PDF_TEMPLATE,
                            ...t,
                            url: defaultPdfBytesUrl,
                            analysis: templateAnalysis,
                        };
                    }
                    return ensureTemplateAnalysis(t);
                });
            }
        }
    } catch {
        // Fallback
    }
    if (defaultRegistryJson && Array.isArray(defaultRegistryJson.pdfTemplates) && defaultRegistryJson.pdfTemplates.length > 0) {
        return defaultRegistryJson.pdfTemplates.map((t) => {
            if (t.id === DEFAULT_PDF_TEMPLATE.id || t.filename === DEFAULT_PDF_TEMPLATE.filename) {
                return {
                    ...DEFAULT_PDF_TEMPLATE,
                    ...t,
                    url: defaultPdfBytesUrl,
                    analysis: templateAnalysis,
                };
            }
            return ensureTemplateAnalysis(t);
        });
    }
    return [DEFAULT_PDF_TEMPLATE];
}

export function savePdfTemplate(tpl) {
    const list = getPdfTemplates();
    const id = tpl.id || `tpl-${Date.now()}`;
    const existingIdx = list.findIndex((t) => t.id === id);
    const item = { ...tpl, id };
    if (existingIdx >= 0) {
        list[existingIdx] = item;
    } else {
        list.push(item);
    }
    localStorage.setItem(PDF_TEMPLATES_KEY, JSON.stringify(list));
    syncRegistryToBackend();
    return item;
}

export function deletePdfTemplate(id) {
    if (id === DEFAULT_PDF_TEMPLATE.id) return getPdfTemplates(); // Don't delete built-in
    const list = getPdfTemplates().filter((t) => t.id !== id);
    localStorage.setItem(PDF_TEMPLATES_KEY, JSON.stringify(list));
    syncRegistryToBackend();
    return list;
}

export function getActivePdfTemplate() {
    const list = getPdfTemplates();
    const activeId = localStorage.getItem(ACTIVE_PDF_TPL_KEY);
    const found = list.find((t) => t.id === activeId);
    return found || list[0] || DEFAULT_PDF_TEMPLATE;
}

export function setActivePdfTemplateId(id) {
    localStorage.setItem(ACTIVE_PDF_TPL_KEY, id);
    syncRegistryToBackend();
}

// =========================================================
// CENTRAL SOURCES & TEMPLATES JSON DATABASE SYNC & API
// =========================================================

export function getRegistryDatabase() {
    return {
        $schema: "http://json-schema.org/draft-07/schema#",
        version: 1,
        description: "Database registry for Gravity Form Sources (WordPress & External API instances) and PDF Template Targets (Local files, Google Cloud Storage & CDN URLs).",
        lastUpdated: new Date().toISOString(),
        activeWpConnectionId: localStorage.getItem(ACTIVE_WP_CONN_KEY) || "default-localwp",
        activePdfTemplateId: localStorage.getItem(ACTIVE_PDF_TPL_KEY) || "default-npa",
        gravityFormSources: getWpConnections(),
        pdfTemplates: getPdfTemplates().map((t) => {
            // Strip large AST if present for compact and clean JSON DB storage
            const cleanTemplate = { ...t };
            delete cleanTemplate.analysis;
            return cleanTemplate;
        }),
    };
}

export async function syncRegistryToBackend() {
    try {
        const payload = getRegistryDatabase();
        await fetch("/api/registry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch (e) {
        console.debug("Could not sync sources-and-templates.json to backend:", e.message);
    }
}

export async function fetchRegistryFromBackend() {
    try {
        const res = await fetch("/api/registry");
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.gravityFormSources) && data.gravityFormSources.length > 0) {
                localStorage.setItem(WP_CONNS_KEY, JSON.stringify(data.gravityFormSources));
            }
            if (Array.isArray(data.pdfTemplates) && data.pdfTemplates.length > 0) {
                const fixed = data.pdfTemplates.map((t) => {
                    if (t.id === DEFAULT_PDF_TEMPLATE.id || t.filename === DEFAULT_PDF_TEMPLATE.filename) {
                        return {
                            ...DEFAULT_PDF_TEMPLATE,
                            ...t,
                            analysis: templateAnalysis,
                            url: defaultPdfBytesUrl,
                        };
                    }
                    return t;
                });
                localStorage.setItem(PDF_TEMPLATES_KEY, JSON.stringify(fixed));
            }
            if (data.activeWpConnectionId) {
                localStorage.setItem(ACTIVE_WP_CONN_KEY, data.activeWpConnectionId);
            }
            if (data.activePdfTemplateId) {
                localStorage.setItem(ACTIVE_PDF_TPL_KEY, data.activePdfTemplateId);
            }
            return data;
        }
    } catch (err) {
        console.debug("Could not fetch registry from backend:", err.message);
    }
    return null;
}

export async function saveRawRegistryDatabase(jsonObj) {
    if (!jsonObj || typeof jsonObj !== "object") {
        throw new Error("Invalid JSON: Root must be an object.");
    }
    if (!Array.isArray(jsonObj.gravityFormSources)) {
        throw new Error("Missing or invalid 'gravityFormSources' array in JSON.");
    }
    if (!Array.isArray(jsonObj.pdfTemplates)) {
        throw new Error("Missing or invalid 'pdfTemplates' array in JSON.");
    }

    // Persist to localStorage
    localStorage.setItem(WP_CONNS_KEY, JSON.stringify(jsonObj.gravityFormSources));

    const hydratedTemplates = jsonObj.pdfTemplates.map((t) => {
        if (t.id === DEFAULT_PDF_TEMPLATE.id || t.filename === DEFAULT_PDF_TEMPLATE.filename) {
            return {
                ...DEFAULT_PDF_TEMPLATE,
                ...t,
                analysis: templateAnalysis,
                url: defaultPdfBytesUrl,
            };
        }
        return t;
    });
    localStorage.setItem(PDF_TEMPLATES_KEY, JSON.stringify(hydratedTemplates));

    if (jsonObj.activeWpConnectionId) {
        localStorage.setItem(ACTIVE_WP_CONN_KEY, jsonObj.activeWpConnectionId);
    }
    if (jsonObj.activePdfTemplateId) {
        localStorage.setItem(ACTIVE_PDF_TPL_KEY, jsonObj.activePdfTemplateId);
    }

    // Persist directly to server /sources-and-templates.json
    const res = await fetch("/api/registry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jsonObj),
    });

    if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status} when saving sources-and-templates.json`);
    }

    return await res.json();
}

/**
 * Fetch and analyze a PDF from a direct URL (Google Cloud Storage, WordPress media, or web URL).
 */
export async function ingestPdfFromUrl(url, customName = "") {
    if (!url) throw new Error("No URL provided.");

    let buffer = null;

    // Attempt direct fetch first
    try {
        const directRes = await fetch(url);
        if (directRes.ok) {
            buffer = await directRes.arrayBuffer();
        }
    } catch {
        // Retry via proxy to bypass CORS
    }

    if (!buffer) {
        const proxyUrl = `/api/wp-proxy?url=${encodeURIComponent(url)}`;
        const proxyRes = await fetch(proxyUrl);
        if (!proxyRes.ok) {
            throw new Error(`Failed to download PDF from URL: HTTP ${proxyRes.status}`);
        }
        buffer = await proxyRes.arrayBuffer();
    }

    const filename = customName || url.split("/").pop().split("?")[0] || "downloaded-template.pdf";
    const bytes = new Uint8Array(buffer);
    const analysis = await analyzePdfBytes(bytes, filename);

    const blob = new Blob([bytes], { type: "application/pdf" });
    const blobUrl = URL.createObjectURL(blob);

    const newTemplate = {
        id: `tpl-${Date.now()}`,
        name: filename,
        filename,
        url: blobUrl,
        analysis,
        sourceUrl: url,
        createdAt: new Date().toISOString(),
    };

    savePdfTemplate(newTemplate);
    return newTemplate;
}

// =========================================================
// AUTOMATION CONFIGURATION
// =========================================================

export function getAutomationSettings() {
    try {
        const raw = localStorage.getItem(AUTOMATION_CONFIG_KEY);
        if (raw) return JSON.parse(raw);
    } catch {
        // Fallback
    }
    return {
        // Map formId -> { enabled: boolean, templateId: string, mappingFile: string, storagePath: string, notifyEmail: boolean }
        forms: {
            "1": {
                enabled: true,
                templateId: "default-npa",
                storagePath: "wp-content/pdf-generator/generated/",
                emailNotificationEnabled: true,
            },
        },
    };
}

export function saveAutomationSettings(settings) {
    localStorage.setItem(AUTOMATION_CONFIG_KEY, JSON.stringify(settings));
    return settings;
}
