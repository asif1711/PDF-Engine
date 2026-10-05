import { useState, useEffect } from "react";
import { Cloud, X, Check, Zap, ExternalLink } from "lucide-react";
import {
    getGcsCredentials,
    saveGcsCredentials,
    GCS_BUCKET,
    GCS_PROJECT_ID,
    GCS_BASE_PATH,
    GCS_CATEGORY_OPTIONS,
} from "../connectionManager";
import "./GoogleCloudCredentialsModal.css";

export default function GoogleCloudCredentialsModal({ isOpen, onClose, selectedCategory = "AIBT" }) {
    const [creds, setCreds] = useState(() => getGcsCredentials());
    const [serverStatus, setServerStatus] = useState(null);
    const [testResult, setTestResult] = useState(null);
    const [isTesting, setIsTesting] = useState(false);
    const [copiedCli, setCopiedCli] = useState(false);
    const [activeTab, setActiveTab] = useState("setup"); // "setup" | "cli" | "guide"

    useEffect(() => {
        if (!isOpen) return;

        let isMounted = true;
        const fetchStatus = async () => {
            try {
                const res = await fetch("/api/gcs-status");
                if (res.ok && isMounted) {
                    const data = await res.json();
                    setServerStatus(data);
                }
            } catch (err) {
                console.warn("Could not check GCS status:", err);
            }
        };

        fetchStatus();
        return () => {
            isMounted = false;
        };
    }, [isOpen]);

    const handleSave = () => {
        saveGcsCredentials(creds);
        setTestResult({ ok: true, message: "Credentials saved to local storage." });
        setTimeout(() => setTestResult(null), 3000);
    };

    const handleClear = () => {
        const cleared = { accessToken: "", serviceAccountKey: "" };
        saveGcsCredentials(cleared);
        setCreds(cleared);
        setTestResult({ ok: true, message: "Credentials cleared." });
        setTimeout(() => setTestResult(null), 3000);
    };

    const handleTest = async () => {
        setIsTesting(true);
        setTestResult(null);
        try {
            // First save current inputs
            saveGcsCredentials(creds);

            const tokenOrKey = creds.accessToken || creds.serviceAccountKey || "";
            const headers = {};
            if (tokenOrKey) {
                headers["x-gcs-token"] = tokenOrKey;
            }

            // Test status
            const res = await fetch("/api/gcs-status", { headers });
            const data = await res.json();

            if (data.hasEnvCredentials || tokenOrKey) {
                setTestResult({
                    ok: true,
                    message: `Credentials active. Target bucket: ${GCS_BUCKET} (${GCS_PROJECT_ID}). Mode: ${data.credentialsType || "configured"}.`,
                });
            } else {
                setTestResult({
                    ok: false,
                    message: `Notice: No active Google credentials detected for bucket ${GCS_BUCKET}. Files will be cached locally with instant fallback until credentials are provided.`,
                });
            }
        } catch (err) {
            setTestResult({ ok: false, message: `Test failed: ${err.message}` });
        } finally {
            setIsTesting(false);
        }
    };

    const cliCommand = `gcloud storage cp "YOUR_TEMPLATE.pdf" "gs://${GCS_BUCKET}/${GCS_BASE_PATH}/${selectedCategory}/YOUR_TEMPLATE.pdf"`;

    const handleCopyCli = () => {
        navigator.clipboard.writeText(cliCommand);
        setCopiedCli(true);
        setTimeout(() => setCopiedCli(false), 2000);
    };

    if (!isOpen) return null;

    return (
        <div className="modal-backdrop">
            <div className="gcs-modal-card">
                <div className="gcs-modal-header">
                    <div className="gcs-modal-title-row">
                        <span className="gcs-icon-badge">
                            <Cloud size={18} color="#176b50" />
                        </span>
                        <div>
                            <h3>Google Cloud Storage Target & Credentials</h3>
                            <p className="gcs-modal-sub">
                                Target Bucket: <code>{GCS_BUCKET}</code> • Project: <code>{GCS_PROJECT_ID}</code>
                            </p>
                        </div>
                    </div>
                    <button type="button" className="btn-close-modal" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="gcs-modal-tabs">
                    <button
                        type="button"
                        className={`gcs-tab-btn ${activeTab === "setup" ? "active" : ""}`}
                        onClick={() => setActiveTab("setup")}
                    >
                        Credentials & Keys
                    </button>
                    <button
                        type="button"
                        className={`gcs-tab-btn ${activeTab === "cli" ? "active" : ""}`}
                        onClick={() => setActiveTab("cli")}
                    >
                        gcloud CLI Fallback
                    </button>
                    <button
                        type="button"
                        className={`gcs-tab-btn ${activeTab === "guide" ? "active" : ""}`}
                        onClick={() => setActiveTab("guide")}
                    >
                        Setup Guide & IAM
                    </button>
                </div>

                <div className="gcs-modal-body">
                    {/* Destination Banner */}
                    <div className="gcs-dest-banner">
                        <div className="gcs-dest-item">
                            <span className="dest-label">Destination GCS Path:</span>
                            <code className="dest-code">
                                gs://{GCS_BUCKET}/{GCS_BASE_PATH}/{selectedCategory}/[filename.pdf]
                            </code>
                        </div>
                        <div className="gcs-dest-item">
                            <span className="dest-label">Child Folder:</span>
                            <span className="dest-badge-cat">{selectedCategory}</span>
                            <span className="dest-options-hint">
                                Available: {GCS_CATEGORY_OPTIONS.join(", ")}
                            </span>
                        </div>
                        <div className="gcs-dest-link-row">
                            <a
                                 href={`https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(selectedCategory)}?project=${GCS_PROJECT_ID}`}
                                 target="_blank"
                                 rel="noreferrer"
                                 className="gcs-console-link"
                                 style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                            >
                                <ExternalLink size={13} /> Open {selectedCategory} Folder in Google Cloud Console
                            </a>
                        </div>
                    </div>

                    {activeTab === "setup" && (
                        <div className="gcs-tab-content">
                            <div className="gcs-form-group">
                                <label className="gcs-field-label">
                                    Option 1: Google Cloud Access Token (Bearer)
                                </label>
                                <p className="gcs-field-hint">
                                    Generate via terminal: <code>gcloud auth print-access-token</code>
                                </p>
                                <input
                                    type="password"
                                    className="gcs-text-input"
                                    placeholder="ya29.a0AfH6SM..."
                                    value={creds.accessToken}
                                    onChange={(e) => setCreds({ ...creds, accessToken: e.target.value })}
                                />
                            </div>

                            <div className="gcs-form-group">
                                <label className="gcs-field-label">
                                    Option 2: Service Account JSON Key
                                </label>
                                <p className="gcs-field-hint">
                                    Paste raw JSON key from Google Cloud Console (IAM & Admin → Service Accounts → Keys).
                                </p>
                                <textarea
                                    rows={4}
                                    className="gcs-textarea"
                                    placeholder='{ "type": "service_account", "project_id": "aibt-244204", ... }'
                                    value={creds.serviceAccountKey}
                                    onChange={(e) => setCreds({ ...creds, serviceAccountKey: e.target.value })}
                                />
                            </div>

                            <div className="gcs-env-note">
                                <strong>Server-side .env Option:</strong> You can also set{" "}
                                <code>GCS_ACCESS_TOKEN</code> or <code>GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json</code> in your <code>.env</code> file.
                                {serverStatus?.hasEnvCredentials && (
                                    <span className="env-badge-detected" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                        <Check size={12} /> Detected in Environment
                                    </span>
                                )}
                            </div>

                            {testResult && (
                                <div className={`gcs-test-alert ${testResult.ok ? "alert-success" : "alert-warning"}`}>
                                    {testResult.message}
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === "cli" && (
                        <div className="gcs-tab-content">
                            <p className="cli-desc">
                                If you prefer uploading directly via Google Cloud SDK CLI, run this command in your terminal where your PDF template is located:
                            </p>
                            <div className="cli-code-box">
                                <code>{cliCommand}</code>
                                <button type="button" className="btn-copy-cli" onClick={handleCopyCli}>
                                    {copiedCli ? "Copied" : "Copy Command"}
                                </button>
                            </div>
                            <p className="cli-desc" style={{ marginTop: "1rem" }}>
                                Legacy <code>gsutil</code> alternative:
                            </p>
                            <div className="cli-code-box">
                                <code>gsutil cp "YOUR_TEMPLATE.pdf" "gs://{GCS_BUCKET}/${GCS_BASE_PATH}/${selectedCategory}/"</code>
                            </div>
                        </div>
                    )}

                    {activeTab === "guide" && (
                        <div className="gcs-tab-content guide-content">
                            <h4>Google Cloud Storage Setup Requirements</h4>
                            <ol className="guide-steps">
                                <li>
                                    <strong>Project:</strong> Verify access to project <code>{GCS_PROJECT_ID}</code> in Google Cloud Console.
                                </li>
                                <li>
                                    <strong>Bucket:</strong> Ensure bucket <code>{GCS_BUCKET}</code> exists with folder <code>{GCS_BASE_PATH}</code>.
                                </li>
                                <li>
                                    <strong>Permissions:</strong> Grant the service account or user account the role{" "}
                                    <span className="role-tag">Storage Object Creator</span> (or <span className="role-tag">Storage Object Admin</span>).
                                </li>
                                <li>
                                    <strong>CORS (For direct in-browser access):</strong> If fetching directly from browser, enable CORS on bucket:
                                    <pre className="cors-code">{`[{"origin": ["*"], "responseHeader": ["Content-Type"], "method": ["GET", "PUT", "POST"], "maxAgeSeconds": 3600}]`}</pre>
                                </li>
                            </ol>
                        </div>
                    )}
                </div>

                <div className="gcs-modal-footer">
                    <div className="footer-left">
                        <button
                            type="button"
                            className="btn-test-gcs"
                            onClick={handleTest}
                            disabled={isTesting}
                            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                        >
                            <Zap size={13} />
                            {isTesting ? "Testing..." : "Test GCS Access"}
                        </button>
                        <button
                            type="button"
                            className="btn-clear-gcs"
                            onClick={handleClear}
                        >
                            Clear
                        </button>
                    </div>

                    <div className="footer-right">
                        <button type="button" className="btn-save-gcs" onClick={handleSave}>
                            Save Credentials
                        </button>
                        <button type="button" className="btn-close-gcs" onClick={onClose}>
                            Done
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
