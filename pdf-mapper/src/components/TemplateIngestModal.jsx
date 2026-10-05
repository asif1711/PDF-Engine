import { useState } from "react";
import { X, Cloud, FolderOpen, FileText, CheckCircle2, AlertCircle } from "lucide-react";
import { ingestPdfFromUrl, savePdfTemplate } from "../connectionManager";
import { analyzePdfBytes } from "../templateAnalyzer";

export default function TemplateIngestModal({
    isOpen,
    onClose,
    onTemplateAdded,
}) {
    const [mode, setMode] = useState("url"); // "url" or "file"
    const [pdfUrl, setPdfUrl] = useState("");
    const [customName, setCustomName] = useState("");
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [feedback, setFeedback] = useState(null);

    if (!isOpen) return null;

    const handleIngestUrl = async (e) => {
        e.preventDefault();
        if (!pdfUrl.trim()) return;

        setIsAnalyzing(true);
        setFeedback(null);
        try {
            const template = await ingestPdfFromUrl(pdfUrl.trim(), customName.trim());
            setFeedback({
                ok: true,
                message: `Successfully ingested "${template.filename}"! Analyzed ${template.analysis.technical.pages} page(s) and detected ${template.analysis.technical.fieldCount} AcroForm fields.`,
            });
            onTemplateAdded(template);
            setTimeout(() => {
                onClose();
            }, 1200);
        } catch (err) {
            setFeedback({
                ok: false,
                message: `Failed to ingest PDF: ${err.message}`,
            });
        } finally {
            setIsAnalyzing(false);
        }
    };

    const handleFileUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsAnalyzing(true);
        setFeedback(null);
        try {
            const arrayBuffer = await file.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            const filename = customName.trim() || file.name;
            const analysis = await analyzePdfBytes(bytes, filename);

            const blob = new Blob([bytes], { type: "application/pdf" });
            const blobUrl = URL.createObjectURL(blob);

            const newTemplate = {
                id: `tpl-${Date.now()}`,
                name: filename,
                filename: filename,
                url: blobUrl,
                analysis,
                createdAt: new Date().toISOString(),
            };

            savePdfTemplate(newTemplate);
            setFeedback({
                ok: true,
                message: `Successfully ingested "${filename}"! Analyzed ${analysis.technical.pages} page(s) with ${analysis.technical.fieldCount} AcroForm fields.`,
            });
            onTemplateAdded(newTemplate);
            setTimeout(() => {
                onClose();
            }, 1200);
        } catch (err) {
            setFeedback({
                ok: false,
                message: `File analysis failed: ${err.message}`,
            });
        } finally {
            setIsAnalyzing(false);
        }
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div>
                        <span className="section-kicker">Template Management</span>
                        <h2>Ingest PDF Template</h2>
                        <p>Provide a Google Cloud Storage link, public URL, or upload a local fillable PDF.</p>
                    </div>
                    <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    <div className="ingest-tabs">
                        <button
                            type="button"
                            className={`ingest-tab ${mode === "url" ? "is-active" : ""}`}
                            onClick={() => setMode("url")}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                            <Cloud size={14} /> Google Cloud / Web URL
                        </button>
                        <button
                            type="button"
                            className={`ingest-tab ${mode === "file" ? "is-active" : ""}`}
                            onClick={() => setMode("file")}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                            <FolderOpen size={14} /> Local File Upload
                        </button>
                    </div>

                    {mode === "url" ? (
                        <form onSubmit={handleIngestUrl} className="ingest-form">
                            <label>
                                PDF File Name or Title
                                <input
                                    type="text"
                                    placeholder="e.g. Credit Transfer Application 2026.pdf"
                                    value={customName}
                                    onChange={(e) => setCustomName(e.target.value)}
                                />
                            </label>

                            <label>
                                Google Cloud Storage / Public PDF URL
                                <input
                                    type="url"
                                    placeholder="https://storage.googleapis.com/.../my-form.pdf"
                                    value={pdfUrl}
                                    onChange={(e) => setPdfUrl(e.target.value)}
                                    required
                                />
                                <small>Cross-origin requests are automatically proxied safely.</small>
                            </label>

                            <div className="ingest-actions">
                                <button
                                    type="submit"
                                    className="btn-primary"
                                    disabled={isAnalyzing || !pdfUrl.trim()}
                                >
                                    {isAnalyzing ? "Ingesting & Analyzing..." : "Check & Ingest PDF"}
                                </button>
                            </div>
                        </form>
                    ) : (
                        <div className="file-drop-area">
                            <label>
                                Template Display Name (Optional)
                                <input
                                    type="text"
                                    placeholder="e.g. Enrollment Form V2"
                                    value={customName}
                                    onChange={(e) => setCustomName(e.target.value)}
                                    style={{ marginBottom: "12px", width: "100%" }}
                                />
                            </label>

                            <div className="file-upload-box">
                                <span className="upload-icon">
                                    <FileText size={28} color="#176b50" />
                                </span>
                                <strong>Choose a fillable PDF from your computer</strong>
                                <p>Analyzes AcroForm fields and text geometry instantly.</p>
                                <input
                                    type="file"
                                    accept=".pdf,application/pdf"
                                    onChange={handleFileUpload}
                                    disabled={isAnalyzing}
                                />
                            </div>
                        </div>
                    )}

                    {feedback && (
                        <div className={`test-feedback-banner ${feedback.ok ? "is-success" : "is-error"}`} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                            {feedback.ok ? <CheckCircle2 size={16} color="#15803d" style={{ marginTop: 2, flexShrink: 0 }} /> : <AlertCircle size={16} color="#b91c1c" style={{ marginTop: 2, flexShrink: 0 }} />}
                            <div>
                                <strong>{feedback.ok ? "Ingestion Complete" : "Ingestion Failed"}</strong>
                                <p style={{ margin: "4px 0 0" }}>{feedback.message}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
