import { useState } from "react";
import {
    Pencil,
    Trash2,
    Plus,
    Cloud,
    Upload,
    Loader2,
    CheckCircle2,
    Check,
    Copy,
    Info,
    Layers,
    Scan,
    Code,
    Download,
    ArrowRight,
} from "lucide-react";
import { analyzePdfBytes } from "../templateAnalyzer";
import defaultTemplateAnalysis from "../../../template-analysis.json";
import defaultPdfUrl from "../../../NPA_Credit Transfer Forms_V2.1.pdf";
import {
    savePdfTemplate,
    GCS_CATEGORY_OPTIONS,
    GCS_BUCKET,
    GCS_PROJECT_ID,
    GCS_BASE_PATH,
    uploadTemplateToGcs,
} from "../connectionManager";
import GoogleCloudCredentialsModal from "./GoogleCloudCredentialsModal";
import "./TemplateIngestionPage.css";

export default function TemplateIngestionPage({
    onUseTemplateInMapper,
    activeTemplate,
    pdfTemplatesList = [],
    onSelectPdfTemplate,
    onAddPdfTemplate,
    onEditPdfTemplate,
    onRemovePdfTemplate,
    wpConnections = [],
    activeWpConn,
    onSelectWpConn,
    onAddWpConn,
    onEditWpConn,
    onRemoveWpConn,
    wpConnStatus,
    onTestWpConn,
    forms = [],
    selectedForm,
    onSelectForm,
    onOpenJsonDb,
}) {
    const [currentAnalysis, setCurrentAnalysis] = useState(activeTemplate?.analysis || defaultTemplateAnalysis);
    const [currentPdfUrl, setCurrentPdfUrl] = useState(activeTemplate?.url || defaultPdfUrl);
    const [currentLocalUrl, setCurrentLocalUrl] = useState(activeTemplate?.localUrl || "");
    const [currentTemplateId, setCurrentTemplateId] = useState(activeTemplate?.id || "");
    const [currentFilename, setCurrentFilename] = useState(activeTemplate?.filename || activeTemplate?.name || "NPA_Credit Transfer Forms_V2.1.pdf");
    const [selectedCategory, setSelectedCategory] = useState(activeTemplate?.category || "NPA");
    const [activeTab, setActiveTab] = useState("fields"); // "fields", "context", "json"
    const [selectedPageNum, setSelectedPageNum] = useState(1);
    const [fieldFilter, setFieldFilter] = useState("");
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [statusMsg, setStatusMsg] = useState("");
    const [cloudUrl, setCloudUrl] = useState("");
    const [copiedJson, setCopiedJson] = useState(false);
    const [copiedGcloud, setCopiedGcloud] = useState(false);
    const [isGcsModalOpen, setIsGcsModalOpen] = useState(false);
    const [gcsUploadResult, setGcsUploadResult] = useState(null);
    const [isUploadingToGcs, setIsUploadingToGcs] = useState(false);

    const [prevActiveTemplateId, setPrevActiveTemplateId] = useState(activeTemplate?.id);
    if (activeTemplate && activeTemplate.id !== prevActiveTemplateId) {
        setPrevActiveTemplateId(activeTemplate.id);
        setCurrentAnalysis(activeTemplate.analysis || defaultTemplateAnalysis);
        setCurrentPdfUrl(activeTemplate.url || defaultPdfUrl);
        setCurrentFilename(activeTemplate.filename || activeTemplate.name || "NPA_Credit Transfer Forms_V2.1.pdf");
        setSelectedCategory(activeTemplate.category || "NPA");
    }

    // Handle Local File Upload with GCS Destination Upload & Ingestion
    const handleFileUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsAnalyzing(true);
        setStatusMsg("Reading file bytes and running analyze-template engine...");
        setGcsUploadResult(null);

        try {
            const arrayBuffer = await file.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            setStatusMsg("Running Layer 1 (pdf-lib AcroForm) & Layer 2 (PDF.js Context Geometry)...");

            // Execute ingestion engine ensuring exact format matching analyze-template.js
            const analysis = await analyzePdfBytes(bytes, file.name);
            const blob = new Blob([bytes], { type: "application/pdf" });
            const blobUrl = URL.createObjectURL(blob);

            setCurrentAnalysis(analysis);
            setCurrentPdfUrl(blobUrl);
            setCurrentFilename(file.name);
            setStatusMsg(`Ingestion verified for ${file.name}. Syncing to Google Cloud Storage under /${selectedCategory}...`);

            // Upload to Google Cloud Storage target destination
            setIsUploadingToGcs(true);
            let gcsResponse = null;
            try {
                gcsResponse = await uploadTemplateToGcs({
                    fileBytes: bytes,
                    filename: file.name,
                    category: selectedCategory,
                });
                setGcsUploadResult(gcsResponse);
            } catch (uploadErr) {
                console.warn("GCS upload warning:", uploadErr);
                gcsResponse = {
                    success: false,
                    status: "credentials_needed",
                    message: uploadErr.message,
                    targetGcsPath: `${GCS_BASE_PATH}/${selectedCategory}/${file.name}`,
                    gcsUri: `gs://${GCS_BUCKET}/${GCS_BASE_PATH}/${selectedCategory}/${file.name}`,
                    publicCdnUrl: `https://${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(selectedCategory)}/${encodeURIComponent(file.name)}`,
                    consoleUrl: `https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(selectedCategory)}?project=${GCS_PROJECT_ID}`,
                    gcloudCommand: `gcloud storage cp "${file.name}" "gs://${GCS_BUCKET}/${GCS_BASE_PATH}/${selectedCategory}/${file.name}"`,
                };
                setGcsUploadResult(gcsResponse);
            } finally {
                setIsUploadingToGcs(false);
            }

            // Save template record with destination and metadata
            const cleanLocalUrl = gcsResponse?.localUrl || `/templates/${encodeURIComponent(selectedCategory)}/${encodeURIComponent(file.name)}`;
            const finalUrl = cleanLocalUrl;
            const newTplId = `tpl-${Date.now()}`;
            setCurrentTemplateId(newTplId);
            setCurrentLocalUrl(cleanLocalUrl);

            savePdfTemplate({
                id: newTplId,
                name: file.name,
                filename: file.name,
                category: selectedCategory,
                url: finalUrl,
                localUrl: cleanLocalUrl,
                analysis,
                gcsPath: gcsResponse?.targetGcsPath || `${GCS_BASE_PATH}/${selectedCategory}/${file.name}`,
                gcsUri: gcsResponse?.gcsUri || `gs://${GCS_BUCKET}/${GCS_BASE_PATH}/${selectedCategory}/${file.name}`,
                cdnUrl: gcsResponse?.publicCdnUrl || `https://${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(selectedCategory)}/${encodeURIComponent(file.name)}`,
                consoleUrl: gcsResponse?.consoleUrl || `https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(selectedCategory)}?project=${GCS_PROJECT_ID}`,
                uploadStatus: gcsResponse?.success ? "synced" : "credentials_needed",
                createdAt: new Date().toISOString(),
            });

            setStatusMsg(`Ingestion complete! ${analysis.technical.fieldCount} fields mapped. Target destination: gs://${GCS_BUCKET}/${GCS_BASE_PATH}/${selectedCategory}/${file.name}`);
        } catch (err) {
            console.error("Analysis error:", err);
            setStatusMsg(`Analysis failed: ${err.message}`);
        } finally {
            setIsAnalyzing(false);
        }
    };

    // Handle Cloud / Web URL Ingestion
    const handleCloudUrlIngest = async (e) => {
        e.preventDefault();
        if (!cloudUrl.trim()) return;

        setIsAnalyzing(true);
        setStatusMsg("Fetching PDF stream from URL...");
        try {
            let buffer = null;
            try {
                const res = await fetch(cloudUrl.trim());
                if (res.ok) buffer = await res.arrayBuffer();
            } catch {
                // Try proxy
            }

            if (!buffer) {
                const proxyUrl = `/api/wp-proxy?url=${encodeURIComponent(cloudUrl.trim())}`;
                const res = await fetch(proxyUrl);
                if (!res.ok) throw new Error(`HTTP ${res.status} from proxy`);
                buffer = await res.arrayBuffer();
            }

            const bytes = new Uint8Array(buffer);
            const rawFilename = cloudUrl.split("/").pop().split("?")[0] || "cloud-template.pdf";
            const filename = decodeURIComponent(rawFilename).replace(/[^a-zA-Z0-9._-]/g, "_");

            setStatusMsg("Analyzing AcroForm and text context geometry...");
            const analysis = await analyzePdfBytes(bytes, filename);

            setStatusMsg("Saving template copy locally and syncing with cloud...");
            let gcsResponse = null;
            try {
                gcsResponse = await uploadTemplateToGcs({
                    fileBytes: bytes,
                    filename,
                    category: selectedCategory,
                });
            } catch (uploadErr) {
                console.warn("Local/cloud caching error:", uploadErr);
            }

            const cleanLocalUrl = gcsResponse?.localUrl || `/templates/${encodeURIComponent(selectedCategory)}/${encodeURIComponent(filename)}`;
            const blob = new Blob([bytes], { type: "application/pdf" });
            const blobUrl = URL.createObjectURL(blob);

            setCurrentAnalysis(analysis);
            setCurrentPdfUrl(cleanLocalUrl || blobUrl);
            setCurrentLocalUrl(cleanLocalUrl);
            setCurrentFilename(filename);
            const templateId = `tpl-${Date.now()}`;
            setCurrentTemplateId(templateId);
            setStatusMsg(`Analysis complete for ${filename}! (${analysis.technical.fieldCount} AcroForm fields mapped)`);

            savePdfTemplate({
                id: templateId,
                name: filename,
                filename,
                category: selectedCategory,
                url: cleanLocalUrl,
                localUrl: cleanLocalUrl,
                analysis,
                sourceUrl: cloudUrl.trim(),
                gcsPath: gcsResponse?.targetGcsPath || `${GCS_BASE_PATH}/${selectedCategory}/${filename}`,
                gcsUri: gcsResponse?.gcsUri || `gs://${GCS_BUCKET}/${GCS_BASE_PATH}/${selectedCategory}/${filename}`,
                cdnUrl: gcsResponse?.publicCdnUrl || `https://${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(selectedCategory)}/${encodeURIComponent(filename)}`,
                uploadStatus: gcsResponse?.success ? "synced" : "credentials_needed",
                createdAt: new Date().toISOString(),
            });
        } catch (err) {
            console.error("URL Ingestion error:", err);
            setStatusMsg(`Ingestion failed: ${err.message}`);
        } finally {
            setIsAnalyzing(false);
        }
    };

    // Reset to NPA Default
    const handleLoadDefault = () => {
        setCurrentAnalysis(defaultTemplateAnalysis);
        setCurrentPdfUrl(defaultPdfUrl);
        setCurrentFilename("NPA_Credit Transfer Forms_V2.1.pdf");
        setSelectedCategory("NPA");
        setGcsUploadResult(null);
        setStatusMsg("Loaded built-in NPA Credit Transfer template.");
    };

    // Download template-analysis.json
    const handleDownloadJson = () => {
        const jsonStr = JSON.stringify(currentAnalysis, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        const baseName = currentFilename ? currentFilename.replace(/\.pdf$/i, "") : "template";
        link.download = `${baseName}-analysis.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    // Copy JSON to clipboard
    const handleCopyJson = () => {
        navigator.clipboard.writeText(JSON.stringify(currentAnalysis, null, 2));
        setCopiedJson(true);
        setTimeout(() => setCopiedJson(false), 2000);
    };

    // Copy gcloud storage CLI command
    const handleCopyGcloud = () => {
        const cmd = gcsUploadResult?.gcloudCommand || `gcloud storage cp "${currentFilename}" "gs://${GCS_BUCKET}/${GCS_BASE_PATH}/${selectedCategory}/${currentFilename}"`;
        navigator.clipboard.writeText(cmd);
        setCopiedGcloud(true);
        setTimeout(() => setCopiedGcloud(false), 2500);
    };

    // Send to /mapper
    const handleUseInMapper = () => {
        if (onUseTemplateInMapper) {
            onUseTemplateInMapper({
                id: currentTemplateId || `tpl-${Date.now()}`,
                name: currentFilename,
                filename: currentFilename,
                category: selectedCategory,
                url: currentLocalUrl || currentPdfUrl,
                localUrl: currentLocalUrl,
                analysis: currentAnalysis,
                gcsPath: `${GCS_BASE_PATH}/${selectedCategory}/${currentFilename}`,
                gcsUri: `gs://${GCS_BUCKET}/${GCS_BASE_PATH}/${selectedCategory}/${currentFilename}`,
                cdnUrl: `https://${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(selectedCategory)}/${encodeURIComponent(currentFilename)}`,
            });
        }
    };

    // Filter fields
    const technicalFields = currentAnalysis?.technical?.fields || [];
    const filteredFields = technicalFields.filter((f) =>
        f.name.toLowerCase().includes(fieldFilter.toLowerCase()) ||
        f.type.toLowerCase().includes(fieldFilter.toLowerCase())
    );

    const activePageContext = (currentAnalysis?.context?.pages || []).find(
        (p) => p.page === selectedPageNum
    ) || currentAnalysis?.context?.pages?.[0];

    return (
        <div className="analyze-page-container">
            {/* Page Header */}
            <div className="page-header-row">
                <div>
                    <span className="section-kicker">Step 1 • Template Ingestion Engine</span>
                    <h2>PDF Template Analysis & Ingestion</h2>
                    <p>
                        Analyze any fillable PDF template using <code>pdf-lib</code> (Layer 1: AcroForm) and <code>PDF.js</code> (Layer 2: Visual Geometry Context) to produce <code>template-analysis.json</code>.
                    </p>
                </div>

                <div className="header-actions">
                    <button
                        type="button"
                        className="btn-download-json"
                        onClick={handleDownloadJson}
                        title="Download template-analysis.json to your computer"
                        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                        <Download size={14} /> Download Analysis JSON
                    </button>
                    <button
                        type="button"
                        className="btn-use-mapper"
                        onClick={handleUseInMapper}
                        title="Open this analyzed template directly in the Field Mapper workspace"
                        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                        <span>Open in Field Mapper</span>
                        <ArrowRight size={14} />
                    </button>
                </div>
            </div>

            {/* Source & Target Configuration Hub (Add / Remove / Edit Options) */}
            <section className="source-target-hub-card" aria-label="Source and Target Configuration">
                <div className="hub-top-registry-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid #e2e8f0" }}>
                    <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#0f766e" }}>Central Database Registry</span>
                            <span style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#047857", fontSize: 11, padding: "1px 8px", borderRadius: 10, fontWeight: 600 }}>sources-and-templates.json</span>
                        </div>
                        <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>
                            File-based database storing all Gravity Form endpoints and PDF template targets (local files, Google Cloud Storage & CDN links).
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onOpenJsonDb}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px", background: "#0f766e", color: "#ffffff", border: "none", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                        title="View, edit, download or import the persistent sources-and-templates.json file"
                    >
                        <Code size={13} />
                        <span>View / Edit JSON DB</span>
                    </button>
                </div>
                <div className="hub-grid">
                    {/* Left Column: Gravity Form Source */}
                    <div className="hub-column source-column">
                        <div className="hub-col-header">
                            <div className="hub-title-badge">
                                <span className="hub-tag">SOURCE</span>
                                <h3>Gravity Form Source</h3>
                            </div>
                            <div className="hub-actions">
                                <button
                                    type="button"
                                    className="hub-btn hub-btn-add"
                                    onClick={onAddWpConn}
                                    title="Add a new WordPress instance / Gravity Form source"
                                >
                                    <Plus size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                    Add Source
                                </button>
                                <button
                                    type="button"
                                    className="hub-btn hub-btn-edit"
                                    onClick={onEditWpConn}
                                    title="Edit active Gravity Form source credentials and URL"
                                >
                                    <Pencil size={11} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                    Edit Source
                                </button>
                                <button
                                    type="button"
                                    className="hub-btn hub-btn-delete"
                                    onClick={() => onRemoveWpConn && onRemoveWpConn(activeWpConn?.id)}
                                    disabled={!wpConnections || wpConnections.length <= 1}
                                    title={wpConnections?.length <= 1 ? "Cannot remove the only configured source" : "Remove active Gravity Form source"}
                                >
                                    <Trash2 size={11} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                    Remove
                                </button>
                            </div>
                        </div>

                        <div className="hub-controls-row">
                            <div className="hub-field-group">
                                <label htmlFor="hub-wp-source-select">WordPress Instance</label>
                                <select
                                    id="hub-wp-source-select"
                                    value={activeWpConn?.id || ""}
                                    onChange={(e) => onSelectWpConn && onSelectWpConn(e.target.value)}
                                    className="hub-select"
                                >
                                    {wpConnections.map((conn) => (
                                        <option key={conn.id} value={conn.id}>
                                            {conn.name}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="hub-field-group">
                                <label htmlFor="hub-gf-form-select">Active Gravity Form</label>
                                <select
                                    id="hub-gf-form-select"
                                    value={selectedForm?.id || ""}
                                    onChange={(e) => onSelectForm && onSelectForm(e.target.value)}
                                    className="hub-select"
                                >
                                    {forms.length === 0 ? (
                                        <option value="">No forms detected</option>
                                    ) : (
                                        forms.map((f) => (
                                            <option key={f.id} value={f.id}>
                                                Form #{f.id}: {f.title}
                                            </option>
                                        ))
                                    )}
                                </select>
                            </div>
                        </div>

                        <div className="hub-meta-box">
                            <div className="hub-status-line">
                                <span className={`hub-status-dot ${wpConnStatus?.ok ? "is-ok" : wpConnStatus?.loading ? "is-loading" : "is-error"}`} />
                                <span className="hub-status-text">
                                    {wpConnStatus?.loading
                                        ? "Verifying connection…"
                                        : wpConnStatus?.ok
                                        ? `Connected (${wpConnStatus.formsCount ?? forms.length} forms available)`
                                        : "Connection check needed"}
                                </span>
                                <button
                                    type="button"
                                    className="hub-test-btn"
                                    onClick={onTestWpConn}
                                    disabled={wpConnStatus?.loading}
                                    title="Test connection and refresh forms"
                                >
                                    {wpConnStatus?.loading ? "Testing…" : "↻ Test & Refresh"}
                                </button>
                            </div>
                            <div className="hub-url-line">
                                <code>{activeWpConn?.url || "No REST endpoint configured"}</code>
                            </div>
                        </div>
                    </div>

                    {/* Right Column: PDF Template Target */}
                    <div className="hub-column target-column">
                        <div className="hub-col-header">
                            <div className="hub-title-badge">
                                <span className="hub-tag target-tag">TARGET</span>
                                <h3>PDF Template Target</h3>
                            </div>
                            <div className="hub-actions">
                                <button
                                    type="button"
                                    className="hub-btn hub-btn-add"
                                    onClick={onAddPdfTemplate}
                                    title="Upload or ingest a new PDF template"
                                >
                                    <Plus size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                    Add Template
                                </button>
                                <button
                                    type="button"
                                    className="hub-btn hub-btn-edit"
                                    onClick={() => onEditPdfTemplate && onEditPdfTemplate(activeTemplate)}
                                    title="Edit template display name, department category or CDN URL"
                                >
                                    <Pencil size={11} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                    Edit Template
                                </button>
                                <button
                                    type="button"
                                    className="hub-btn hub-btn-delete"
                                    onClick={() => onRemovePdfTemplate && onRemovePdfTemplate(activeTemplate?.id)}
                                    disabled={activeTemplate?.id === "default-npa" || activeTemplate?.id === "npa-credit-transfer-default"}
                                    title={activeTemplate?.id === "default-npa" ? "Default template cannot be deleted" : "Remove template from list"}
                                >
                                    <Trash2 size={11} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                    Remove
                                </button>
                            </div>
                        </div>

                        <div className="hub-controls-row">
                            <div className="hub-field-group" style={{ flex: 2 }}>
                                <label htmlFor="hub-pdf-tpl-select">Active PDF Template Target</label>
                                <select
                                    id="hub-pdf-tpl-select"
                                    value={activeTemplate?.id || ""}
                                    onChange={(e) => onSelectPdfTemplate && onSelectPdfTemplate(e.target.value)}
                                    className="hub-select"
                                >
                                    {pdfTemplatesList.map((tpl, idx) => (
                                        <option key={tpl.id || tpl.filename || `ingest-tpl-${idx}`} value={tpl.id}>
                                            {tpl.name || tpl.filename} ({tpl.category || "NPA"})
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="hub-field-group" style={{ flex: 1 }}>
                                <label>Department / Category</label>
                                <span className="hub-category-pill">
                                    {activeTemplate?.category || selectedCategory || "NPA"}
                                </span>
                            </div>
                        </div>

                        <div className="hub-meta-box">
                            <div className="hub-status-line">
                                <span className="hub-target-stat">
                                    <strong>{activeTemplate?.analysis?.technical?.pages || currentAnalysis?.technical?.pages || 0}</strong> pages
                                </span>
                                <span className="hub-sep">•</span>
                                <span className="hub-target-stat">
                                    <strong>{activeTemplate?.analysis?.technical?.fieldCount || currentAnalysis?.technical?.fieldCount || 0}</strong> AcroForm fields
                                </span>
                                <span className="hub-sep">•</span>
                                <span className={`hub-upload-badge ${activeTemplate?.uploadStatus === "synced" ? "is-synced" : "is-local"}`}>
                                    {activeTemplate?.uploadStatus === "synced" ? (
                                        <>
                                            <CheckCircle2 size={11} style={{ display: "inline-block", marginRight: "3px", verticalAlign: "middle" }} />
                                            Synced to GCS
                                        </>
                                    ) : (
                                        "Local Template"
                                    )}
                                </span>
                            </div>
                            <div className="hub-url-line">
                                <code>{activeTemplate?.gcsPath || activeTemplate?.filename || currentFilename}</code>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Ingestion Input Bar */}
            <div className="ingest-control-card">
                <div className="control-card-grid">
                    {/* File Drag/Select with GCS Child Folder Dropdown */}
                    <div className="control-col col-upload-main">
                        <div className="col-label-row">
                            <label className="col-label">Upload Local PDF & GCS Destination</label>
                            <button
                                type="button"
                                className="btn-gcs-settings-pill"
                                onClick={() => setIsGcsModalOpen(true)}
                                title="Configure Google Cloud credentials, IAM or check CLI options"
                            >
                                <Cloud size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                GCS Settings & IAM
                            </button>
                        </div>
                        <div className="upload-btn-wrap">
                            <input
                                type="file"
                                accept=".pdf,application/pdf"
                                onChange={handleFileUpload}
                                disabled={isAnalyzing}
                                id="analyze-file-input"
                                className="file-input-hidden"
                            />
                            <label htmlFor="analyze-file-input" className={`file-picker-btn ${isAnalyzing ? "btn-disabled" : ""}`}>
                                {isAnalyzing ? (
                                    <>
                                        <Loader2 size={13} className="animate-spin" style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                        Analyzing & Syncing...
                                    </>
                                ) : (
                                    <>
                                        <Upload size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                        Choose PDF File...
                                    </>
                                )}
                            </label>

                            {/* Dropdown beside button */}
                            <div className="gcs-folder-select-wrap">
                                <span className="folder-prefix-label" title="Target Child Folder in Google Cloud Storage templates directory">
                                    Folder:
                                </span>
                                <select
                                    id="gcs-category-dropdown"
                                    value={selectedCategory}
                                    onChange={(e) => setSelectedCategory(e.target.value)}
                                    className="gcs-category-select"
                                    title="Child folder under pdf-generator/templates/"
                                >
                                    {GCS_CATEGORY_OPTIONS.map((cat) => (
                                        <option key={cat} value={cat}>
                                            {cat}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <span className="file-current-name" title={currentFilename}>{currentFilename}</span>
                        </div>
                    </div>

                    {/* Google Cloud / URL Input */}
                    <div className="control-col">
                        <label className="col-label">Or Direct Cloud / Web URL</label>
                        <form onSubmit={handleCloudUrlIngest} className="url-input-form">
                            <input
                                type="url"
                                placeholder="https://storage.googleapis.com/.../form.pdf"
                                value={cloudUrl}
                                onChange={(e) => setCloudUrl(e.target.value)}
                                className="cloud-url-input"
                                disabled={isAnalyzing}
                            />
                            <button
                                type="submit"
                                className="btn-ingest-url"
                                disabled={isAnalyzing || !cloudUrl.trim()}
                            >
                                Ingest
                            </button>
                        </form>
                    </div>

                    {/* Quick Preset */}
                    <div className="control-col col-preset">
                        <label className="col-label">Default Preset</label>
                        <button
                            type="button"
                            className="btn-preset"
                            onClick={handleLoadDefault}
                            disabled={isAnalyzing}
                        >
                            Reset to NPA Credit Transfer
                        </button>
                    </div>
                </div>

                {/* Dedicated Google Cloud Storage Target Destination Bar */}
                <div className="gcs-destination-active-bar">
                    <div className="gcs-bar-left">
                        <div className="gcs-dest-headline">
                            <span className="gcs-cloud-tag">GCS Target</span>
                            <span className="gcs-path-text">
                                gs://<strong>{GCS_BUCKET}</strong>/{GCS_BASE_PATH}/<span className="gcs-active-cat">{selectedCategory}</span>/{currentFilename}
                            </span>
                        </div>
                        <div className="gcs-dest-sub-links">
                            <a
                                href={`https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}?pageState=(%22StorageObjectListTable%22:(%22f%22:%22%255B%255D%22))&forceOnBucketsSortingFiltering=true&project=${GCS_PROJECT_ID}`}
                                target="_blank"
                                rel="noreferrer"
                                className="gcs-link-console"
                            >
                                ↗ Google Cloud Console (Base Templates)
                            </a>
                            <span className="sep">•</span>
                            <a
                                href={`https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(selectedCategory)}?project=${GCS_PROJECT_ID}`}
                                target="_blank"
                                rel="noreferrer"
                                className="gcs-link-console"
                            >
                                ↗ Open /{selectedCategory} Folder
                            </a>
                            <span className="sep">•</span>
                            <a
                                href={`https://${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(selectedCategory)}/${encodeURIComponent(currentFilename)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="gcs-link-cdn"
                            >
                                ↗ Public CDN URL
                            </a>
                        </div>
                    </div>

                    <div className="gcs-bar-right">
                        {isUploadingToGcs ? (
                            <span className="gcs-uploading-pill">
                                <Loader2 size={11} className="animate-spin" style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                Syncing to GCS...
                            </span>
                        ) : gcsUploadResult?.success ? (
                            <span className="gcs-uploaded-pill">
                                <CheckCircle2 size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                Synced to Cloud Storage
                            </span>
                        ) : (
                            <div className="gcs-fallback-actions">
                                <button
                                    type="button"
                                    className="btn-copy-gcloud-sm"
                                    onClick={handleCopyGcloud}
                                    title="Copy gcloud storage cp CLI command"
                                >
                                    {copiedGcloud ? (
                                        <>
                                            <Check size={11} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                            Copied CLI
                                        </>
                                    ) : (
                                        <>
                                            <Copy size={11} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                            Copy gcloud Command
                                        </>
                                    )}
                                </button>
                                <button
                                    type="button"
                                    className="btn-creds-hint-sm"
                                    onClick={() => setIsGcsModalOpen(true)}
                                >
                                    Set Credentials
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {statusMsg && (
                    <div className="ingest-status-row">
                        <Info size={13} style={{ display: "inline-block", marginRight: "6px", verticalAlign: "middle", flexShrink: 0 }} />
                        <span>{statusMsg}</span>
                    </div>
                )}
            </div>

            {/* Stats Metrics Banner */}
            <div className="metrics-banner-grid">
                <div className="metric-box">
                    <span className="metric-label">Template File</span>
                    <strong className="metric-val filename-val" title={currentFilename}>
                        {currentFilename}
                    </strong>
                    <span className="metric-sub">Layer 1 & Layer 2 Synced</span>
                </div>

                <div className="metric-box">
                    <span className="metric-label">Total Pages</span>
                    <strong className="metric-val">
                        {currentAnalysis?.technical?.pages || 0}
                    </strong>
                    <span className="metric-sub">Document length</span>
                </div>

                <div className="metric-box">
                    <span className="metric-label">AcroForm Status</span>
                    <strong className={`metric-val ${currentAnalysis?.technical?.hasAcroForm ? "val-success" : "val-warning"}`}>
                        {currentAnalysis?.technical?.hasAcroForm ? "Detected (Yes)" : "None"}
                    </strong>
                    <span className="metric-sub">Fillable form dictionary</span>
                </div>

                <div className="metric-box">
                    <span className="metric-label">Fillable Fields</span>
                    <strong className="metric-val val-fields">
                        {currentAnalysis?.technical?.fieldCount || 0}
                    </strong>
                    <span className="metric-sub">Interactive widgets</span>
                </div>
            </div>

            {/* Main Tabs Navigation */}
            <div className="inspection-tabs-bar">
                <div className="tabs-left">
                    <button
                        type="button"
                        className={`inspection-tab ${activeTab === "fields" ? "is-active" : ""}`}
                        onClick={() => setActiveTab("fields")}
                    >
                        <Layers size={13} style={{ display: "inline-block", marginRight: "6px", verticalAlign: "middle" }} />
                        Layer 1: Technical Fields ({technicalFields.length})
                    </button>
                    <button
                        type="button"
                        className={`inspection-tab ${activeTab === "context" ? "is-active" : ""}`}
                        onClick={() => setActiveTab("context")}
                    >
                        <Scan size={13} style={{ display: "inline-block", marginRight: "6px", verticalAlign: "middle" }} />
                        Layer 2: Geometry & Context
                    </button>
                    <button
                        type="button"
                        className={`inspection-tab ${activeTab === "json" ? "is-active" : ""}`}
                        onClick={() => setActiveTab("json")}
                    >
                        <Code size={13} style={{ display: "inline-block", marginRight: "6px", verticalAlign: "middle" }} />
                        template-analysis.json
                    </button>
                </div>

                {activeTab === "fields" && (
                    <div className="tab-filter-wrap">
                        <input
                            type="text"
                            placeholder="Filter fields by name or type..."
                            value={fieldFilter}
                            onChange={(e) => setFieldFilter(e.target.value)}
                            className="field-filter-input"
                        />
                    </div>
                )}
            </div>

            {/* Tab Contents */}
            <div className="tab-body-card">
                {/* TAB 1: TECHNICAL FIELDS */}
                {activeTab === "fields" && (
                    <div className="fields-table-wrap">
                        <table className="fields-analysis-table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>PDF AcroForm Field Name</th>
                                    <th>Technical Type</th>
                                    <th>Associated Page</th>
                                    <th>Widget Coordinates [x, y, w, h]</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredFields.length > 0 ? (
                                    filteredFields.map((field, idx) => {
                                        // Find widget rect in context
                                        let pageFound = null;
                                        let widgetFound = null;
                                        for (const pg of currentAnalysis?.context?.pages || []) {
                                            const w = (pg.fields || []).find((f) => f.name === field.name);
                                            if (w) {
                                                pageFound = pg.page;
                                                widgetFound = w;
                                                break;
                                            }
                                        }

                                        return (
                                            <tr key={field.name + idx}>
                                                <td className="col-num">{idx + 1}</td>
                                                <td className="col-name">
                                                    <code>{field.name}</code>
                                                </td>
                                                <td className="col-type">
                                                    <span className={`type-badge ${field.type.toLowerCase()}`}>
                                                        {field.type}
                                                    </span>
                                                </td>
                                                <td className="col-page">
                                                    {pageFound ? `Page ${pageFound}` : "—"}
                                                </td>
                                                <td className="col-coords">
                                                    {widgetFound ? (
                                                        <code className="coords-code">
                                                            x:{Math.round(widgetFound.x)}, y:{Math.round(widgetFound.y)}, w:{Math.round(widgetFound.width)}, h:{Math.round(widgetFound.height)}
                                                        </code>
                                                    ) : (
                                                        <span className="coords-none">No display widget</span>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })
                                ) : (
                                    <tr>
                                        <td colSpan="5" className="table-empty">
                                            No fields match the current filter.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* TAB 2: GEOMETRY & CONTEXT */}
                {activeTab === "context" && (
                    <div className="context-view-wrap">
                        <div className="context-page-selector">
                            <span>Select Page to Inspect:</span>
                            <div className="page-pills">
                                {(currentAnalysis?.context?.pages || []).map((pg) => (
                                    <button
                                        key={pg.page}
                                        type="button"
                                        className={`page-pill ${pg.page === selectedPageNum ? "is-selected" : ""}`}
                                        onClick={() => setSelectedPageNum(pg.page)}
                                    >
                                        Page {pg.page} ({pg.fields?.length || 0} fields, {pg.text?.length || 0} text tokens)
                                    </button>
                                ))}
                            </div>
                        </div>

                        {activePageContext && (
                            <div className="page-details-grid">
                                <div className="page-meta-card">
                                    <h4>Page {activePageContext.page} Dimensions</h4>
                                    <p>Width: <strong>{activePageContext.size?.width}pt</strong> | Height: <strong>{activePageContext.size?.height}pt</strong></p>
                                    <h4>AcroForm Widgets ({activePageContext.fields?.length || 0})</h4>
                                    <div className="widgets-list-compact">
                                        {(activePageContext.fields || []).map((w, i) => (
                                            <div className="widget-compact-item" key={i}>
                                                <strong>{w.name}</strong>
                                                <span>[{Math.round(w.x)}, {Math.round(w.y)}, {Math.round(w.width)}×{Math.round(w.height)}]</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="page-text-card">
                                    <h4>Printed Text Tokens ({activePageContext.text?.length || 0})</h4>
                                    <p className="subnote">Tokens extracted by PDF.js for spatial label contextualization.</p>
                                    <div className="text-tokens-flow">
                                        {(activePageContext.text || []).slice(0, 80).map((t, idx) => (
                                            <span className="text-token-chip" key={idx} title={`x:${Math.round(t.x)} y:${Math.round(t.y)}`}>
                                                {t.text}
                                            </span>
                                        ))}
                                        {(activePageContext.text || []).length > 80 && (
                                            <span className="text-token-chip token-more">
                                                +{activePageContext.text.length - 80} more tokens
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* TAB 3: RAW JSON */}
                {activeTab === "json" && (
                    <div className="json-view-wrap">
                        <div className="json-toolbar">
                            <span>Ready to be saved as <code>template-analysis.json</code></span>
                            <div className="json-btns">
                                <button type="button" onClick={handleCopyJson}>
                                    {copiedJson ? (
                                        <>
                                            <Check size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                            Copied to Clipboard!
                                        </>
                                    ) : (
                                        <>
                                            <Copy size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                            Copy JSON
                                        </>
                                    )}
                                </button>
                                <button type="button" onClick={handleDownloadJson}>
                                    <Download size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                    Download JSON
                                </button>
                            </div>
                        </div>
                        <pre className="json-display">
                            {JSON.stringify(currentAnalysis, null, 2)}
                        </pre>
                    </div>
                )}
            </div>

            <GoogleCloudCredentialsModal
                isOpen={isGcsModalOpen}
                onClose={() => setIsGcsModalOpen(false)}
                selectedCategory={selectedCategory}
            />
        </div>
    );
}
