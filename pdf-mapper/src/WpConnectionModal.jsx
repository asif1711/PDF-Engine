import { useState } from "react";
import { X, AlertTriangle } from "lucide-react";
import "./WpConnectionModal.css";
import { normalizeWpFormsUrl } from "./mappingUtils";

export default function WpConnectionModal({
    isOpen,
    onClose,
    currentUrl,
    currentApiKey,
    onSaveAndFetch,
    syncInfo,
    isChecking,
}) {
    const [url, setUrl] = useState(() => {
        const stored = localStorage.getItem("pfgf_custom_forms_url");
        return stored ? normalizeWpFormsUrl(stored) : (currentUrl ? normalizeWpFormsUrl(currentUrl) : "");
    });
    const [apiKey, setApiKey] = useState(() => localStorage.getItem("pfgf_custom_api_key") || currentApiKey || "");
    const [basicUser, setBasicUser] = useState(() => localStorage.getItem("pfgf_livelink_user") || "");
    const [basicPass, setBasicPass] = useState(() => localStorage.getItem("pfgf_livelink_pass") || "");
    const [localMessage, setLocalMessage] = useState("");

    if (!isOpen) return null;

    function handleSave(e) {
        e.preventDefault();
        const trimmedUrl = normalizeWpFormsUrl(url.trim());
        const trimmedKey = apiKey.trim();
        const trimmedUser = basicUser.trim();
        const trimmedPass = basicPass.trim();

        setUrl(trimmedUrl);

        if (trimmedUrl) {
            localStorage.setItem("pfgf_custom_forms_url", trimmedUrl);
        } else {
            localStorage.removeItem("pfgf_custom_forms_url");
        }

        if (trimmedKey) {
            localStorage.setItem("pfgf_custom_api_key", trimmedKey);
        } else {
            localStorage.removeItem("pfgf_custom_api_key");
        }

        if (trimmedUser) {
            localStorage.setItem("pfgf_livelink_user", trimmedUser);
        } else {
            localStorage.removeItem("pfgf_livelink_user");
        }

        if (trimmedPass) {
            localStorage.setItem("pfgf_livelink_pass", trimmedPass);
        } else {
            localStorage.removeItem("pfgf_livelink_pass");
        }

        setLocalMessage("Connecting to WordPress...");
        onSaveAndFetch({
            url: trimmedUrl,
            apiKey: trimmedKey,
            basicUser: trimmedUser,
            basicPass: trimmedPass,
        });
    }

    const isHttpOnHttps = typeof window !== "undefined" && window.location.protocol === "https:" && url.startsWith("http://");

    return (
        <div className="wp-modal-overlay" onClick={onClose}>
            <div className="wp-modal-dialog" onClick={(e) => e.stopPropagation()}>
                <div className="wp-modal-header">
                    <div>
                        <span className="section-kicker">WordPress Live Integration</span>
                        <h2>Gravity Forms API Connection</h2>
                    </div>
                    <button type="button" className="wp-modal-close" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <form onSubmit={handleSave} className="wp-modal-body">
                    <p className="wp-modal-desc">
                        Configure the live connection to your WordPress site with <code>gravity-forms-reader.php</code> installed.
                        You can use <strong>ngrok</strong> (e.g. <code>https://xxxx.ngrok-free.app/wp-json/pdf-generator/v1/forms</code>) or <strong>LocalWP Live Link</strong> to pull live form schemas, labels, and entries over HTTPS.
                    </p>

                    {isHttpOnHttps && (
                        <div className="wp-modal-warning" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                            <AlertTriangle size={18} style={{ color: "#b45309", flexShrink: 0, marginTop: 2 }} />
                            <div>
                                <strong>Mixed Content Warning:</strong> You are viewing this application via HTTPS, but the current URL uses <code>http://</code>. Modern browsers block local <code>http://</code> requests from HTTPS pages.
                                <br />
                                <strong>Solution:</strong> Start an HTTPS tunnel using <strong>ngrok</strong> (<code>ngrok http 80 --host-header=dev-playground.local</code>) or LocalWP <strong>Live Link</strong>, then paste the <code>https://...</code> endpoint below.
                            </div>
                        </div>
                    )}

                    <label className="wp-modal-field">
                        <span>WordPress Forms REST Endpoint (HTTPS Tunnel / ngrok):</span>
                        <input
                            type="text"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://tenisha-shapelier-elijah.ngrok-free.dev/wp-json/pdf-generator/v1/forms"
                            required
                        />
                        <small>Enter the full endpoint or just your ngrok URL (e.g. <code>https://tenisha-shapelier-elijah.ngrok-free.dev</code>) — <code>/wp-json/pdf-generator/v1/forms</code> will be added automatically.</small>
                    </label>

                    <label className="wp-modal-field">
                        <span>X-PDF-API-Key:</span>
                        <input
                            type="text"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder="e.g. aso107mzNrZId001GebX6ew8"
                        />
                        <small>Defined in <code>wp-config.php</code> as <code>PFGF_API_KEY</code></small>
                    </label>

                    <div className="wp-modal-auth-box">
                        <div className="wp-auth-box-title">LocalWP Live Link HTTP Basic Auth (Optional)</div>
                        <p className="wp-auth-box-desc">If using LocalWP Live Link with username and password protection, enter them here:</p>
                        <div className="wp-auth-grid">
                            <label>
                                <span>Username</span>
                                <input
                                    type="text"
                                    value={basicUser}
                                    onChange={(e) => setBasicUser(e.target.value)}
                                    placeholder="LocalWP username"
                                    autoComplete="off"
                                />
                            </label>
                            <label>
                                <span>Password</span>
                                <input
                                    type="password"
                                    value={basicPass}
                                    onChange={(e) => setBasicPass(e.target.value)}
                                    placeholder="LocalWP password"
                                    autoComplete="off"
                                />
                            </label>
                        </div>
                    </div>

                    {(localMessage || syncInfo?.message) && (
                        <div className={`wp-status-box ${syncInfo?.isLive ? "success" : "notice"}`}>
                            <strong>Status:</strong> {syncInfo?.message || localMessage}
                        </div>
                    )}

                    <div className="wp-modal-actions">
                        <button type="button" className="quiet" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="primary wp-submit-btn" disabled={isChecking}>
                            {isChecking ? "Checking WP Site…" : "Save & Fetch Live Schema"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
