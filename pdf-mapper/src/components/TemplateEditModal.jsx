import { useState } from "react";
import { X } from "lucide-react";
import { GCS_CATEGORY_OPTIONS, savePdfTemplate } from "../connectionManager";

export default function TemplateEditModal({
    isOpen,
    onClose,
    template,
    onSave,
}) {
    if (!isOpen || !template) return null;

    return (
        <TemplateEditModalDialog
            key={template.id}
            template={template}
            onClose={onClose}
            onSave={onSave}
        />
    );
}

function TemplateEditModalDialog({ template, onClose, onSave }) {
    const [name, setName] = useState(template.name || template.filename || "");
    const [category, setCategory] = useState(template.category || "NPA");
    const [notes, setNotes] = useState(template.notes || "");
    const [cdnUrl, setCdnUrl] = useState(template.cdnUrl || template.url || "");

    const handleSubmit = (e) => {
        e.preventDefault();
        const updated = {
            ...template,
            name: name.trim() || template.filename || "Untitled Template",
            category: category || "Others",
            notes: notes.trim(),
            cdnUrl: cdnUrl.trim(),
        };
        savePdfTemplate(updated);
        if (onSave) onSave(updated);
        onClose();
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
                <div className="modal-header">
                    <div>
                        <span className="section-kicker">PDF Template Target</span>
                        <h2>Edit PDF Template</h2>
                        <p>Modify template display name, department category, or cloud storage destination.</p>
                    </div>
                    <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="modal-body">
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        <div>
                            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#244038", marginBottom: 5 }}>
                                Template Display Name
                            </label>
                            <input
                                type="text"
                                className="modal-text-input"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="e.g. NPA Credit Transfer Form V2.1"
                                required
                                style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 13 }}
                            />
                        </div>

                        <div>
                            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#244038", marginBottom: 5 }}>
                                Brand / Department Category
                            </label>
                            <select
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 13, background: "#fff" }}
                            >
                                {GCS_CATEGORY_OPTIONS.map((cat) => (
                                    <option key={cat} value={cat}>{cat}</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#244038", marginBottom: 5 }}>
                                Original Filename
                            </label>
                            <input
                                type="text"
                                value={template.filename || "template.pdf"}
                                disabled
                                style={{ width: "100%", padding: "8px 12px", border: "1px solid #e2e8f0", borderRadius: 4, fontSize: 12, background: "#f1f5f9", color: "#64748b" }}
                            />
                        </div>

                        <div>
                            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#244038", marginBottom: 5 }}>
                                Cloud / CDN URL
                            </label>
                            <input
                                type="text"
                                value={cdnUrl}
                                onChange={(e) => setCdnUrl(e.target.value)}
                                placeholder="https://cdn.vconsultancy.com.au/..."
                                style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 12 }}
                            />
                        </div>

                        <div>
                            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#244038", marginBottom: 5 }}>
                                Notes / Version Info
                            </label>
                            <textarea
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                placeholder="Optional description, revision date, or notes..."
                                rows={3}
                                style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 13, resize: "vertical" }}
                            />
                        </div>

                        <div style={{ background: "#f8fafc", padding: "10px 14px", borderRadius: 4, fontSize: 12, color: "#475569" }}>
                            <strong>Template Specs:</strong> {template.analysis?.technical?.pages || 0} page(s) • {template.analysis?.technical?.fieldCount || 0} AcroForm fields
                        </div>
                    </div>

                    <div className="modal-footer" style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                        <button type="button" className="btn-secondary" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn-primary">
                            Save Changes
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
