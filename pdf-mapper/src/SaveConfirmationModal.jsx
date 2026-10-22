import { useEffect, useState } from "react";
import { X, Zap, FileEdit, FolderArchive, Copy, Check, Download } from "lucide-react";
import "./SaveConfirmationModal.css";

export default function SaveConfirmationModal({ isOpen, onClose, info, onTestPdf }) {
    const [showJsonPreview, setShowJsonPreview] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!isOpen) return undefined;
        function handleKeyDown(e) {
            if (e.key === "Escape") {
                onClose();
            }
        }
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen || !info) return null;

    function handleDownloadJson() {
        const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(info.payload, null, 2))}`;
        const downloadAnchor = document.createElement("a");
        downloadAnchor.setAttribute("href", jsonString);
        downloadAnchor.setAttribute("download", `form-${info.formId}_${info.templateId}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
    }

    function handleCopyJson() {
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(JSON.stringify(info.payload, null, 2)).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }

    return (
        <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="saved-modal-title"
            onClick={onClose}
        >
            <div
                className="modal-container"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header">
                    <div className="modal-header-text">
                        <div className="modal-success-badge" aria-hidden="true">
                            <svg viewBox="0 0 20 20" fill="currentColor">
                                <path
                                    fillRule="evenodd"
                                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                    clipRule="evenodd"
                                />
                            </svg>
                        </div>
                        <div>
                            <span className="modal-kicker">Saved to Database · Form & Template Pairing</span>
                            <h2 id="saved-modal-title">Mapping Successfully Saved</h2>
                        </div>
                    </div>
                    <button
                        type="button"
                        className="modal-close-btn"
                        onClick={onClose}
                        aria-label="Close modal"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    <div className="modal-summary-card">
                        <div className="pairing-details-grid">
                            <div className="pairing-item">
                                <span className="pairing-label">Gravity Form</span>
                                <span className="pairing-value">{info.formTitle}</span>
                                <span className="pairing-id">Form ID: {info.formId}</span>
                            </div>
                            <div className="pairing-item">
                                <span className="pairing-label">PDF Template</span>
                                <span className="pairing-value">{info.templateFilename}</span>
                                <span className="pairing-id">Template ID: {info.templateId}</span>
                            </div>
                        </div>

                        <div className="storage-file-info">
                            <span className="pairing-label">Database Record &amp; Storage Target</span>
                            <div className="storage-path-box">
                                <span>Table: form_mappings (Form #{info.formId} ➔ {info.templateId})</span>
                                <span className="storage-path-badge">PostgreSQL</span>
                            </div>
                        </div>
                    </div>

                    <div className="lifecycle-section">
                        <span className="lifecycle-title">How this saved pairing is used:</span>
                        <ul className="lifecycle-list">
                            <li className="lifecycle-item">
                                <div className="lifecycle-icon" aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <Zap size={15} color="#176b50" />
                                </div>
                                <div className="lifecycle-item-text">
                                    <strong>PDF Generation Pipeline</strong>
                                    <span>
                                        When a user submits this Gravity Form, the backend queries the live PostgreSQL database to load mapping rules and populate the PDF AcroForm fields.
                                    </span>
                                </div>
                            </li>
                            <li className="lifecycle-item">
                                <div className="lifecycle-icon" aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <FileEdit size={15} color="#176b50" />
                                </div>
                                <div className="lifecycle-item-text">
                                    <strong>Mapping Editing &amp; Maintenance</strong>
                                    <span>
                                        Whenever you select this PDF template and Gravity Form pair, the live PostgreSQL database automatically reloads all field assignments so you can inspect, edit, or remove fields anytime.
                                    </span>
                                </div>
                            </li>
                            <li className="lifecycle-item">
                                <div className="lifecycle-icon" aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <FolderArchive size={15} color="#176b50" />
                                </div>
                                <div className="lifecycle-item-text">
                                    <strong>PostgreSQL Single Source of Truth</strong>
                                    <span>
                                        All persistent configurations and mappings are stored directly in PostgreSQL/Neon, ensuring data integrity without local JSON fallbacks.
                                    </span>
                                </div>
                            </li>
                        </ul>
                    </div>

                    <div className="json-preview-toggle">
                        <button
                            type="button"
                            className="toggle-button"
                            onClick={() => setShowJsonPreview((prev) => !prev)}
                        >
                            {showJsonPreview ? "Hide JSON Configuration" : "Preview Saved JSON Payload"}
                        </button>
                        {showJsonPreview && (
                            <pre className="modal-json-snippet">
                                {JSON.stringify(info.payload, null, 2)}
                            </pre>
                        )}
                    </div>
                </div>

                <div className="modal-footer">
                    <div className="modal-footer-stats">
                        <span>Status: <strong>{info.mappedCount} Mapped Field{info.mappedCount === 1 ? "" : "s"}</strong></span>
                    </div>
                    <div className="modal-footer-actions">
                        {onTestPdf && (
                            <button
                                type="button"
                                className="modal-action-btn modal-action-secondary"
                                style={{ background: "#eef7f3", color: "#176b50", borderColor: "#a9d5c5", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 5 }}
                                onClick={() => {
                                    onClose();
                                    onTestPdf();
                                }}
                            >
                                <Zap size={14} />
                                Test PDF Generation
                            </button>
                        )}
                        <button
                            type="button"
                            className="modal-action-btn modal-action-secondary"
                            onClick={handleCopyJson}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                        >
                            {copied ? <Check size={14} /> : <Copy size={14} />}
                            {copied ? "Copied!" : "Copy JSON"}
                        </button>
                        <button
                            type="button"
                            className="modal-action-btn modal-action-secondary"
                            onClick={handleDownloadJson}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                        >
                            <Download size={14} />
                            Download JSON File
                        </button>
                        <button
                            type="button"
                            className="modal-action-btn modal-action-primary"
                            onClick={onClose}
                        >
                            Done
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
