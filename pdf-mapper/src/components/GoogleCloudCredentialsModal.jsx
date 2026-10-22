import { useState, useEffect, useMemo } from "react";
import { Cloud, X, Check, Zap, ExternalLink, ShieldCheck } from "lucide-react";
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

    const targetBucket = creds.bucket || GCS_BUCKET;
    const targetProjectId = creds.projectId || GCS_PROJECT_ID;

    // Detect and parse Service Account credentials JSON
    const parsedSa = useMemo(() => {
        if (!creds.serviceAccountKey) return null;
        try {
            const parsed = JSON.parse(creds.serviceAccountKey);
            if (parsed && typeof parsed === "object" && (parsed.client_email || parsed.type === "service_account")) {
                return parsed;
            }
        } catch {
            try {
                const b64 = atob(creds.serviceAccountKey.trim());
                const parsed = JSON.parse(b64);
                if (parsed && typeof parsed === "object" && (parsed.client_email || parsed.type === "service_account")) {
                    return parsed;
                }
            } catch (err) {
                // Ignore decoding error
                void err;
            }
        }
        return null;
    }, [creds.serviceAccountKey]);

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

    const handleServiceAccountChange = (val) => {
        const next = { ...creds, serviceAccountKey: val };
        try {
            const parsed = JSON.parse(val);
            if (parsed.project_id && (!creds.projectId || creds.projectId === GCS_PROJECT_ID)) {
                next.projectId = parsed.project_id;
            }
        } catch (err) {
            // Invalid JSON while typing is expected
            void err;
        }
        setCreds(next);
    };

    const handleSave = () => {
        const updated = saveGcsCredentials(creds);
        setTestResult({ ok: true, message: `Credentials saved! Connected to bucket: ${updated.bucket || GCS_BUCKET}` });
        setTimeout(() => setTestResult(null), 3500);
    };

    const handleClear = () => {
        const cleared = { accessToken: "", serviceAccountKey: "", bucket: GCS_BUCKET, projectId: GCS_PROJECT_ID };
        saveGcsCredentials(cleared);
        setCreds(cleared);
        setTestResult({ ok: true, message: "Credentials cleared. Reverted to default bucket." });
        setTimeout(() => setTestResult(null), 3000);
    };

    const handleTest = async () => {
        setIsTesting(true);
        setTestResult(null);
        try {
            saveGcsCredentials(creds);

            const res = await fetch("/api/gcs-validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    accessToken: creds.accessToken || "",
                    serviceAccountKey: creds.serviceAccountKey || "",
                    bucket: targetBucket,
                    projectId: targetProjectId,
                }),
            });
            const data = await res.json();

            if (data.ok) {
                setTestResult({
                    ok: true,
                    message: data.message || `Credentials active! Connected to Google Cloud Storage bucket ${targetBucket} (Project: ${targetProjectId}). Mode: ${data.credentialsType || "service_account"}.`,
                });
            } else {
                setTestResult({
                    ok: false,
                    message: data.message || `Notice: No active Google credentials detected for bucket ${targetBucket}. Files will be cached locally with instant fallback until credentials are provided.`,
                });
            }
        } catch (err) {
            setTestResult({ ok: false, message: `Test failed: ${err.message}` });
        } finally {
            setIsTesting(false);
        }
    };

    const cliCommand = `gcloud storage cp "YOUR_TEMPLATE.pdf" "gs://${targetBucket}/${GCS_BASE_PATH}/${selectedCategory}/YOUR_TEMPLATE.pdf"`;

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
                                Target Bucket: <code>{targetBucket}</code> • Project: <code>{targetProjectId}</code>
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
                            <span className="dest-label">Generated PDFs Storage Path:</span>
                            <code className="dest-code">
                                gs://{targetBucket}/pdf-generator/generated/[Filled_PDF.pdf]
                            </code>
                        </div>
                        <div className="gcs-dest-item">
                            <span className="dest-label">Template Storage:</span>
                            <span className="dest-badge-cat">{selectedCategory}</span>
                            <span className="dest-options-hint">
                                Available: {GCS_CATEGORY_OPTIONS.join(", ")}
                            </span>
                        </div>
                        <div className="gcs-dest-link-row">
                            <a
                                href={`https://console.cloud.google.com/storage/browser/${targetBucket}/pdf-generator/generated?project=${targetProjectId}`}
                                target="_blank"
                                rel="noreferrer"
                                className="gcs-console-link"
                                style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                            >
                                <ExternalLink size={13} /> Open Generated PDFs Folder in Google Cloud Console
                            </a>
                        </div>
                    </div>

                    {activeTab === "setup" && (
                        <div className="gcs-tab-content">
                            {/* Bucket & Project Configuration */}
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
                                <div className="gcs-form-group">
                                    <label className="gcs-field-label">Target Bucket Name</label>
                                    <input
                                        type="text"
                                        className="gcs-text-input"
                                        placeholder="cdn.vconsultancy.com.au"
                                        value={creds.bucket || ""}
                                        onChange={(e) => setCreds({ ...creds, bucket: e.target.value })}
                                    />
                                </div>
                                <div className="gcs-form-group">
                                    <label className="gcs-field-label">Google Cloud Project ID</label>
                                    <input
                                        type="text"
                                        className="gcs-text-input"
                                        placeholder="aibt-244204"
                                        value={creds.projectId || ""}
                                        onChange={(e) => setCreds({ ...creds, projectId: e.target.value })}
                                    />
                                </div>
                            </div>

                            {/* Service Account JSON Key (Recommended) */}
                            <div className="gcs-form-group">
                                <label className="gcs-field-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span>Option 1: Service Account JSON Key (Recommended)</span>
                                    {parsedSa && (
                                        <span style={{ color: "#166534", fontSize: "11px", fontWeight: "700", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                            <ShieldCheck size={13} /> Valid Service Account Key
                                        </span>
                                    )}
                                </label>
                                <p className="gcs-field-hint">
                                    Paste the JSON key file downloaded from Google Cloud IAM (IAM &amp; Admin &rarr; Service Accounts &rarr; Keys).
                                </p>
                                <textarea
                                    rows={5}
                                    className="gcs-textarea"
                                    placeholder='{ "type": "service_account", "project_id": "your-project-id", "private_key_id": "...", "client_email": "name@your-project-id.iam.gserviceaccount.com", ... }'
                                    value={creds.serviceAccountKey || ""}
                                    onChange={(e) => handleServiceAccountChange(e.target.value)}
                                    style={{ fontFamily: "monospace", fontSize: "11.5px" }}
                                />
                                {parsedSa && (
                                    <div style={{ marginTop: "6px", padding: "6px 10px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "4px", fontSize: "11.5px", color: "#166534" }}>
                                        <div><strong>Client Email:</strong> {parsedSa.client_email}</div>
                                        <div><strong>Project:</strong> {parsedSa.project_id}</div>
                                    </div>
                                )}
                            </div>

                            {/* Option 2: Bearer Access Token */}
                            <div className="gcs-form-group" style={{ marginTop: "12px" }}>
                                <label className="gcs-field-label">
                                    Option 2: Temporary Access Token (Bearer)
                                </label>
                                <p className="gcs-field-hint">
                                    Or paste an OAuth token from terminal: <code>gcloud auth print-access-token</code>
                                </p>
                                <input
                                    type="password"
                                    className="gcs-text-input"
                                    placeholder="ya29.a0AfH6SM..."
                                    value={creds.accessToken || ""}
                                    onChange={(e) => setCreds({ ...creds, accessToken: e.target.value })}
                                />
                            </div>

                            <div className="gcs-env-note">
                                <strong>Environment Alternative:</strong> You can also set{" "}
                                <code>GCS_SERVICE_ACCOUNT_KEY</code>, <code>GOOGLE_APPLICATION_CREDENTIALS</code>, or <code>GCS_ACCESS_TOKEN</code> in your server environment.
                                {serverStatus?.hasEnvCredentials && (
                                    <span className="env-badge-detected" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                        <Check size={12} /> Detected on Server
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
                                <code>gsutil cp "YOUR_TEMPLATE.pdf" "gs://{targetBucket}/${GCS_BASE_PATH}/${selectedCategory}/"</code>
                            </div>
                        </div>
                    )}

                    {activeTab === "guide" && (
                        <div className="gcs-tab-content guide-content">
                            <h4>Google Cloud Storage Setup Requirements</h4>
                            <ol className="guide-steps">
                                <li>
                                    <strong>Project:</strong> Verify access to project <code>{targetProjectId}</code> in Google Cloud Console.
                                </li>
                                <li>
                                    <strong>Bucket:</strong> Ensure bucket <code>{targetBucket}</code> exists with folder <code>pdf-generator/generated/</code>.
                                </li>
                                <li>
                                    <strong>Permissions:</strong> Grant the service account the role{" "}
                                    <span className="role-tag">Storage Object Creator</span> or <span className="role-tag">Storage Object Admin</span>.
                                </li>
                                <li>
                                    <strong>Automated Workflow:</strong> When you generate a PDF, clicking <strong>"Store in Cloud"</strong> or running dispatch uploads the file to <code>gs://{targetBucket}/pdf-generator/generated/</code> and logs the public &amp; console URLs.
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
                            {isTesting ? "Testing..." : "Test Connection & Credentials"}
                        </button>
                        <button
                            type="button"
                            className="btn-clear-gcs"
                            onClick={handleClear}
                        >
                            Reset
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
