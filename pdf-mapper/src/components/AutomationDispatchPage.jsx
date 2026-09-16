import { useState, useEffect, useRef } from "react";
import {
    Zap,
    RefreshCw,
    Info,
    Paperclip,
    CheckCircle2,
    Check,
    Send,
    Download,
    Eye,
    Loader2,
    Cpu
} from "lucide-react";
import { getAutomationSettings, saveAutomationSettings, fetchPdfBytes } from "../connectionManager";
import { fetchFormSubmissions } from "../submissionService";
import { generateFilledPdf } from "../pdfGenerator";
import { normalizeWpFormsUrl } from "../mappingUtils";
import "./AutomationDispatchPage.css";

function triggerDownload(pdfBytes, filename) {
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AutomationDispatchPage({
    forms,
    selectedForm,
    onSelectForm,
    pdfTemplates,
    activePdfTemplate,
    mappings,
    pdfTemplateUrl,
    wordpressFormsUrl,
    wordpressApiKey,
    onOpenTester,
}) {
    const [settings, setSettings] = useState(() => getAutomationSettings());
    const [submissions, setSubmissions] = useState([]);
    const [isLoadingSubmissions, setIsLoadingSubmissions] = useState(false);
    const [feedStatusMessage, setFeedStatusMessage] = useState("");
    const [generatingEntryId, setGeneratingEntryId] = useState(null);
    const [pushingEntryId, setPushingEntryId] = useState(null);
    const [pushedEntries, setPushedEntries] = useState(() => new Set());
    const [dispatchNotice, setDispatchNotice] = useState("");
    const processedIdsRef = useRef(new Set());

    // Fetch live submissions for the selected form
    const loadSubmissions = async (silent = false) => {
        if (!selectedForm) return [];
        if (!silent) setIsLoadingSubmissions(true);
        try {
            const res = await fetchFormSubmissions(
                selectedForm.id,
                wordpressFormsUrl,
                wordpressApiKey
            );
            const list = Array.isArray(res?.entries) ? res.entries : [];
            setSubmissions(list);
            if (res?.message && !silent) {
                setFeedStatusMessage(res.message);
            }
            return list;
        } catch (err) {
            console.warn("Could not fetch submissions for automation monitor:", err);
            if (!silent) {
                setSubmissions([]);
                setFeedStatusMessage(`Connection error: ${err.message}`);
            }
            return [];
        } finally {
            if (!silent) setIsLoadingSubmissions(false);
        }
    };

    useEffect(() => {
        let isCancelled = false;
        queueMicrotask(() => {
            if (!isCancelled) {
                loadSubmissions(false);
            }
        });
        return () => {
            isCancelled = true;
        };
    }, [selectedForm, wordpressFormsUrl, wordpressApiKey]);

    // Generate PDF bytes helper
    const buildPdfBytesForEntry = async (entry) => {
        const target = activePdfTemplate || pdfTemplateUrl;
        const result = await fetchPdfBytes(target);
        if (!result?.bytes) {
            throw new Error("Could not load template PDF bytes.");
        }

        return await generateFilledPdf({
            templateBytes: result.bytes,
            mappings,
            submission: entry,
            flatten: false,
            formsUrl: wordpressFormsUrl,
            apiKey: wordpressApiKey,
            attachUploadedFiles: true,
        });
    };

    // Instant PDF generation & download for a submission
    const handleGenerateSubmissionPdf = async (entry) => {
        setGeneratingEntryId(entry.id);
        setDispatchNotice(`Generating filled PDF for Entry #${entry.id}...`);
        try {
            const result = await buildPdfBytesForEntry(entry);
            const filename = `form-${selectedForm?.id || "1"}-entry-${entry.id}.pdf`;
            triggerDownload(result.pdfBytes, filename);
            setDispatchNotice(`Successfully generated and downloaded ${filename} (${result.filledCount} fields filled, ${result.attachedFiles?.length || 0} attachments embedded).`);
        } catch (err) {
            console.error("Manual generation failed:", err);
            setDispatchNotice(`Generation failed: ${err.message}`);
        } finally {
            setGeneratingEntryId(null);
        }
    };

    // Generate & Push directly to WordPress server (stores in wp-content/pdf-generator/generated/ & triggers email)
    const handleGenerateAndPushToWp = async (entry, sendNotification = true) => {
        setPushingEntryId(entry.id);
        setDispatchNotice(`Generating and transmitting filled PDF for Entry #${entry.id} to WordPress...`);
        try {
            const result = await buildPdfBytesForEntry(entry);
            const rawBase = normalizeWpFormsUrl(wordpressFormsUrl);
            const restBase = rawBase.replace(/\/forms\/?$/, "");
            const uploadUrl = `${restBase}/entries/${entry.id}/pdf?send_notification=${sendNotification ? "1" : "0"}`;

            const headers = {
                "Content-Type": "application/pdf",
                "ngrok-skip-browser-warning": "1",
            };
            if (wordpressApiKey) {
                headers["X-PDF-API-Key"] = wordpressApiKey;
            }

            let wpRes;
            const isMixedContent = typeof window !== "undefined" && window.location.protocol === "https:" && uploadUrl.startsWith("http:");
            if (isMixedContent) {
                let proxyUrl = `/api/wp-proxy?url=${encodeURIComponent(uploadUrl)}`;
                if (wordpressApiKey) proxyUrl += `&apiKey=${encodeURIComponent(wordpressApiKey)}`;
                wpRes = await fetch(proxyUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/pdf" },
                    body: result.pdfBytes,
                });
            } else {
                try {
                    wpRes = await fetch(uploadUrl, {
                        method: "POST",
                        headers,
                        body: result.pdfBytes,
                    });
                } catch {
                    // Fall back to server proxy in case of CORS restriction
                    let proxyUrl = `/api/wp-proxy?url=${encodeURIComponent(uploadUrl)}`;
                    if (wordpressApiKey) proxyUrl += `&apiKey=${encodeURIComponent(wordpressApiKey)}`;
                    wpRes = await fetch(proxyUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/pdf" },
                        body: result.pdfBytes,
                    });
                }
            }

            if (!wpRes.ok) {
                const text = await wpRes.text();
                throw new Error(`WordPress rejected upload (${wpRes.status}): ${text.substring(0, 150)}`);
            }

            const json = await wpRes.json();
            setPushedEntries((prev) => new Set([...prev, String(entry.id)]));
            processedIdsRef.current.add(String(entry.id));

            setDispatchNotice(
                `Stored on WordPress: ${json.filename || `entry-${entry.id}.pdf`} (${result.filledCount} fields filled). ${
                    json.notification_sent ? "Email notification with PDF attachment dispatched." : ""
                }`
            );
        } catch (err) {
            console.error("Push to WordPress failed:", err);
            setDispatchNotice(`Push to WordPress failed: ${err.message}`);
        } finally {
            setPushingEntryId(null);
        }
    };

    // Toggle automation for a specific form
    const handleToggleForm = (formId) => {
        const currentForms = settings.forms || {};
        const currentFormConfig = currentForms[formId] || {
            enabled: false,
            templateId: activePdfTemplate?.id || "default-npa",
            storagePath: "wp-content/pdf-generator/generated/",
            emailNotificationEnabled: true,
        };

        const updated = {
            ...settings,
            forms: {
                ...currentForms,
                [formId]: {
                    ...currentFormConfig,
                    enabled: !currentFormConfig.enabled,
                },
            },
        };

        setSettings(updated);
        saveAutomationSettings(updated);
        setDispatchNotice(`Automation for Form #${formId} is now ${!currentFormConfig.enabled ? "ENABLED" : "PAUSED"}.`);
        setTimeout(() => setDispatchNotice(""), 3000);
    };

    // Update assigned template for a form
    const handleAssignTemplate = (formId, templateId) => {
        const currentForms = settings.forms || {};
        const updated = {
            ...settings,
            forms: {
                ...currentForms,
                [formId]: {
                    ...(currentForms[formId] || {}),
                    templateId,
                },
            },
        };
        setSettings(updated);
        saveAutomationSettings(updated);
    };

    return (
        <div className="automation-page-container">
            {/* Header */}
            <div className="automation-header">
                <div>
                    <span className="section-kicker">Step 3 • Live Automation & Dispatch Monitor</span>
                    <h2>Automation, Storage & Email Notifications</h2>
                    <p>
                        Generate filled PDFs with your saved mapping for Gravity Forms submissions, store them directly on your WordPress server, and attach them to notification emails.
                    </p>
                </div>

                <div className="automation-header-actions" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <button
                        type="button"
                        className="btn-open-tester"
                        onClick={onOpenTester}
                    >
                        <Zap size={13} style={{ display: "inline-block", marginRight: "6px", verticalAlign: "middle" }} />
                        Launch Interactive PDF Tester
                    </button>
                </div>
            </div>

            {dispatchNotice && (
                <div className="dispatch-notice-banner">
                    <span className="notice-bullet">●</span>
                    <span>{dispatchNotice}</span>
                </div>
            )}

            {/* Matrix of Gravity Forms */}
            <div className="automation-matrix-card">
                <div className="matrix-card-header">
                    <h3>Form Generation Matrix</h3>
                    <p>Each form can be individually enabled/disabled for automated PDF generation.</p>
                </div>

                <div className="matrix-table-wrap">
                    <table className="matrix-table">
                        <thead>
                            <tr>
                                <th>Form ID</th>
                                <th>Form Title</th>
                                <th>Assigned PDF Template</th>
                                <th>Storage Location</th>
                                <th>Auto-Email Attachment</th>
                                <th>Status</th>
                                <th>Toggle</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(forms || []).map((form) => {
                                const formConf = (settings.forms || {})[form.id] || {
                                    enabled: form.id === "1",
                                    templateId: activePdfTemplate?.id || "default-npa",
                                    storagePath: "wp-content/pdf-generator/generated/",
                                    emailNotificationEnabled: true,
                                };
                                const isEnabled = !!formConf.enabled;

                                return (
                                    <tr key={form.id} className={isEnabled ? "row-enabled" : "row-disabled"}>
                                        <td className="col-form-id">
                                            <strong>#{form.id}</strong>
                                        </td>

                                        <td className="col-form-title">
                                            <button
                                                type="button"
                                                className="btn-link-form"
                                                onClick={() => onSelectForm?.(form)}
                                            >
                                                {form.title}
                                            </button>
                                        </td>

                                        <td className="col-template-select">
                                            <select
                                                value={formConf.templateId}
                                                onChange={(e) => handleAssignTemplate(form.id, e.target.value)}
                                                className="select-template-assigned"
                                            >
                                                {(pdfTemplates || []).map((tpl) => (
                                                    <option key={tpl.id} value={tpl.id}>
                                                        {tpl.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </td>

                                        <td className="col-storage">
                                            <code>wp-content/pdf-generator/generated/</code>
                                        </td>

                                        <td className="col-email">
                                            <span className="badge-email-active">
                                                <Check size={11} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                                gform_notification Filter
                                            </span>
                                        </td>

                                        <td className="col-status">
                                            {isEnabled ? (
                                                <span className="badge-status-active">● Active</span>
                                            ) : (
                                                <span className="badge-status-inactive">○ Paused</span>
                                            )}
                                        </td>

                                        <td className="col-action">
                                            <button
                                                type="button"
                                                className={isEnabled ? "btn-toggle-pause" : "btn-toggle-enable"}
                                                onClick={() => handleToggleForm(form.id)}
                                            >
                                                {isEnabled ? "Pause" : "Enable"}
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Live Submissions Dispatch Feed */}
            <div className="submissions-feed-card">
                <div className="feed-header">
                    <div>
                        <h3>
                            Live Submissions: {selectedForm?.title || "Form #1"}
                        </h3>
                        <p>
                            {isLoadingSubmissions
                                ? "Fetching real submissions from WordPress..."
                                : `Showing ${submissions.length} submission(s) from connected WordPress site.`}
                        </p>
                    </div>

                    <div className="feed-header-info">
                        <button
                            type="button"
                            onClick={() => loadSubmissions(false)}
                            style={{
                                background: "#f0f2f5",
                                border: "1px solid #ccc",
                                padding: "4px 10px",
                                borderRadius: "4px",
                                cursor: "pointer",
                                fontSize: "12px",
                                marginRight: "12px",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "5px",
                            }}
                        >
                            <RefreshCw size={12} className={isLoadingSubmissions ? "animate-spin" : ""} />
                            Refresh Feed
                        </button>
                        <span className="live-dot" />
                        <span>Connected to REST Submissions Feed</span>
                    </div>
                </div>

                {feedStatusMessage && (
                    <div style={{ padding: "8px 16px", background: "#f8f9fa", borderBottom: "1px solid #e2e8f0", fontSize: "13px", color: "#4a5568", display: "flex", alignItems: "center", gap: "6px" }}>
                        <Info size={13} style={{ flexShrink: 0 }} />
                        <span>{feedStatusMessage}</span>
                    </div>
                )}

                <div className="feed-table-wrap">
                    {submissions.length > 0 ? (
                        <table className="feed-table">
                            <thead>
                                <tr>
                                    <th>Entry ID</th>
                                    <th>Submitter Name</th>
                                    <th>Date Submitted</th>
                                    <th>Attachments</th>
                                    <th>PDF Status</th>
                                    <th>Dispatch & Storage Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {submissions.map((sub) => {
                                    const submitterName =
                                        sub.submitter_name ||
                                        (sub["1.3"] ? `${sub["1.3"]} ${sub["1.6"] || ""}`.trim() : "Applicant");
                                    const uploadCount = (sub._uploaded_files || []).length;
                                    const isGenerating = generatingEntryId === sub.id;
                                    const isPushing = pushingEntryId === sub.id;
                                    const isPushed = pushedEntries.has(String(sub.id));

                                    return (
                                        <tr key={sub.id}>
                                            <td className="col-sub-id">
                                                <strong>#{sub.id}</strong>
                                            </td>

                                            <td className="col-sub-name">
                                                <div className="submitter-cell">
                                                    <strong>{submitterName}</strong>
                                                    {sub["2"] && <span className="sub-email">{sub["2"]}</span>}
                                                </div>
                                            </td>

                                            <td className="col-sub-date">
                                                {sub.date_created || "Recent"}
                                            </td>

                                            <td className="col-sub-files">
                                                {uploadCount > 0 ? (
                                                    <span className="badge-files">
                                                        <Paperclip size={11} style={{ display: "inline-block", marginRight: "3px", verticalAlign: "middle" }} />
                                                        {uploadCount} file{uploadCount === 1 ? "" : "s"}
                                                    </span>
                                                ) : (
                                                    <span className="badge-no-files">0 files</span>
                                                )}
                                            </td>

                                            <td className="col-sub-status">
                                                {isPushed ? (
                                                    <span style={{ color: "#27ae60", fontWeight: "bold", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                                        <CheckCircle2 size={12} />
                                                        Stored &amp; Emailed
                                                    </span>
                                                ) : (
                                                    <span className="badge-status-ready">
                                                        <Check size={11} style={{ display: "inline-block", marginRight: "3px", verticalAlign: "middle" }} />
                                                        Ready to Generate
                                                    </span>
                                                )}
                                            </td>

                                            <td className="col-sub-actions" style={{ display: "flex", gap: "6px" }}>
                                                <button
                                                    type="button"
                                                    style={{
                                                        background: "#2980b9",
                                                        color: "#fff",
                                                        border: "none",
                                                        padding: "6px 12px",
                                                        borderRadius: "4px",
                                                        cursor: "pointer",
                                                        fontSize: "12px",
                                                        fontWeight: "600",
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: "5px",
                                                    }}
                                                    onClick={() => handleGenerateAndPushToWp(sub, true)}
                                                    disabled={isPushing || isGenerating}
                                                >
                                                    {isPushing ? (
                                                        <>
                                                            <Loader2 size={12} className="animate-spin" />
                                                            Pushing to WP...
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Send size={12} />
                                                            Push PDF to WP & Email
                                                        </>
                                                    )}
                                                </button>

                                                <button
                                                    type="button"
                                                    className="btn-feed-download"
                                                    onClick={() => handleGenerateSubmissionPdf(sub)}
                                                    disabled={isGenerating || isPushing}
                                                >
                                                    {isGenerating ? (
                                                        <>
                                                            <Loader2 size={12} className="animate-spin" style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                                            Generating...
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Download size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                                            Download
                                                        </>
                                                    )}
                                                </button>

                                                <button
                                                    type="button"
                                                    className="btn-feed-test"
                                                    onClick={onOpenTester}
                                                    title="Open live generation tester with this form"
                                                >
                                                    <Eye size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                                    Inspect
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    ) : (
                        <div className="feed-empty-state">
                            <p>
                                {isLoadingSubmissions
                                    ? "Fetching live submissions from WordPress..."
                                    : "No submissions recorded on this WordPress form yet. New submissions will appear here automatically."}
                            </p>
                        </div>
                    )}
                </div>
            </div>

            {/* Local PDF Server Guide */}
            <div style={{ background: "#f8f9fa", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "20px", marginTop: "24px" }}>
                <h3 style={{ margin: "0 0 10px 0", color: "#1e293b", display: "flex", alignItems: "center" }}>
                    <Cpu size={18} style={{ marginRight: "8px", color: "#176b50" }} />
                    Automated PDF Generation Pipeline
                </h3>
                <div style={{ background: "#fff", border: "1px solid #cbd5e1", borderRadius: "6px", padding: "16px" }}>
                    <h4 style={{ margin: "0 0 8px 0", color: "#1d4ed8" }}>Local Worker (Headless Automation)</h4>
                    <p style={{ fontSize: "13px", color: "#475569", margin: "0 0 10px 0", lineHeight: "1.5" }}>
                        Since your WordPress is running locally in LocalWP, run the standalone worker on your computer:
                    </p>
                    <pre style={{ background: "#f1f5f9", padding: "8px", borderRadius: "4px", fontSize: "12px", margin: "0 0 10px 0" }}>
                        node local-pdf-server.js
                    </pre>
                    <p style={{ fontSize: "12px", color: "#475569", margin: 0 }}>
                        Then in WordPress Admin (<strong>Tools &rarr; Gravity Forms Reader</strong>), set Webhook URL to: <code>http://127.0.0.1:4000/api/generate-pdf</code>. WordPress will generate and attach PDFs synchronously with 0ms latency.
                    </p>
                </div>
            </div>
        </div>
    );
}
