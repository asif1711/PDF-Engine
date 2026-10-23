import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
    Send,
    Mail,
    Trash2,
    Clock,
    CheckCircle2,
    AlertCircle,
    RefreshCw,
    Download,
    ExternalLink,
    FileText,
    Cloud,
    Globe,
    ShieldCheck,
    Info,
    Sparkles,
    Check,
    Loader2,
    Eye,
} from "lucide-react";
import {
    fetchPdfBytes,
    storePdfInCloud,
    pushPdfToWordPress,
    cleanupWpPdf,
    fetchWpDispatchLogs,
    clearWpDispatchLogs,
    fetchWpAutomationSettings,
    saveWpAutomationSettingsRemote,
    fetchGcsGeneratedPdfs,
    deleteGcsGeneratedPdf,
    GCS_BUCKET,
    GCS_PROJECT_ID,
    GCS_GENERATED_PATH,
} from "../connectionManager";
import { fetchFormSubmissions } from "../submissionService";
import { generateFilledPdf } from "../pdfGenerator";
import "./WordPressIntegrationPage.css";

export default function WordPressIntegrationPage({
    forms,
    selectedForm,
    onSelectForm,
    pdfTemplates,
    activePdfTemplate,
    mappings,
    pdfTemplateUrl,
    activeWpConn,
    wpConnections,
    sourceConnectionId,
}) {
    // Automated Send & Pipeline Settings
    const [isAutomationActive, setIsAutomationActive] = useState(false);
    const [cleanupDelaySeconds, setCleanupDelaySeconds] = useState(30);
    const [sendNotifications, setSendNotifications] = useState(true);
    const [pollIntervalSeconds, setPollIntervalSeconds] = useState(15);
    const [targetWpUrl, setTargetWpUrl] = useState(() => activeWpConn?.url || "");

    // Logs & Status
    const [logs, setLogs] = useState([]);
    const [isLoadingLogs, setIsLoadingLogs] = useState(false);
    const [autoRefreshLogs, setAutoRefreshLogs] = useState(true);
    const [notice, setNotice] = useState(null);

    // Manual Submissions List
    const [submissions, setSubmissions] = useState([]);
    const [isLoadingSubmissions, setIsLoadingSubmissions] = useState(false);
    const [searchEntryQuery, setSearchEntryQuery] = useState("");
    const [processingEntryId, setProcessingEntryId] = useState(null);
    const [cleaningEntryId, setCleaningEntryId] = useState(null);

    // Custom Entry Direct Dispatch
    const [customEntryId, setCustomEntryId] = useState("");

    // Google Cloud Storage Generated PDFs State
    const [gcsPdfs, setGcsPdfs] = useState([]);
    const [isLoadingGcsPdfs, setIsLoadingGcsPdfs] = useState(false);
    const [gcsPdfsSearch, setGcsPdfsSearch] = useState("");
    const [gcsPdfsInfo, setGcsPdfsInfo] = useState(null);
    const [pushingGcsFilename, setPushingGcsFilename] = useState(null);
    const [deletingGcsFilename, setDeletingGcsFilename] = useState(null);

    const loadGcsGeneratedPdfs = useCallback(async () => {
        setIsLoadingGcsPdfs(true);
        try {
            const data = await fetchGcsGeneratedPdfs();
            if (data?.items) {
                setGcsPdfs(data.items);
                setGcsPdfsInfo({
                    bucket: data.bucket || GCS_BUCKET,
                    folder: data.folder || GCS_GENERATED_PATH,
                    count: data.count || data.items.length,
                    consoleUrl: data.consoleUrl,
                    status: data.gcsStatus,
                });
            }
        } catch (err) {
            console.warn("Could not load GCS generated PDFs:", err);
        } finally {
            setIsLoadingGcsPdfs(false);
        }
    }, []);

    useEffect(() => {
        let isCancelled = false;
        queueMicrotask(() => {
            if (!isCancelled) {
                loadGcsGeneratedPdfs();
            }
        });
        return () => { isCancelled = true; };
    }, [loadGcsGeneratedPdfs]);

    const handlePushGcsPdfToWp = async (item) => {
        if (!item) return;
        const entryId = item.entryId || "1";
        const formId = item.formId || selectedForm?.id || "1";
        setPushingGcsFilename(item.filename);

        try {
            setNotice({ type: "info", text: `Pushing ${item.filename} (Entry #${entryId}) from GCP to WordPress...` });
            const result = await pushPdfToWordPress({
                formId,
                entryId,
                pdfUrl: item.publicUrl || item.localUrl,
                wordpressUrl: targetWpUrl,
                sourceConnectionId,
                sendNotification: sendNotifications,
                cleanAfterSend: true,
                deleteDelaySeconds: cleanupDelaySeconds,
                action: "manual_gcs_dispatch",
            });

            if (result.success) {
                setNotice({
                    type: "success",
                    text: `Success! ${item.filename} pushed to WordPress. ${result.notificationSent ? "Gravity Forms notification email sent with PDF attached!" : ""}`
                });
                loadLogs();
            } else {
                setNotice({
                    type: "error",
                    text: `WordPress push failed: ${result.error || "Unknown error"}`
                });
            }
        } catch (err) {
            setNotice({ type: "error", text: `Dispatch error: ${err.message}` });
        } finally {
            setPushingGcsFilename(null);
        }
    };

    const handleDeleteGcsPdf = async (item) => {
        if (!item || !window.confirm(`Delete ${item.filename} from Google Cloud Storage?`)) return;
        setDeletingGcsFilename(item.filename);
        try {
            const res = await deleteGcsGeneratedPdf(item.name, item.filename);
            if (res.success) {
                setNotice({ type: "success", text: `Deleted ${item.filename} successfully.` });
                loadGcsGeneratedPdfs();
            } else {
                setNotice({ type: "error", text: `Failed to delete ${item.filename}` });
            }
        } catch (err) {
            setNotice({ type: "error", text: `Delete error: ${err.message}` });
        } finally {
            setDeletingGcsFilename(null);
        }
    };

    // Filter GCS PDFs by search
    const filteredGcsPdfs = useMemo(() => {
        if (!gcsPdfsSearch.trim()) return gcsPdfs;
        const q = gcsPdfsSearch.toLowerCase();
        return gcsPdfs.filter((p) => p.filename.toLowerCase().includes(q) || String(p.entryId).includes(q));
    }, [gcsPdfs, gcsPdfsSearch]);

    // Tracking processed submissions during polling to avoid duplicate dispatches
    const processedSubmissionIdsRef = useRef(new Set());
    const isDispatchingRef = useRef(false);

    // Sync active target WP URL
    useEffect(() => {
        let isCancelled = false;
        queueMicrotask(() => {
            if (!isCancelled && activeWpConn?.url) {
                setTargetWpUrl(activeWpConn.url);
            }
        });
        return () => { isCancelled = true; };
    }, [activeWpConn]);

    // Load initial settings
    useEffect(() => {
        let mounted = true;
        fetchWpAutomationSettings().then((remote) => {
            if (mounted && remote) {
                if (typeof remote.enabled === "boolean") setIsAutomationActive(remote.enabled);
                if (typeof remote.deleteDelaySeconds === "number") setCleanupDelaySeconds(remote.deleteDelaySeconds);
                if (typeof remote.sendNotification === "boolean") setSendNotifications(remote.sendNotification);
                if (typeof remote.pollIntervalSeconds === "number") setPollIntervalSeconds(remote.pollIntervalSeconds);
            }
        });
        return () => { mounted = false; };
    }, []);

    // Load logs
    const loadLogs = useCallback(async () => {
        setIsLoadingLogs(true);
        try {
            const list = await fetchWpDispatchLogs(100);
            setLogs(list);
        } catch (err) {
            console.warn("Could not load dispatch logs:", err);
        } finally {
            setIsLoadingLogs(false);
        }
    }, []);

    useEffect(() => {
        let isCancelled = false;
        queueMicrotask(() => {
            if (!isCancelled) {
                loadLogs();
            }
        });
        if (!autoRefreshLogs) return () => { isCancelled = true; };
        const timer = setInterval(() => {
            if (!isCancelled) {
                loadLogs();
            }
        }, 6000);
        return () => {
            isCancelled = true;
            clearInterval(timer);
        };
    }, [autoRefreshLogs, loadLogs]);

    // Load submissions for the selected form
    const loadSubmissions = useCallback(async () => {
        if (!selectedForm) return;
        setIsLoadingSubmissions(true);
        try {
            const res = await fetchFormSubmissions(
                selectedForm.id,
                targetWpUrl,
                "",
                { basicAuthUser: "", basicAuthPass: "", sourceConnectionId }
            );
            const list = Array.isArray(res?.entries) ? res.entries : [];
            setSubmissions(list);
        } catch (err) {
            console.warn("Could not load form submissions:", err);
            setSubmissions([]);
        } finally {
            setIsLoadingSubmissions(false);
        }
    }, [selectedForm, targetWpUrl, sourceConnectionId]);

    useEffect(() => {
        let isCancelled = false;
        queueMicrotask(() => {
            if (!isCancelled) {
                loadSubmissions();
            }
        });
        return () => {
            isCancelled = true;
        };
    }, [loadSubmissions]);

    // Save automation settings
    const handleToggleAutomation = async () => {
        const nextState = !isAutomationActive;
        setIsAutomationActive(nextState);
        const payload = {
            enabled: nextState,
            formId: selectedForm?.id || "",
            sourceConnectionId: sourceConnectionId || "",
            cleanAfterSend: true,
            deleteDelaySeconds: cleanupDelaySeconds,
            sendNotification: sendNotifications,
            pollIntervalSeconds,
        };
        await saveWpAutomationSettingsRemote(payload);
        setNotice({
            type: "info",
            text: nextState
                ? "Automated Dispatcher ENABLED. Live submissions will be generated, archived to GCP, pushed to WP, emailed, and temporarily purged."
                : "Automated Dispatcher PAUSED."
        });
        setTimeout(() => setNotice(null), 5000);
    };

    const handleUpdateDelay = async (e) => {
        const val = parseInt(e.target.value, 10);
        setCleanupDelaySeconds(val);
        await saveWpAutomationSettingsRemote({
            enabled: isAutomationActive,
            deleteDelaySeconds: val,
        });
    };

    // Helper: Build filled PDF bytes for an entry
    const buildPdfForEntry = async (entry) => {
        const target = activePdfTemplate || pdfTemplateUrl;
        const result = await fetchPdfBytes(target, sourceConnectionId);
        if (!result?.bytes) {
            throw new Error("Could not load PDF template bytes.");
        }

        return await generateFilledPdf({
            templateBytes: result.bytes,
            mappings,
            submission: entry,
            flatten: false,
            attachUploadedFiles: true,
            formsUrl: targetWpUrl,
            apiKey: "",
        });
    };

    // Core Pipeline: Generate -> Store GCP -> Push to WP -> Send Mail -> Auto-Clean WP
    const executePipelineForEntry = async (entry, isAuto = false) => {
        const entryId = String(entry.id || entry);
        const formId = String(selectedForm?.id || "1");
        setProcessingEntryId(entryId);

        try {
            // Step A: Generate filled PDF
            let fullEntry = entry;
            if (typeof entry === "string" || !entry.id) {
                fullEntry = submissions.find((s) => String(s.id) === entryId) || { id: entryId, form_id: formId };
            }

            const genResult = await buildPdfForEntry(fullEntry);

            // Step B: Permanent Archive in Google Cloud Storage
            const templateId = activePdfTemplate?.id || "Template";
            const category = activePdfTemplate?.category || "AIBT";

            let gcsPublicUrl = "";
            try {
                const cloudRes = await storePdfInCloud({
                    pdfBytes: genResult.pdfBytes,
                    formId,
                    entryId,
                    templateId,
                    category,
                });
                gcsPublicUrl = cloudRes.publicUrl || "";
            } catch (cloudErr) {
                console.warn("[WP Pipeline] GCS cloud archive warning:", cloudErr.message);
            }

            // Step C: Push PDF to WordPress temporary storage & dispatch email notification
            const wpRes = await pushPdfToWordPress({
                formId,
                entryId,
                pdfUrl: gcsPublicUrl,
                pdfBytes: genResult.pdfBytes,
                wordpressUrl: targetWpUrl,
                sourceConnectionId,
                sendNotification: sendNotifications,
                cleanAfterSend: true,
                deleteDelaySeconds: cleanupDelaySeconds,
                action: isAuto ? "automated_dispatch" : "manual_push",
            });

            setNotice({
                type: wpRes.notificationSent ? "success" : "info",
                text: `Entry #${entryId}: PDF archived to GCP and staged on WordPress. ${wpRes.notificationSent ? "Gravity Forms notification email dispatched!" : "Notification processed."} (Auto-cleanup: ${cleanupDelaySeconds > 0 ? `scheduled in ${cleanupDelaySeconds}s` : "immediate"})`,
            });

            // Refresh logs
            loadLogs();
            return wpRes;
        } catch (err) {
            console.error(`Pipeline failed for Entry #${entryId}:`, err);
            setNotice({
                type: "error",
                text: `Dispatch failed for Entry #${entryId}: ${err.message}`,
            });
            loadLogs();
            throw err;
        } finally {
            setProcessingEntryId(null);
        }
    };

    // Manual Cleanup trigger
    const handleCleanFromWp = async (entryId) => {
        setCleaningEntryId(entryId);
        try {
            const res = await cleanupWpPdf({
                entryId,
                formId: selectedForm?.id || "1",
                wordpressUrl: targetWpUrl,
                sourceConnectionId,
            });
            setNotice({
                type: "success",
                text: res.message || `Temporary PDF for Entry #${entryId} purged from WordPress storage.`,
            });
            loadLogs();
        } catch (err) {
            setNotice({
                type: "error",
                text: `Cleanup failed for Entry #${entryId}: ${err.message}`,
            });
        } finally {
            setCleaningEntryId(null);
        }
    };

    const executePipelineRef = useRef();
    useEffect(() => {
        executePipelineRef.current = executePipelineForEntry;
    });

    // Real-time Automated Polling Dispatcher
    useEffect(() => {
        if (!isAutomationActive || !selectedForm) return;

        let isPolling = true;
        const intervalMs = Math.max(8000, pollIntervalSeconds * 1000);

        const pollCycle = async () => {
            if (!isPolling || isDispatchingRef.current) return;
            try {
                const freshSubs = await fetchFormSubmissions(
                    selectedForm.id,
                    targetWpUrl,
                    "",
                    { basicAuthUser: "", basicAuthPass: "", sourceConnectionId }
                );
                const list = Array.isArray(freshSubs?.entries) ? freshSubs.entries : [];
                setSubmissions(list);

                // Find unhandled entries
                for (const sub of list) {
                    const sid = String(sub.id);
                    if (!processedSubmissionIdsRef.current.has(sid)) {
                        processedSubmissionIdsRef.current.add(sid);
                        isDispatchingRef.current = true;
                        try {
                            if (executePipelineRef.current) {
                                await executePipelineRef.current(sub, true);
                            }
                        } finally {
                            isDispatchingRef.current = false;
                        }
                        break;
                    }
                }
            } catch (pollErr) {
                console.warn("[Auto-Dispatcher Poll Error]", pollErr);
            }
        };

        const timer = setInterval(pollCycle, intervalMs);
        return () => {
            isPolling = false;
            clearInterval(timer);
        };
    }, [isAutomationActive, selectedForm, targetWpUrl, sourceConnectionId, pollIntervalSeconds]);

    // Filter submissions
    const filteredSubmissions = submissions.filter((s) => {
        if (!searchEntryQuery) return true;
        const q = searchEntryQuery.toLowerCase();
        const idMatch = String(s.id).includes(q);
        const jsonMatch = JSON.stringify(s).toLowerCase().includes(q);
        return idMatch || jsonMatch;
    });

    return (
        <div className="wp-integration-page">
            {/* Header */}
            <div className="wp-integration-header">
                <div>
                    <span className="wp-section-kicker">Step 4 • WordPress Site Storage &amp; Gravity Forms Dispatch</span>
                    <h2>WordPress Integration &amp; Temporary Storage Manager</h2>
                    <p>
                        Staging bridge between Google Cloud Storage and WordPress. Temporarily pushes the generated PDF to WordPress disk storage so Gravity Forms can attach it to email notifications, and automatically deletes it after dispatch so WordPress disk storage stays clean.
                    </p>
                </div>

                <div className="wp-header-actions">
                    <a
                        href="/api/download-plugin"
                        download="gravity-forms-reader.zip"
                        className="wp-btn wp-btn-secondary"
                        title="Download the updated custom plugin for your WordPress sites"
                    >
                        <Download size={14} /> Download Plugin v1.5.0 (ZIP)
                    </a>
                    <button
                        type="button"
                        className="wp-btn wp-btn-secondary"
                        onClick={() => { loadLogs(); loadSubmissions(); loadGcsGeneratedPdfs(); }}
                        disabled={isLoadingLogs || isLoadingSubmissions}
                    >
                        <RefreshCw size={14} className={isLoadingLogs ? "animate-spin" : ""} /> Refresh Status
                    </button>
                </div>
            </div>

            {/* Architecture Banner */}
            <div className="wp-architecture-banner">
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "600", fontSize: "13px", color: "#0369a1", minWidth: "160px" }}>
                    <Sparkles size={16} /> Storage Pipeline:
                </div>
                <div className="wp-arch-flow">
                    <div className="wp-arch-step is-cloud">
                        <Cloud size={14} /> 1. GCP ({GCS_BUCKET}/generated)
                    </div>
                    <span className="wp-arch-arrow">➔</span>
                    <div className="wp-arch-step is-temp">
                        <Clock size={14} /> 2. WP Storage (Temporary Staging)
                    </div>
                    <span className="wp-arch-arrow">➔</span>
                    <div className="wp-arch-step is-wp">
                        <Mail size={14} /> 3. Gravity Forms Email (Attached)
                    </div>
                    <span className="wp-arch-arrow">➔</span>
                    <div className="wp-arch-step is-temp">
                        <Trash2 size={14} /> 4. Auto-Purge from WP ({cleanupDelaySeconds === 0 ? "Immediate" : `${cleanupDelaySeconds}s`})
                    </div>
                </div>
            </div>

            {/* Status Grid */}
            <div className="wp-status-grid">
                <div className="wp-status-card">
                    <div className="wp-status-card-header">
                        <span>Connected WordPress Site</span>
                        <Globe size={14} />
                    </div>
                    <div className="wp-status-card-value">
                        {activeWpConn?.name || (targetWpUrl ? new URL(targetWpUrl).hostname : "No Site Selected")}
                    </div>
                    <div className="wp-status-card-sub" title={targetWpUrl}>
                        {targetWpUrl || "Connect a WordPress site in navigation"}
                    </div>
                </div>

                <div className="wp-status-card">
                    <div className="wp-status-card-header">
                        <span>Active Form &amp; Template</span>
                        <FileText size={14} />
                    </div>
                    <div className="wp-status-card-value">
                        {selectedForm ? `Form #${selectedForm.id}: ${selectedForm.title}` : "No Form Selected"}
                    </div>
                    <div className="wp-status-card-sub">
                        Template: {activePdfTemplate?.name || activePdfTemplate?.id || (pdfTemplates?.length ? `${pdfTemplates.length} templates available` : "Default Template")}
                    </div>
                </div>

                <div className="wp-status-card">
                    <div className="wp-status-card-header">
                        <span>WP Temporary Cleanup Mode</span>
                        <ShieldCheck size={14} />
                    </div>
                    <div className="wp-status-card-value" style={{ color: "#0284c7" }}>
                        {cleanupDelaySeconds === 0 ? "Immediate Purge" : `Auto-Delete in ${cleanupDelaySeconds}s`}
                    </div>
                    <div className="wp-status-card-sub">
                        Guaranteed removal after email attachment
                    </div>
                </div>

                <div className="wp-status-card">
                    <div className="wp-status-card-header">
                        <span>Automated Dispatch Daemon</span>
                        <Send size={14} />
                    </div>
                    <div className="wp-status-card-value">
                        <span className={`wp-badge ${isAutomationActive ? "wp-badge-success" : "wp-badge-neutral"}`}>
                            {isAutomationActive ? "ACTIVE & LISTENING" : "PAUSED"}
                        </span>
                    </div>
                    <div className="wp-status-card-sub">
                        {isAutomationActive ? `Checking for submissions every ${pollIntervalSeconds}s` : "Enable section 1 below"}
                    </div>
                </div>
            </div>

            {/* Notice Message */}
            {notice && (
                <div className={`wp-notice wp-notice-${notice.type}`}>
                    <span>{notice.text}</span>
                    <button type="button" onClick={() => setNotice(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: "bold" }}>×</button>
                </div>
            )}

            <div className="wp-sections-container">
                {/* SECTION 1: Automated send as the user submits an entry */}
                <div className="wp-section-card">
                    <div className="wp-section-header">
                        <div className="wp-section-title-wrap">
                            <span className="wp-section-kicker">Section 1</span>
                            <h3>Automated Send on Entry Submission &amp; Real-Time Logs</h3>
                        </div>
                        {isAutomationActive && (
                            <div className="wp-pulse-indicator active">
                                <span className="wp-pulse-dot" /> Live Auto-Dispatcher Running
                            </div>
                        )}
                    </div>

                    <div className="wp-section-body">
                        {/* Master Toggle Bar */}
                        <div className="wp-toggle-bar">
                            <div className="wp-toggle-info">
                                <label className="wp-toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={isAutomationActive}
                                        onChange={handleToggleAutomation}
                                    />
                                    <span className="wp-toggle-slider" />
                                </label>
                                <div className="wp-toggle-text">
                                    <h4>Automatic PDF Generation &amp; Email Dispatch</h4>
                                    <p>
                                        When a user submits a Gravity Form entry, automatically fill the mapped PDF, archive to GCP, push to WordPress, dispatch the notification email with PDF attached, and purge the temporary file.
                                    </p>
                                </div>
                            </div>

                            <button
                                type="button"
                                className={`wp-btn ${isAutomationActive ? "wp-btn-secondary" : "wp-btn-primary"}`}
                                onClick={handleToggleAutomation}
                            >
                                {isAutomationActive ? "Pause Auto-Dispatcher" : "Enable Auto-Dispatcher"}
                            </button>
                        </div>

                        {/* Configuration Controls */}
                        <div className="wp-settings-grid">
                            <div className="wp-setting-item">
                                <label>Target WordPress Site</label>
                                <select
                                    value={targetWpUrl}
                                    onChange={(e) => setTargetWpUrl(e.target.value)}
                                >
                                    {wpConnections && wpConnections.length > 0 ? (
                                        wpConnections.map((conn) => (
                                            <option key={conn.id} value={conn.url}>
                                                {conn.name} ({conn.url})
                                            </option>
                                        ))
                                    ) : (
                                        <option value={targetWpUrl}>{targetWpUrl || "Default WordPress Site"}</option>
                                    )}
                                </select>
                            </div>

                            <div className="wp-setting-item">
                                <label>Target Gravity Form</label>
                                <select
                                    value={selectedForm?.id || ""}
                                    onChange={(e) => {
                                        const found = forms?.find((f) => String(f.id) === e.target.value);
                                        if (found && onSelectForm) onSelectForm(found.id);
                                    }}
                                >
                                    {forms && forms.length > 0 ? (
                                        forms.map((f) => (
                                            <option key={f.id} value={f.id}>
                                                Form #{f.id}: {f.title}
                                            </option>
                                        ))
                                    ) : (
                                        <option value="">No forms loaded</option>
                                    )}
                                </select>
                            </div>

                            <div className="wp-setting-item">
                                <label>Temporary Storage Auto-Purge Timing</label>
                                <select
                                    value={cleanupDelaySeconds}
                                    onChange={handleUpdateDelay}
                                >
                                    <option value={0}>Immediate (Purge directly after wp_mail)</option>
                                    <option value={15}>15 Seconds Delay (Recommended for quick forms)</option>
                                    <option value={30}>30 Seconds Delay (Standard / SMTP queue safety)</option>
                                    <option value={60}>1 Minute Delay</option>
                                    <option value={300}>5 Minutes Delay</option>
                                    <option value={900}>15 Minutes Delay</option>
                                </select>
                            </div>

                            <div className="wp-setting-item">
                                <label>Gravity Forms Email Notification</label>
                                <label className="wp-checkbox-label">
                                    <input
                                        type="checkbox"
                                        checked={sendNotifications}
                                        onChange={(e) => setSendNotifications(e.target.checked)}
                                    />
                                    <span>Send Gravity Forms Notification Email (with PDF attached)</span>
                                </label>
                            </div>

                            <div className="wp-setting-item">
                                <label>Polling Frequency</label>
                                <select
                                    value={pollIntervalSeconds}
                                    onChange={(e) => setPollIntervalSeconds(parseInt(e.target.value, 10))}
                                >
                                    <option value={10}>Every 10 seconds</option>
                                    <option value={15}>Every 15 seconds (Default)</option>
                                    <option value={30}>Every 30 seconds</option>
                                    <option value={60}>Every 60 seconds</option>
                                </select>
                            </div>
                        </div>

                        {/* Mail & Operation Logs Section */}
                        <div className="wp-logs-wrapper">
                            <div className="wp-logs-header-bar">
                                <h4>
                                    <Mail size={15} /> Mail &amp; Operation Logs ({logs.length} events recorded)
                                </h4>
                                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                    <label className="wp-checkbox-label" style={{ fontSize: "12px", margin: 0 }}>
                                        <input
                                            type="checkbox"
                                            checked={autoRefreshLogs}
                                            onChange={(e) => setAutoRefreshLogs(e.target.checked)}
                                        />
                                        <span>Auto-refresh</span>
                                    </label>
                                    <button
                                        type="button"
                                        className="wp-btn wp-btn-secondary wp-btn-sm"
                                        onClick={loadLogs}
                                        disabled={isLoadingLogs}
                                    >
                                        <RefreshCw size={12} className={isLoadingLogs ? "animate-spin" : ""} /> Refresh
                                    </button>
                                    {logs.length > 0 && (
                                        <button
                                            type="button"
                                            className="wp-btn wp-btn-danger wp-btn-sm"
                                            onClick={async () => {
                                                await clearWpDispatchLogs();
                                                loadLogs();
                                            }}
                                        >
                                            <Trash2 size={12} /> Clear Logs
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="wp-table-container">
                                {logs.length === 0 ? (
                                    <div className="wp-empty-state">
                                        <Info size={28} style={{ opacity: 0.4 }} />
                                        <p>No dispatch operations recorded yet. Submit a form or use Manual Push below.</p>
                                    </div>
                                ) : (
                                    <table className="wp-table">
                                        <thead>
                                            <tr>
                                                <th>Time</th>
                                                <th>Entry</th>
                                                <th>Trigger</th>
                                                <th>GCP Cloud Archive</th>
                                                <th>Email Status</th>
                                                <th>WP Storage Cleanup</th>
                                                <th>Details</th>
                                                <th>Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {logs.map((log) => (
                                                <tr key={log.id}>
                                                    <td style={{ whiteSpace: "nowrap", fontSize: "12px", color: "#64748b" }}>
                                                        {new Date(log.timestamp).toLocaleTimeString()}
                                                    </td>
                                                    <td>
                                                        <strong>#{log.entryId}</strong>
                                                        <span style={{ fontSize: "11px", color: "#64748b", marginLeft: "4px" }}>
                                                            (Form #{log.formId})
                                                        </span>
                                                    </td>
                                                    <td>
                                                        <span className="wp-badge wp-badge-neutral">
                                                            {log.action === "automated_dispatch" ? "Automated" : "Manual"}
                                                        </span>
                                                    </td>
                                                    <td>
                                                        {log.gcpPdfUrl ? (
                                                            <a
                                                                href={log.gcpPdfUrl}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="wp-badge wp-badge-info"
                                                                style={{ textDecoration: "none" }}
                                                                title={log.gcpPdfUrl}
                                                            >
                                                                <Cloud size={11} /> View in GCP <ExternalLink size={10} />
                                                            </a>
                                                        ) : (
                                                            <span className="wp-badge wp-badge-neutral">Local / Cached</span>
                                                        )}
                                                    </td>
                                                    <td>
                                                        {log.notificationSent ? (
                                                            <span className="wp-badge wp-badge-success">
                                                                <Check size={11} /> Dispatched &amp; Attached
                                                            </span>
                                                        ) : log.notificationRequested ? (
                                                            <span className="wp-badge wp-badge-error" title={log.notificationError || ""}>
                                                                <AlertCircle size={11} /> Failed
                                                            </span>
                                                        ) : (
                                                            <span className="wp-badge wp-badge-neutral">Skipped</span>
                                                        )}
                                                    </td>
                                                    <td>
                                                        {log.cleanupStatus === "cleaned" ? (
                                                            <span className="wp-badge wp-badge-success">
                                                                <CheckCircle2 size={11} /> Purged from WP
                                                            </span>
                                                        ) : log.cleanupStatus === "scheduled" ? (
                                                            <span className="wp-badge wp-badge-warning">
                                                                <Clock size={11} /> Scheduled Purge
                                                            </span>
                                                        ) : (
                                                            <span className="wp-badge wp-badge-neutral">
                                                                {log.cleanupStatus}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td style={{ fontSize: "12px", maxWidth: "260px", color: "#475569" }}>
                                                        {log.message}
                                                    </td>
                                                    <td>
                                                        <div style={{ display: "flex", gap: "6px" }}>
                                                            {log.cleanupStatus !== "cleaned" && (
                                                                <button
                                                                    type="button"
                                                                    className="wp-btn wp-btn-secondary wp-btn-sm"
                                                                    onClick={() => handleCleanFromWp(log.entryId)}
                                                                    disabled={cleaningEntryId === log.entryId}
                                                                    title="Purge temporary file from WordPress storage right now"
                                                                >
                                                                    <Trash2 size={11} /> Purge Now
                                                                </button>
                                                            )}
                                                            <button
                                                                type="button"
                                                                className="wp-btn wp-btn-primary wp-btn-sm"
                                                                onClick={() => executePipelineForEntry(log.entryId, false)}
                                                                disabled={processingEntryId === log.entryId}
                                                                title="Re-run dispatch pipeline for this entry"
                                                            >
                                                                <Send size={11} /> Re-send
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* SECTION 2: Manual way to push to WP and mail as I had */}
                <div className="wp-section-card">
                    <div className="wp-section-header">
                        <div className="wp-section-title-wrap">
                            <span className="wp-section-kicker">Section 2</span>
                            <h3>Manual Push to WordPress Storage &amp; Email Dispatch</h3>
                        </div>
                        <span style={{ fontSize: "13px", color: "#64748b" }}>
                            Select any recorded entry to stage on WordPress, attach to email, and auto-purge.
                        </span>
                    </div>

                    <div className="wp-section-body">
                        {/* Direct Entry ID Dispatch Bar */}
                        <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "20px", background: "#f8fafc", padding: "12px 16px", borderRadius: "8px", border: "1px solid #e2e8f0", flexWrap: "wrap" }}>
                            <span style={{ fontSize: "13px", fontWeight: "600", color: "#334155" }}>
                                Quick Dispatch by Entry ID:
                            </span>
                            <input
                                type="text"
                                placeholder="e.g. 104"
                                value={customEntryId}
                                onChange={(e) => setCustomEntryId(e.target.value)}
                                style={{ width: "120px", padding: "6px 10px", borderRadius: "4px", border: "1px solid #cbd5e1", fontSize: "13px" }}
                            />
                            <button
                                type="button"
                                className="wp-btn wp-btn-primary wp-btn-sm"
                                disabled={!customEntryId || processingEntryId === customEntryId}
                                onClick={() => executePipelineForEntry(customEntryId, false)}
                            >
                                {processingEntryId === customEntryId ? (
                                    <><Loader2 size={12} className="animate-spin" /> Processing...</>
                                ) : (
                                    <><Send size={12} /> Push &amp; Send Mail for Entry #{customEntryId}</>
                                )}
                            </button>
                            <button
                                type="button"
                                className="wp-btn wp-btn-secondary wp-btn-sm"
                                disabled={!customEntryId || cleaningEntryId === customEntryId}
                                onClick={() => handleCleanFromWp(customEntryId)}
                            >
                                <Trash2 size={12} /> Purge #{customEntryId} from WP
                            </button>
                        </div>

                        {/* Search & Submissions Table Header */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", flexWrap: "wrap", gap: "10px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                <input
                                    type="text"
                                    placeholder="Search submissions by ID or content..."
                                    value={searchEntryQuery}
                                    onChange={(e) => setSearchEntryQuery(e.target.value)}
                                    style={{ width: "280px", padding: "6px 12px", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px" }}
                                />
                                <span style={{ fontSize: "12px", color: "#64748b" }}>
                                    Showing {filteredSubmissions.length} of {submissions.length} submissions
                                </span>
                            </div>

                            <button
                                type="button"
                                className="wp-btn wp-btn-secondary wp-btn-sm"
                                onClick={loadSubmissions}
                                disabled={isLoadingSubmissions}
                            >
                                <RefreshCw size={12} className={isLoadingSubmissions ? "animate-spin" : ""} /> Refresh Submissions
                            </button>
                        </div>

                        {/* Submissions Table */}
                        <div className="wp-table-container">
                            {filteredSubmissions.length === 0 ? (
                                <div className="wp-empty-state">
                                    <Info size={28} style={{ opacity: 0.4 }} />
                                    <p>
                                        {isLoadingSubmissions
                                            ? "Loading live submissions from WordPress..."
                                            : "No submissions found for the selected form. Submit an entry on your WordPress site to see it here."}
                                    </p>
                                </div>
                            ) : (
                                <table className="wp-table">
                                    <thead>
                                        <tr>
                                            <th>Entry ID</th>
                                            <th>Date Submitted</th>
                                            <th>Submitter / Key Fields</th>
                                            <th>Attachments</th>
                                            <th>Manual Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredSubmissions.map((entry) => {
                                            const eid = String(entry.id);
                                            const isProcessing = processingEntryId === eid;
                                            const isCleaning = cleaningEntryId === eid;
                                            const subDate = entry.date_created || entry.dateCreated || "Recent";
                                            const uploadedFiles = entry._uploaded_files || [];

                                            // Extract representative fields
                                            const sampleValues = Object.entries(entry)
                                                .filter(([fieldKey, v]) => !fieldKey.startsWith("_") && !["id", "form_id", "date_created", "status", "ip"].includes(fieldKey) && typeof v === "string" && v.length > 0 && v.length < 50)
                                                .slice(0, 3)
                                                .map(([, val]) => val)
                                                .join(" • ");

                                            return (
                                                <tr key={eid}>
                                                    <td>
                                                        <strong style={{ fontSize: "14px" }}>#{eid}</strong>
                                                    </td>
                                                    <td style={{ fontSize: "12px", color: "#64748b", whiteSpace: "nowrap" }}>
                                                        {subDate}
                                                    </td>
                                                    <td style={{ fontSize: "13px", color: "#1e293b", maxWidth: "340px" }}>
                                                        {sampleValues || <em>Standard submission data</em>}
                                                    </td>
                                                    <td>
                                                        {uploadedFiles.length > 0 ? (
                                                            <span className="wp-badge wp-badge-info">
                                                                {uploadedFiles.length} file(s)
                                                            </span>
                                                        ) : (
                                                            <span style={{ fontSize: "12px", color: "#94a3b8" }}>None</span>
                                                        )}
                                                    </td>
                                                    <td>
                                                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                                            <button
                                                                type="button"
                                                                className="wp-btn wp-btn-primary wp-btn-sm"
                                                                disabled={isProcessing}
                                                                onClick={() => executePipelineForEntry(entry, false)}
                                                                title="Generate PDF, archive in GCP, push to WP, send notification email, and auto-purge temporary file"
                                                            >
                                                                {isProcessing ? (
                                                                    <><Loader2 size={12} className="animate-spin" /> Sending...</>
                                                                ) : (
                                                                    <><Send size={12} /> Push &amp; Send Mail</>
                                                                )}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="wp-btn wp-btn-secondary wp-btn-sm"
                                                                disabled={isCleaning}
                                                                onClick={() => handleCleanFromWp(eid)}
                                                                title="Clean/delete temporary PDF from WordPress filesystem right now"
                                                            >
                                                                {isCleaning ? (
                                                                    <Loader2 size={12} className="animate-spin" />
                                                                ) : (
                                                                    <Trash2 size={12} />
                                                                )}
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>
                </div>

                {/* SECTION 3: Google Cloud Storage Archive (vc-pdf-generator-storage/generated) */}
                <div className="wp-section-card">
                    <div className="wp-section-header">
                        <div className="wp-section-title-wrap">
                            <span className="wp-section-kicker">Section 3</span>
                            <h3>Google Cloud Storage Archive (<code>{gcsPdfsInfo?.bucket || GCS_BUCKET}/{gcsPdfsInfo?.folder || GCS_GENERATED_PATH}</code>)</h3>
                        </div>
                        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                            {gcsPdfsInfo?.consoleUrl && (
                                <a
                                    href={gcsPdfsInfo.consoleUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="wp-btn wp-btn-secondary wp-btn-sm"
                                    style={{ textDecoration: "none" }}
                                >
                                    <ExternalLink size={12} /> Open GCP Bucket Console
                                </a>
                            )}
                            <button
                                type="button"
                                className="wp-btn wp-btn-secondary wp-btn-sm"
                                onClick={loadGcsGeneratedPdfs}
                                disabled={isLoadingGcsPdfs}
                            >
                                <RefreshCw size={12} className={isLoadingGcsPdfs ? "animate-spin" : ""} /> Refresh GCP Files
                            </button>
                        </div>
                    </div>

                    <div className="wp-section-body">
                        {/* Search & Stats Bar */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                <input
                                    type="text"
                                    placeholder="Search generated PDFs by filename or Entry ID..."
                                    value={gcsPdfsSearch}
                                    onChange={(e) => setGcsPdfsSearch(e.target.value)}
                                    style={{ width: "320px", padding: "6px 12px", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px" }}
                                />
                                <span style={{ fontSize: "12px", color: "#64748b" }}>
                                    Showing {filteredGcsPdfs.length} of {gcsPdfs.length} files in <code>{GCS_BUCKET}/generated/</code>
                                </span>
                            </div>
                            <div style={{ fontSize: "12px", color: "#0369a1", display: "flex", alignItems: "center", gap: "6px" }}>
                                <ShieldCheck size={14} color="#059669" /> Default Bucket: <strong>{gcsPdfsInfo?.bucket || GCS_BUCKET}</strong> (Project: {GCS_PROJECT_ID})
                            </div>
                        </div>

                        {/* GCS PDFs Table */}
                        <div className="wp-table-container">
                            {filteredGcsPdfs.length === 0 ? (
                                <div className="wp-empty-state">
                                    <Cloud size={28} style={{ opacity: 0.4 }} />
                                    <p>
                                        {isLoadingGcsPdfs
                                            ? "Scanning Google Cloud Storage bucket..."
                                            : `No generated PDFs found in ${GCS_BUCKET}/generated/. Generate a PDF using the mapping tool or Gravity Forms submission to see it archived here.`}
                                    </p>
                                </div>
                            ) : (
                                <table className="wp-table">
                                    <thead>
                                        <tr>
                                            <th>Filename &amp; Location</th>
                                            <th>Entry ID</th>
                                            <th>Size</th>
                                            <th>Created / Modified</th>
                                            <th>Storage Tier</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredGcsPdfs.map((item) => {
                                            const isPushing = pushingGcsFilename === item.filename;
                                            const isDeleting = deletingGcsFilename === item.filename;
                                            const sizeKb = Math.round((item.size || 0) / 1024);
                                            const formattedDate = item.updated ? new Date(item.updated).toLocaleString() : "Recent";

                                            return (
                                                <tr key={item.id || item.filename}>
                                                    <td>
                                                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                                            <FileText size={15} color="#0284c7" />
                                                            <div>
                                                                <strong style={{ fontSize: "13px", color: "#0f172a" }}>
                                                                    {item.filename}
                                                                </strong>
                                                                <div style={{ fontSize: "11px", color: "#64748b" }}>
                                                                    {item.gcsUri || `gs://${GCS_BUCKET}/${item.name}`}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td>
                                                        {item.entryId ? (
                                                            <span className="wp-badge wp-badge-neutral">
                                                                #{item.entryId}
                                                            </span>
                                                        ) : (
                                                            <span style={{ fontSize: "12px", color: "#94a3b8" }}>—</span>
                                                        )}
                                                    </td>
                                                    <td style={{ fontSize: "12px", color: "#475569" }}>
                                                        {sizeKb > 0 ? `${sizeKb} KB` : "—"}
                                                    </td>
                                                    <td style={{ fontSize: "12px", color: "#64748b", whiteSpace: "nowrap" }}>
                                                        {formattedDate}
                                                    </td>
                                                    <td>
                                                        {item.source === "gcs" ? (
                                                            <span className="wp-badge wp-badge-success" title="Permanent Google Cloud Storage Archive">
                                                                <Cloud size={10} /> GCP Active
                                                            </span>
                                                        ) : (
                                                            <span className="wp-badge wp-badge-info" title="Cached locally on server">
                                                                Local Cache
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td>
                                                        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                                                            {/* View PDF */}
                                                            <a
                                                                href={`/api/wp-proxy?url=${encodeURIComponent(item.publicUrl || item.mediaLink || item.localUrl)}`}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="wp-btn wp-btn-secondary wp-btn-sm"
                                                                title="View PDF directly in browser"
                                                            >
                                                                <Eye size={11} /> View
                                                            </a>

                                                            {/* Download */}
                                                            <a
                                                                href={`/api/wp-proxy?url=${encodeURIComponent(item.publicUrl || item.mediaLink || item.localUrl)}`}
                                                                download={item.filename}
                                                                className="wp-btn wp-btn-secondary wp-btn-sm"
                                                                title="Download file to computer"
                                                            >
                                                                <Download size={11} />
                                                            </a>

                                                            {/* Push to WP & Email */}
                                                            <button
                                                                type="button"
                                                                className="wp-btn wp-btn-primary wp-btn-sm"
                                                                disabled={isPushing}
                                                                onClick={() => handlePushGcsPdfToWp(item)}
                                                                title="Stage on WordPress, attach to Gravity Forms notification email, and auto-purge"
                                                            >
                                                                {isPushing ? (
                                                                    <><Loader2 size={11} className="animate-spin" /> Pushing...</>
                                                                ) : (
                                                                    <><Send size={11} /> Push &amp; Mail</>
                                                                )}
                                                            </button>

                                                            {/* Delete */}
                                                            <button
                                                                type="button"
                                                                className="wp-btn wp-btn-danger wp-btn-sm"
                                                                disabled={isDeleting}
                                                                onClick={() => handleDeleteGcsPdf(item)}
                                                                title="Delete file permanently"
                                                            >
                                                                {isDeleting ? (
                                                                    <Loader2 size={11} className="animate-spin" />
                                                                ) : (
                                                                    <Trash2 size={11} />
                                                                )}
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>
                </div>

                {/* Plugin Deployment & Integration Guide */}
                <div className="wp-section-card" style={{ background: "#f8fafc" }}>
                    <div className="wp-section-header">
                        <div className="wp-section-title-wrap">
                            <span className="wp-section-kicker">Deployment Reference</span>
                            <h3>Custom WordPress Plugin Deployment &amp; Webhook Instructions</h3>
                        </div>
                    </div>
                    <div className="wp-section-body">
                        <p style={{ fontSize: "13px", color: "#475569", margin: "0 0 16px" }}>
                            The custom <strong>Gravity Forms Reader v1.5.0</strong> plugin connects your WordPress sites directly to this PDF Generator system. It supports real-time entry extraction, synchronous PDF attachment to Gravity Forms notifications, and automatic purge of temporary files.
                        </p>

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
                            <div style={{ background: "#ffffff", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                                <strong style={{ fontSize: "13px", color: "#0f172a", display: "block", marginBottom: "6px" }}>
                                    1. Install Updated Plugin
                                </strong>
                                <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 10px" }}>
                                    Upload <code>gravity-forms-reader.zip</code> into WordPress via <em>Plugins ➔ Add New ➔ Upload Plugin</em>.
                                </p>
                                <a
                                    href="/api/download-plugin"
                                    download="gravity-forms-reader.zip"
                                    className="wp-btn wp-btn-secondary wp-btn-sm"
                                >
                                    <Download size={12} /> Download Plugin v1.5.0 (.zip)
                                </a>
                            </div>

                            <div style={{ background: "#ffffff", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                                <strong style={{ fontSize: "13px", color: "#0f172a", display: "block", marginBottom: "6px" }}>
                                    2. Security &amp; Authentication Key
                                </strong>
                                <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 8px" }}>
                                    Optional: In your WordPress <code>wp-config.php</code>, define:
                                </p>
                                <code style={{ fontSize: "11px", display: "block", background: "#f1f5f9", padding: "6px 8px", borderRadius: "4px" }}>
                                    define('PDF_GENERATOR_API_KEY', 'your-random-api-key');
                                </code>
                            </div>

                            <div style={{ background: "#ffffff", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                                <strong style={{ fontSize: "13px", color: "#0f172a", display: "block", marginBottom: "6px" }}>
                                    3. Temporary Storage Verification
                                </strong>
                                <p style={{ fontSize: "12px", color: "#64748b", margin: 0 }}>
                                    Temporary PDFs are placed in <code>wp-content/pdf-generator/generated/</code> only while Gravity Forms delivers the notification email, then purged automatically. Permanent archives remain safe in Google Cloud Storage at <code>{GCS_BUCKET}/generated/</code>.
                                </p>
                            </div>

                            <div style={{ background: "#ffffff", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                                <strong style={{ fontSize: "13px", color: "#0f172a", display: "block", marginBottom: "6px" }}>
                                    4. Microsoft 365 / WPO360 Auth Layer
                                </strong>
                                <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 8px" }}>
                                    If your site is protected with <strong>WPO360</strong>, add this path to WPO360 &gt; User Registration &gt; Excluded Paths / REST API whitelist:
                                </p>
                                <code style={{ fontSize: "11px", display: "block", background: "#f1f5f9", padding: "6px 8px", borderRadius: "4px" }}>
                                    /wp-json/pdf-generator/v1/*
                                </code>
                                <p style={{ fontSize: "11px", color: "#64748b", margin: "6px 0 0" }}>
                                    Plugin v1.5.0 automatically hooks into <code>wpo360/bypass_authorization</code> when a valid <code>X-PDF-API-Key</code> is provided.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
