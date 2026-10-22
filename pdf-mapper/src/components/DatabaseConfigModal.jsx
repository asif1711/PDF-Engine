import { Database, RefreshCw, X, CheckCircle2, AlertCircle } from "lucide-react";

export default function DatabaseConfigModal({
    isOpen,
    onClose,
    dbStatus,
    onCheckDb,
}) {
    if (!isOpen) return null;

    const isConnected = dbStatus?.status === "connected";
    const isChecking = dbStatus?.status === "checking";

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-sheet" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Database size={20} color="#176b50" />
                        <div>
                            <span className="section-kicker">Storage</span>
                            <h2>Database</h2>
                        </div>
                    </div>
                    <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "12px 16px",
                        background: isConnected ? "#f0fdf4" : isChecking ? "#fffbeb" : "#fef2f2",
                        border: `1px solid ${isConnected ? "#bbf7d0" : isChecking ? "#fde68a" : "#fecaca"}`,
                        borderRadius: 6,
                    }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {isConnected ? (
                                <CheckCircle2 size={16} color="#16a34a" />
                            ) : isChecking ? (
                                <RefreshCw size={16} className="animate-spin" color="#d97706" />
                            ) : (
                                <AlertCircle size={16} color="#dc2626" />
                            )}
                            <span style={{
                                fontWeight: 700,
                                fontSize: 13,
                                color: isConnected ? "#15803d" : isChecking ? "#b45309" : "#b91c1c",
                            }}>
                                {isChecking ? "Checking..." : isConnected ? "Connected" : "Disconnected"}
                            </span>
                        </div>

                        <button
                            type="button"
                            onClick={onCheckDb}
                            disabled={isChecking}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 5,
                                padding: "5px 12px",
                                fontSize: 12,
                                fontWeight: 600,
                                borderRadius: 4,
                                border: "1px solid #cbd5e1",
                                background: "#ffffff",
                                cursor: isChecking ? "not-allowed" : "pointer",
                            }}
                        >
                            <RefreshCw size={12} className={isChecking ? "animate-spin" : ""} />
                            Check Connection
                        </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 8, fontSize: 12 }}>
                        <span style={{ color: "#64748b", fontWeight: 600 }}>Type</span>
                        <span style={{ fontWeight: 600, color: "#1e293b" }}>PostgreSQL / Neon</span>
                        <span style={{ color: "#64748b", fontWeight: 600 }}>Status</span>
                        <span style={{ fontWeight: 600, color: isConnected ? "#16a34a" : isChecking ? "#d97706" : "#dc2626" }}>
                            {isChecking ? "Checking..." : isConnected ? "Connected" : "Disconnected"}
                        </span>
                    </div>

                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                        <button
                            type="button"
                            onClick={onClose}
                            style={{
                                padding: "6px 16px",
                                fontSize: 12,
                                fontWeight: 600,
                                borderRadius: 4,
                                border: "1px solid #cbd5e1",
                                background: "#f8fafc",
                                cursor: "pointer",
                            }}
                        >
                            Close
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
