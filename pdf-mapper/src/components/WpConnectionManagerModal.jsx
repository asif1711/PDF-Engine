import { useState } from "react";
import { X, Plus, CheckCircle2, AlertCircle } from "lucide-react";
import {
    getWpConnections,
    saveWpConnection,
    deleteWpConnection,
    testWpConnection,
} from "../connectionManager";

export default function WpConnectionManagerModal({
    isOpen,
    onClose,
    activeConnId,
    onSelectConn,
    onConnectionsUpdated,
}) {
    const [connections, setConnections] = useState(() => getWpConnections());
    const [editingConn, setEditingConn] = useState(null);
    const [testResult, setTestResult] = useState(null);
    const [isTesting, setIsTesting] = useState(false);

    if (!isOpen) return null;

    const startAdd = () => {
        setEditingConn({
            id: "",
            name: "New WordPress Site",
            url: "https://your-domain.com/wp-json/pdf-generator/v1/forms",
            apiKey: "aso107mzNrZId001GebX6ew8",
            basicUser: "",
            basicPass: "",
        });
        setTestResult(null);
    };

    const handleSaveEditing = async () => {
        if (!editingConn.url) return;
        const saved = saveWpConnection(editingConn);
        setConnections(saved);
        onConnectionsUpdated(saved);
        if (editingConn.id) {
            onSelectConn(editingConn.id);
        }
        setEditingConn(null);
        setTestResult(null);
    };

    const handleDelete = (id) => {
        const updated = deleteWpConnection(id);
        setConnections(updated);
        onConnectionsUpdated(updated);
    };

    const handleRunTest = async (conn) => {
        setIsTesting(true);
        setTestResult(null);
        try {
            const res = await testWpConnection(conn);
            setTestResult(res);
        } finally {
            setIsTesting(false);
        }
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-sheet modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div>
                        <span className="section-kicker">Multi-Site Architecture</span>
                        <h2>WordPress & Gravity Forms Sources</h2>
                        <p>Configure multiple WordPress connections with custom REST URLs, API keys and LiveLink tunnels.</p>
                    </div>
                    <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    {/* List of existing connections */}
                    <div className="connections-table-wrap">
                        <div className="connections-table-header">
                            <h3>Configured WordPress Sites ({connections.length})</h3>
                            <button type="button" className="btn-primary-sm" onClick={startAdd} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                <Plus size={12} /> Add New Connection
                            </button>
                        </div>

                        <div className="conn-cards-grid">
                            {connections.map((conn) => {
                                const isActive = conn.id === activeConnId;
                                return (
                                    <div className={`conn-card ${isActive ? "is-active-card" : ""}`} key={conn.id}>
                                        <div className="conn-card-top">
                                            <div>
                                                <h4 className="conn-card-title">{conn.name}</h4>
                                                <code className="conn-card-url">{conn.url}</code>
                                            </div>
                                            {isActive && <span className="active-badge">Active</span>}
                                        </div>

                                        <div className="conn-card-meta">
                                            <span>API Key: <code>{conn.apiKey ? `${conn.apiKey.slice(0, 6)}…` : "(None)"}</code></span>
                                            {conn.basicUser && <span>Basic Auth: <code>{conn.basicUser}</code></span>}
                                        </div>

                                        <div className="conn-card-actions">
                                            {!isActive && (
                                                <button
                                                    type="button"
                                                    className="btn-select"
                                                    onClick={() => {
                                                        onSelectConn(conn.id);
                                                        onClose();
                                                    }}
                                                >
                                                    Select This Site
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                className="btn-test"
                                                onClick={() => handleRunTest(conn)}
                                                disabled={isTesting}
                                            >
                                                Test Link
                                            </button>
                                            <button
                                                type="button"
                                                className="btn-edit"
                                                onClick={() => {
                                                    setEditingConn(conn);
                                                    setTestResult(null);
                                                }}
                                            >
                                                Edit
                                            </button>
                                            {connections.length > 1 && (
                                                <button
                                                    type="button"
                                                    className="btn-delete"
                                                    onClick={() => handleDelete(conn.id)}
                                                >
                                                    Delete
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Test result banner if triggered from list */}
                    {testResult && !editingConn && (
                        <div className={`test-feedback-banner ${testResult.ok ? "is-success" : "is-error"}`} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                            {testResult.ok ? <CheckCircle2 size={16} color="#15803d" style={{ marginTop: 2, flexShrink: 0 }} /> : <AlertCircle size={16} color="#b91c1c" style={{ marginTop: 2, flexShrink: 0 }} />}
                            <div>
                                <strong>{testResult.ok ? "Connection Successful" : "Connection Error"}</strong>
                                <p style={{ margin: "4px 0 0" }}>{testResult.message}</p>
                            </div>
                        </div>
                    )}

                    {/* Form for adding/editing a connection */}
                    {editingConn && (
                        <div className="edit-conn-panel">
                            <div className="edit-conn-header">
                                <h3>{editingConn.id ? "Edit Connection" : "Add New WordPress Site"}</h3>
                                <button type="button" className="text-btn" onClick={() => setEditingConn(null)}>Cancel</button>
                            </div>

                            <div className="edit-conn-fields">
                                <label>
                                    Friendly Connection Name
                                    <input
                                        type="text"
                                        value={editingConn.name}
                                        onChange={(e) => setEditingConn({ ...editingConn, name: e.target.value })}
                                        placeholder="e.g. Production WP or Staging"
                                    />
                                </label>

                                <label>
                                    Gravity Forms Reader REST Endpoint
                                    <input
                                        type="url"
                                        value={editingConn.url}
                                        onChange={(e) => setEditingConn({ ...editingConn, url: e.target.value })}
                                        placeholder="https://domain.com/wp-json/pdf-generator/v1/forms"
                                    />
                                    <small>Requires gravity-forms-reader.php plugin active on the WordPress site.</small>
                                </label>

                                <label>
                                    API Key (X-PDF-API-Key Header)
                                    <input
                                        type="text"
                                        value={editingConn.apiKey}
                                        onChange={(e) => setEditingConn({ ...editingConn, apiKey: e.target.value })}
                                        placeholder="aso107mzNrZId001GebX6ew8"
                                    />
                                </label>

                                <div className="edit-two-col">
                                    <label>
                                        HTTP Basic User (LocalWP LiveLink)
                                        <input
                                            type="text"
                                            value={editingConn.basicUser}
                                            onChange={(e) => setEditingConn({ ...editingConn, basicUser: e.target.value })}
                                            placeholder="Optional"
                                        />
                                    </label>
                                    <label>
                                        HTTP Basic Password
                                        <input
                                            type="password"
                                            value={editingConn.basicPass}
                                            onChange={(e) => setEditingConn({ ...editingConn, basicPass: e.target.value })}
                                            placeholder="Optional"
                                        />
                                    </label>
                                </div>
                            </div>

                            {testResult && (
                                <div className={`test-feedback-banner ${testResult.ok ? "is-success" : "is-error"}`} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                                    {testResult.ok ? <CheckCircle2 size={16} color="#15803d" style={{ marginTop: 2, flexShrink: 0 }} /> : <AlertCircle size={16} color="#b91c1c" style={{ marginTop: 2, flexShrink: 0 }} />}
                                    <div>
                                        <strong>{testResult.ok ? "Connection Successful" : "Connection Failed"}</strong>
                                        <p style={{ margin: "4px 0 0" }}>{testResult.message}</p>
                                    </div>
                                </div>
                            )}

                            <div className="edit-conn-actions">
                                <button
                                    type="button"
                                    className="btn-test"
                                    onClick={() => handleRunTest(editingConn)}
                                    disabled={isTesting}
                                >
                                    {isTesting ? "Testing..." : "Test Connection"}
                                </button>
                                <button
                                    type="button"
                                    className="btn-primary-sm"
                                    onClick={handleSaveEditing}
                                    disabled={!editingConn.url}
                                >
                                    Save Connection
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
