import { useState } from "react";
import { X, CheckCircle2, AlertCircle } from "lucide-react";
import { saveWpConnection, testWpConnection } from "../connectionManager";

export default function WpSourceModal({
    isOpen,
    onClose,
    connection, // if null, mode is "add", else "edit"
    onSave,
}) {
    if (!isOpen) return null;

    return (
        <WpSourceModalDialog
            key={connection?.id || "add-new"}
            connection={connection}
            onClose={onClose}
            onSave={onSave}
        />
    );
}

function WpSourceModalDialog({ connection, onClose, onSave }) {
    const isEdit = Boolean(connection && connection.id);
    const [name, setName] = useState(connection?.name || (isEdit ? "" : "New WordPress Source"));
    const [url, setUrl] = useState(connection?.url || (isEdit ? "" : "https://your-domain.com/wp-json/pdf-generator/v1/forms"));
    const [apiKey, setApiKey] = useState(connection?.apiKey || "aso107mzNrZId001GebX6ew8");
    const [basicUser, setBasicUser] = useState(connection?.basicUser || "");
    const [basicPass, setBasicPass] = useState(connection?.basicPass || "");
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);

    const handleTest = async () => {
        if (!url.trim()) return;
        setIsTesting(true);
        setTestResult(null);
        try {
            const res = await testWpConnection({
                url: url.trim(),
                apiKey: apiKey.trim(),
                basicUser: basicUser.trim(),
                basicPass: basicPass.trim(),
            });
            setTestResult(res);
        } catch (err) {
            setTestResult({ ok: false, message: err.message });
        } finally {
            setIsTesting(false);
        }
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!url.trim()) return;

        const payload = {
            id: connection?.id || `wp-conn-${Date.now()}`,
            name: name.trim() || "WordPress Source",
            url: url.trim(),
            apiKey: apiKey.trim(),
            basicUser: basicUser.trim(),
            basicPass: basicPass.trim(),
        };

        const updatedList = saveWpConnection(payload);
        if (onSave) onSave(payload, updatedList);
        onClose();
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
                <div className="modal-header">
                    <div>
                        <span className="section-kicker">Gravity Form Source</span>
                        <h2>{isEdit ? "Edit Gravity Form Source" : "Add Gravity Form Source"}</h2>
                        <p>{isEdit ? "Update connection details, API keys, or REST endpoints." : "Connect a new WordPress instance to read forms and entries."}</p>
                    </div>
                    <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="modal-body">
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        <div>
                            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#244038", marginBottom: 5 }}>
                                Source Name / Environment
                            </label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="e.g. Main Production Site, Staging WP"
                                required
                                style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 13 }}
                            />
                        </div>

                        <div>
                            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#244038", marginBottom: 5 }}>
                                WordPress REST Forms API Endpoint
                            </label>
                            <input
                                type="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://domain.com/wp-json/pdf-generator/v1/forms"
                                required
                                style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 12, fontFamily: "monospace" }}
                            />
                            <span style={{ fontSize: 11, color: "#64748b", marginTop: 4, display: "block" }}>
                                Served by <code>gravity-forms-reader.php</code> plugin.
                            </span>
                        </div>

                        <div>
                            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#244038", marginBottom: 5 }}>
                                API Key / Bearer Secret
                            </label>
                            <input
                                type="text"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="aso107mzNrZId001GebX6ew8"
                                style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 12, fontFamily: "monospace" }}
                            />
                        </div>

                        <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: 4, border: "1px solid #e2e8f0" }}>
                            <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 8, textTransform: "uppercase" }}>
                                Basic Auth (Optional for LiveLink / Staging Tunnels)
                            </span>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                                <div>
                                    <label style={{ display: "block", fontSize: 11, color: "#64748b", marginBottom: 3 }}>Username</label>
                                    <input
                                        type="text"
                                        value={basicUser}
                                        onChange={(e) => setBasicUser(e.target.value)}
                                        placeholder="Optional user"
                                        style={{ width: "100%", padding: "6px 10px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 12 }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: "block", fontSize: 11, color: "#64748b", marginBottom: 3 }}>Password</label>
                                    <input
                                        type="password"
                                        value={basicPass}
                                        onChange={(e) => setBasicPass(e.target.value)}
                                        placeholder="Optional pass"
                                        style={{ width: "100%", padding: "6px 10px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 12 }}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Test connection row */}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 4 }}>
                            <button
                                type="button"
                                onClick={handleTest}
                                disabled={isTesting || !url.trim()}
                                style={{ padding: "6px 12px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#334155" }}
                            >
                                {isTesting ? "Testing…" : "Test Connection"}
                            </button>

                            {testResult && (
                                <span style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 5,
                                    fontSize: 12,
                                    fontWeight: 600,
                                    color: testResult.ok ? "#166534" : "#dc2626"
                                }}>
                                    {testResult.ok ? (
                                        <>
                                            <CheckCircle2 size={14} />
                                            <span>Success ({testResult.formsCount ?? 0} forms detected)</span>
                                        </>
                                    ) : (
                                        <>
                                            <AlertCircle size={14} />
                                            <span>{testResult.message}</span>
                                        </>
                                    )}
                                </span>
                            )}
                        </div>
                    </div>

                    <div className="modal-footer" style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                        <button type="button" className="btn-secondary" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn-primary">
                            {isEdit ? "Save Changes" : "Connect Source"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
