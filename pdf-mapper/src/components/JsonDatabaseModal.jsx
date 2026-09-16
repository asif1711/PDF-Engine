import { useState } from "react";
import { X, Plus, Check, Download, Upload, AlertCircle, CheckCircle2 } from "lucide-react";
import {
    getRegistryDatabase,
    saveRawRegistryDatabase,
} from "../connectionManager";

export default function JsonDatabaseModal({
    isOpen,
    onClose,
    onSaved,
}) {
    if (!isOpen) return null;

    return (
        <JsonDatabaseModalDialog
            onClose={onClose}
            onSaved={onSaved}
        />
    );
}

function JsonDatabaseModalDialog({ onClose, onSaved }) {
    const initialDb = getRegistryDatabase();
    const [jsonText, setJsonText] = useState(() => JSON.stringify(initialDb, null, 2));
    const [statusMsg, setStatusMsg] = useState({ type: "", text: "" });
    const [isSaving, setIsSaving] = useState(false);

    const handleFormat = () => {
        try {
            const parsed = JSON.parse(jsonText);
            setJsonText(JSON.stringify(parsed, null, 2));
            setStatusMsg({ type: "success", text: "JSON formatted and validated successfully." });
        } catch (err) {
            setStatusMsg({ type: "error", text: `Syntax error: ${err.message}` });
        }
    };

    const handleAddSampleWpSource = () => {
        try {
            const parsed = JSON.parse(jsonText);
            const newSource = {
                id: `wp-source-${Date.now()}`,
                name: "New WordPress Gravity Form Source",
                type: "wordpress_gravity_forms",
                url: "https://your-domain.com/wp-json/pdf-generator/v1/forms",
                apiKey: "your-api-key-here",
                basicUser: "",
                basicPass: "",
                notes: "Connected WordPress instance with gravity-forms-reader.php",
                isDefault: false,
            };
            parsed.gravityFormSources = parsed.gravityFormSources || [];
            parsed.gravityFormSources.push(newSource);
            setJsonText(JSON.stringify(parsed, null, 2));
            setStatusMsg({ type: "success", text: "Added sample WordPress source to JSON." });
        } catch (err) {
            setStatusMsg({ type: "error", text: `Cannot insert: invalid JSON syntax (${err.message})` });
        }
    };

    const handleAddSampleExternalSource = () => {
        try {
            const parsed = JSON.parse(jsonText);
            const newSource = {
                id: `external-source-${Date.now()}`,
                name: "External Forms REST API",
                type: "external_rest",
                url: "https://api.your-company.com/v1/forms",
                apiKey: "bearer-secret-token",
                basicUser: "",
                basicPass: "",
                notes: "External custom form service delivering form schema & entries",
                isDefault: false,
            };
            parsed.gravityFormSources = parsed.gravityFormSources || [];
            parsed.gravityFormSources.push(newSource);
            setJsonText(JSON.stringify(parsed, null, 2));
            setStatusMsg({ type: "success", text: "Added sample External REST source to JSON." });
        } catch (err) {
            setStatusMsg({ type: "error", text: `Cannot insert: invalid JSON syntax (${err.message})` });
        }
    };

    const handleAddSampleGcsTemplate = () => {
        try {
            const parsed = JSON.parse(jsonText);
            const newTpl = {
                id: `tpl-gcs-${Date.now()}`,
                name: "New Cloud Storage Template",
                filename: "Custom_Application_Form.pdf",
                category: "AIBT",
                sourceType: "google_cloud_storage",
                isBuiltin: false,
                url: "https://cdn.vconsultancy.com.au/pdf-generator/templates/AIBT/Custom_Application_Form.pdf",
                cdnUrl: "https://cdn.vconsultancy.com.au/pdf-generator/templates/AIBT/Custom_Application_Form.pdf",
                gcsUri: "gs://cdn.vconsultancy.com.au/pdf-generator/templates/AIBT/Custom_Application_Form.pdf",
                gcsPath: "pdf-generator/templates/AIBT/Custom_Application_Form.pdf",
                consoleUrl: "https://console.cloud.google.com/storage/browser/cdn.vconsultancy.com.au/pdf-generator/templates/AIBT?project=aibt-244204",
                notes: "Google Cloud Storage bucket PDF template target",
            };
            parsed.pdfTemplates = parsed.pdfTemplates || [];
            parsed.pdfTemplates.push(newTpl);
            setJsonText(JSON.stringify(parsed, null, 2));
            setStatusMsg({ type: "success", text: "Added sample Google Cloud Storage PDF template to JSON." });
        } catch (err) {
            setStatusMsg({ type: "error", text: `Cannot insert: invalid JSON syntax (${err.message})` });
        }
    };

    const handleDownload = () => {
        try {
            const blob = new Blob([jsonText], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "sources-and-templates.json";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setStatusMsg({ type: "success", text: "Downloaded sources-and-templates.json" });
        } catch (err) {
            setStatusMsg({ type: "error", text: `Download failed: ${err.message}` });
        }
    };

    const handleFileUpload = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const text = ev.target?.result;
                const parsed = JSON.parse(text);
                setJsonText(JSON.stringify(parsed, null, 2));
                setStatusMsg({ type: "success", text: `Successfully loaded "${file.name}". Click "Save Database" to apply.` });
            } catch (err) {
                setStatusMsg({ type: "error", text: `Failed to parse file as JSON: ${err.message}` });
            }
        };
        reader.readAsText(file);
    };

    const handleSave = async () => {
        setIsSaving(true);
        setStatusMsg({ type: "", text: "" });
        try {
            const parsed = JSON.parse(jsonText);
            await saveRawRegistryDatabase(parsed);
            setStatusMsg({ type: "success", text: "Saved successfully to sources-and-templates.json!" });
            if (onSaved) onSaved(parsed);
            setTimeout(() => {
                onClose();
            }, 500);
        } catch (err) {
            setStatusMsg({ type: "error", text: `Failed to save: ${err.message}` });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 880, width: "95vw" }}>
                <div className="modal-header">
                    <div>
                        <span className="section-kicker">Persistent JSON Database</span>
                        <h2>sources-and-templates.json Registry</h2>
                        <p>
                            Physical JSON file database for all Gravity Form sources and PDF template targets. You can add WordPress instances, external REST endpoints, and Google Cloud Storage PDF templates here.
                        </p>
                    </div>
                    <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {/* Toolbar */}
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, background: "#f8fafc", padding: "8px 12px", borderRadius: 4, border: "1px solid #e2e8f0" }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            <button
                                type="button"
                                onClick={handleAddSampleWpSource}
                                style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 11, fontWeight: 600, color: "#1e293b", cursor: "pointer" }}
                            >
                                <Plus size={12} /> Add WP Source
                            </button>
                            <button
                                type="button"
                                onClick={handleAddSampleExternalSource}
                                style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 11, fontWeight: 600, color: "#1e293b", cursor: "pointer" }}
                            >
                                <Plus size={12} /> Add External REST
                            </button>
                            <button
                                type="button"
                                onClick={handleAddSampleGcsTemplate}
                                style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 11, fontWeight: 600, color: "#1e293b", cursor: "pointer" }}
                            >
                                <Plus size={12} /> Add GCS Template
                            </button>
                            <button
                                type="button"
                                onClick={handleFormat}
                                style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 11, fontWeight: 600, color: "#2563eb", cursor: "pointer" }}
                            >
                                <Check size={12} /> Format & Validate
                            </button>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <button
                                type="button"
                                onClick={handleDownload}
                                style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 11, fontWeight: 600, color: "#475569", cursor: "pointer" }}
                            >
                                <Download size={12} /> Download JSON
                            </button>
                            <label style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 11, fontWeight: 600, color: "#475569", cursor: "pointer" }}>
                                <Upload size={12} /> Import JSON
                                <input
                                    type="file"
                                    accept=".json,application/json"
                                    onChange={handleFileUpload}
                                    style={{ display: "none" }}
                                />
                            </label>
                        </div>
                    </div>

                    {/* Status Alert */}
                    {statusMsg.text && (
                        <div style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "8px 12px",
                            borderRadius: 4,
                            fontSize: 12,
                            fontWeight: 600,
                            background: statusMsg.type === "error" ? "#fef2f2" : "#f0fdf4",
                            color: statusMsg.type === "error" ? "#b91c1c" : "#15803d",
                            border: `1px solid ${statusMsg.type === "error" ? "#fecaca" : "#bbf7d0"}`,
                        }}>
                            {statusMsg.type === "error" ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
                            <span>{statusMsg.text}</span>
                        </div>
                    )}

                    {/* JSON Code Area */}
                    <div>
                        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 4 }}>
                            FILE LOCATION: <code>/sources-and-templates.json</code>
                        </label>
                        <textarea
                            value={jsonText}
                            onChange={(e) => setJsonText(e.target.value)}
                            spellCheck={false}
                            rows={18}
                            style={{
                                width: "100%",
                                fontFamily: "monospace",
                                fontSize: 12,
                                lineHeight: 1.45,
                                padding: 12,
                                background: "#0f172a",
                                color: "#f8fafc",
                                border: "1px solid #334155",
                                borderRadius: 4,
                                resize: "vertical",
                            }}
                        />
                    </div>
                </div>

                <div className="modal-footer" style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 11, color: "#64748b" }}>
                        Changes will be written to <code>sources-and-templates.json</code> and instantly update the active registry.
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" className="btn-secondary" onClick={onClose} disabled={isSaving}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="btn-primary"
                            onClick={handleSave}
                            disabled={isSaving}
                        >
                            {isSaving ? "Saving JSON..." : "Save Database to JSON File"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
