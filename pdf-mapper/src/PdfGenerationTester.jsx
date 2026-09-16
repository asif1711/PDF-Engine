import { useState, useEffect, useCallback, useMemo } from "react";
import {
    X,
    Zap,
    Send,
    Download,
    ExternalLink,
    Paperclip,
    Check,
    ChevronDown,
    Settings,
    Loader2
} from "lucide-react";
import "./PdfGenerationTester.css";
import { generateFilledPdf, extractUploadedFilesFromEntry } from "./pdfGenerator";
import { fetchFormSubmissions } from "./submissionService";
import { fetchPdfBytes } from "./connectionManager";
import { normalizeWpFormsUrl } from "./mappingUtils";

export default function PdfGenerationTester({
    isOpen,
    onClose,
    selectedForm,
    selectedTemplate,
    mappings,
    pdfTemplateUrl,
    wordpressFormsUrl,
    wordpressApiKey,
}) {
    const [submissions, setSubmissions] = useState([]);
    const [selectedSubmissionId, setSelectedSubmissionId] = useState("");
    const [currentEntry, setCurrentEntry] = useState(null);
    const [submissionSource, setSubmissionSource] = useState({ source: "loading", message: "" });
    const [activeTab, setActiveTab] = useState("preview"); // "preview" | "audit" | "json"
    const [isGenerating, setIsGenerating] = useState(false);
    const [isPushingToWp, setIsPushingToWp] = useState(false);
    const [generationResult, setGenerationResult] = useState(null);
    const [error, setError] = useState("");
    const [pushNotice, setPushNotice] = useState("");

    // Connection settings state (persisted to localStorage)
    const [showConnectionConfig, setShowConnectionConfig] = useState(false);
    const [customFormsUrl, setCustomFormsUrl] = useState(() => {
        return localStorage.getItem("pfgf_custom_forms_url") || wordpressFormsUrl || "https://fair-land.localsite.io/wp-json/pdf-generator/v1/forms";
    });
    const [customApiKey, setCustomApiKey] = useState(() => {
        return localStorage.getItem("pfgf_custom_api_key") || wordpressApiKey || "";
    });
    const [liveLinkUser, setLiveLinkUser] = useState(() => {
        return localStorage.getItem("pfgf_livelink_user") || "";
    });
    const [liveLinkPass, setLiveLinkPass] = useState(() => {
        return localStorage.getItem("pfgf_livelink_pass") || "";
    });

    // Raw JSON editor state
    const [rawJsonText, setRawJsonText] = useState("");
    const [jsonParseError, setJsonParseError] = useState("");
    const [flattenPdf, setFlattenPdf] = useState(false);
    const [attachUploadedFiles, setAttachUploadedFiles] = useState(true);

    // Automatically inspect selected submission for uploaded files (e.g. Field #15: Vector2.png, PDF documents)
    const detectedUploadedFiles = useMemo(() => {
        return currentEntry ? extractUploadedFilesFromEntry(currentEntry) : [];
    }, [currentEntry]);

    // Load template PDF bytes
    const [pdfBytes, setPdfBytes] = useState(null);

    useEffect(() => {
        if (!isOpen || (!pdfTemplateUrl && !selectedTemplate)) return undefined;
        let isSubscribed = true;
        const target = pdfTemplateUrl || selectedTemplate;

        fetchPdfBytes(target)
            .then((res) => {
                if (isSubscribed) {
                    if (res?.bytes) {
                        setPdfBytes(res.bytes);
                    } else {
                        setError("Failed to load PDF template bytes.");
                    }
                }
            })
            .catch((err) => {
                if (isSubscribed) setError("Failed to load PDF template: " + err.message);
            });

        return () => {
            isSubscribed = false;
        };
    }, [isOpen, pdfTemplateUrl, selectedTemplate]);

    // Fetch submissions for the selected form
    const loadSubmissions = useCallback(async (overrideUrl, overrideKey, overrideUser, overridePass) => {
        if (!selectedForm) return;
        setError("");
        const urlToUse = overrideUrl !== undefined ? overrideUrl : customFormsUrl;
        const keyToUse = overrideKey !== undefined ? overrideKey : customApiKey;
        const userToUse = overrideUser !== undefined ? overrideUser : liveLinkUser;
        const passToUse = overridePass !== undefined ? overridePass : liveLinkPass;

        try {
            const res = await fetchFormSubmissions(
                selectedForm.id,
                urlToUse,
                keyToUse,
                { basicAuthUser: userToUse, basicAuthPass: passToUse }
            );
            setSubmissionSource({ source: res.source, message: res.message });
            setSubmissions(res.entries || []);
            if (res.entries && res.entries.length > 0) {
                setSelectedSubmissionId(res.entries[0].id);
                const first = JSON.parse(JSON.stringify(res.entries[0]));
                setCurrentEntry(first);
                setRawJsonText(JSON.stringify(first, null, 2));
            }
        } catch (err) {
            setError("Error loading submissions: " + err.message);
        }
    }, [selectedForm, customFormsUrl, customApiKey, liveLinkUser, liveLinkPass]);

    useEffect(() => {
        if (!isOpen || !selectedForm) return undefined;
        let isSubscribed = true;
        fetchFormSubmissions(
            selectedForm.id,
            customFormsUrl,
            customApiKey,
            { basicAuthUser: liveLinkUser, basicAuthPass: liveLinkPass }
        ).then((res) => {
            if (!isSubscribed) return;
            setSubmissionSource({ source: res.source, message: res.message });
            setSubmissions(res.entries || []);
            if (res.entries && res.entries.length > 0) {
                setSelectedSubmissionId(res.entries[0].id);
                const first = JSON.parse(JSON.stringify(res.entries[0]));
                setCurrentEntry(first);
                setRawJsonText(JSON.stringify(first, null, 2));
            }
        }).catch((err) => {
            if (isSubscribed) setError("Error loading submissions: " + err.message);
        });

        return () => {
            isSubscribed = false;
        };
    }, [isOpen, selectedForm, customFormsUrl, customApiKey, liveLinkUser, liveLinkPass]);

    // Save and re-test connection
    function handleSaveConnection(e) {
        e.preventDefault();
        localStorage.setItem("pfgf_custom_forms_url", customFormsUrl);
        localStorage.setItem("pfgf_custom_api_key", customApiKey);
        localStorage.setItem("pfgf_livelink_user", liveLinkUser);
        localStorage.setItem("pfgf_livelink_pass", liveLinkPass);
        setShowConnectionConfig(false);
        loadSubmissions(customFormsUrl, customApiKey, liveLinkUser, liveLinkPass);
    }

    // Switch submission
    function handleSubmissionSelect(id) {
        setSelectedSubmissionId(id);
        const found = submissions.find((s) => String(s.id) === String(id));
        if (found) {
            const copy = JSON.parse(JSON.stringify(found));
            setCurrentEntry(copy);
            setRawJsonText(JSON.stringify(copy, null, 2));
        }
    }

    // Update single field in current entry
    function handleFieldChange(fieldKey, value) {
        setCurrentEntry((prev) => {
            const updated = {
                ...prev,
                [fieldKey]: value,
            };
            setRawJsonText(JSON.stringify(updated, null, 2));
            return updated;
        });
    }

    // Apply JSON text directly
    function handleApplyJson() {
        try {
            const parsed = JSON.parse(rawJsonText);
            setJsonParseError("");
            // If parsed object has an inner "entry" object, unwrap and merge so top-level keys are directly available
            const unwrapped = parsed.entry && typeof parsed.entry === "object"
                ? { ...parsed, ...parsed.entry }
                : parsed;
            setCurrentEntry(unwrapped);
            setActiveTab("preview");
        } catch (err) {
            setJsonParseError("Invalid JSON: " + err.message);
        }
    }

    // Helper to extract value for preview editor inputs
    function getDisplayFieldValue(entry, key, type) {
        if (!entry) return "";
        if (entry[key] !== undefined && entry[key] !== null && entry[key] !== "") {
            return entry[key];
        }
        if (type === "firstName") return entry["1.3"] || entry["1"] || "";
        if (type === "lastName") return entry["1.6"] || entry["2"] || "";
        if (type === "address") {
            const parts = [entry["19.1"], entry["19.2"], entry["19.3"], entry["4.1"]].filter(Boolean);
            return parts.join(" ") || entry["4"] || "";
        }
        if (type === "usi") return entry["26"] || entry["7"] || "";
        if (type === "phone") return entry["5"] || entry["6"] || "";
        if (type === "signature") {
            if (entry["10"]) return entry["10"];
            const fn = entry["1.3"] || entry["1"] || "";
            const ln = entry["1.6"] || entry["2"] || "";
            return [fn, ln].filter(Boolean).join(" ");
        }
        if (type === "date") {
            if (entry["11"]) return entry["11"];
            if (entry.date_created) return entry.date_created.split(" ")[0];
            if (entry.submitted_at) return entry.submitted_at.split(" ")[0];
        }
        return "";
    }

    // Trigger generation
    const runGeneration = useCallback(async () => {
        if (!pdfBytes) {
            setError("PDF template is still loading. Please wait a moment.");
            return;
        }
        if (!currentEntry) {
            setError("Please select or enter a form submission.");
            return;
        }

        setIsGenerating(true);
        setError("");

        try {
            const result = await generateFilledPdf({
                templateBytes: pdfBytes,
                mappings,
                submission: currentEntry,
                flatten: flattenPdf,
                formsUrl: customFormsUrl,
                apiKey: customApiKey,
                attachUploadedFiles,
            });
            setGenerationResult(result);
        } catch (err) {
            setError("PDF Generation failed: " + err.message);
        } finally {
            setIsGenerating(false);
        }
    }, [pdfBytes, currentEntry, mappings, flattenPdf, customFormsUrl, customApiKey, attachUploadedFiles]);

    // Push PDF directly to WordPress REST endpoint and trigger email notification
    const handlePushToWpAndEmail = useCallback(async () => {
        if (!currentEntry) {
            setError("Please select or enter a form submission.");
            return;
        }

        setIsPushingToWp(true);
        setError("");
        setPushNotice("");

        try {
            let bytesToSend = generationResult?.pdfBytes;
            let filledCount = generationResult?.filledCount || 0;

            if (!bytesToSend) {
                if (!pdfBytes) {
                    throw new Error("PDF template bytes are not loaded yet.");
                }
                const result = await generateFilledPdf({
                    templateBytes: pdfBytes,
                    mappings,
                    submission: currentEntry,
                    flatten: flattenPdf,
                    formsUrl: customFormsUrl,
                    apiKey: customApiKey,
                    attachUploadedFiles,
                });
                setGenerationResult(result);
                bytesToSend = result.pdfBytes;
                filledCount = result.filledCount;
            }

            const targetEntryId = currentEntry.id || selectedSubmissionId || "1";
            const rawBase = normalizeWpFormsUrl(customFormsUrl || wordpressFormsUrl);
            const restBase = rawBase.replace(/\/forms\/?$/, "");
            const uploadUrl = `${restBase}/entries/${targetEntryId}/pdf?send_notification=1`;

            const headers = {
                "Content-Type": "application/pdf",
                "ngrok-skip-browser-warning": "1",
            };
            const apiKeyToUse = customApiKey || wordpressApiKey;
            if (apiKeyToUse) {
                headers["X-PDF-API-Key"] = apiKeyToUse;
            }

            let wpRes;
            const isMixedContent = typeof window !== "undefined" && window.location.protocol === "https:" && uploadUrl.startsWith("http:");
            if (isMixedContent) {
                let proxyUrl = `/api/wp-proxy?url=${encodeURIComponent(uploadUrl)}`;
                if (apiKeyToUse) proxyUrl += `&apiKey=${encodeURIComponent(apiKeyToUse)}`;
                wpRes = await fetch(proxyUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/pdf" },
                    body: bytesToSend,
                });
            } else {
                try {
                    wpRes = await fetch(uploadUrl, {
                        method: "POST",
                        headers,
                        body: bytesToSend,
                    });
                } catch {
                    let proxyUrl = `/api/wp-proxy?url=${encodeURIComponent(uploadUrl)}`;
                    if (apiKeyToUse) proxyUrl += `&apiKey=${encodeURIComponent(apiKeyToUse)}`;
                    wpRes = await fetch(proxyUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/pdf" },
                        body: bytesToSend,
                    });
                }
            }

            if (!wpRes.ok) {
                const text = await wpRes.text();
                throw new Error(`WordPress rejected upload (${wpRes.status}): ${text.substring(0, 150)}`);
            }

            const json = await wpRes.json();
            setPushNotice(
                `Stored on WordPress: ${json.filename || `entry-${targetEntryId}.pdf`} (${filledCount} fields filled). Email notification dispatched!`
            );
        } catch (err) {
            console.error("Push to WordPress & Email failed:", err);
            setError(`Failed to push to WordPress & send email: ${err.message}`);
        } finally {
            setIsPushingToWp(false);
        }
    }, [currentEntry, generationResult, pdfBytes, mappings, flattenPdf, customFormsUrl, customApiKey, attachUploadedFiles, selectedSubmissionId, wordpressFormsUrl, wordpressApiKey]);

    // Close on ESC
    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (e) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isOpen, onClose]);

    // Cleanup generated blob URLs
    useEffect(() => {
        return () => {
            if (generationResult?.blobUrl) {
                URL.revokeObjectURL(generationResult.blobUrl);
            }
        };
    }, [generationResult]);

    if (!isOpen) return null;

    const isLiveWp = submissionSource.source === "wordpress_live";
    const downloadFilename = `Filled_${selectedTemplate?.templateId || "Template"}_Entry_${selectedSubmissionId || "test"}.pdf`;

    return (
        <div className="tester-overlay" onClick={onClose}>
            <div className="tester-container" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <header className="tester-header">
                    <div className="tester-header-title">
                        <span className="tester-kicker">PDF Generation Pipeline</span>
                        <h2>Test PDF Generation from WordPress Form Submission</h2>
                    </div>
                    <div className="tester-header-actions">
                        <button
                            type="button"
                            className="tester-close-btn"
                            onClick={onClose}
                            aria-label="Close tester"
                        >
                            <X size={15} />
                        </button>
                    </div>
                </header>

                <div className="tester-body">
                    {/* Left Sidebar: Submission Inspector & Controller */}
                    <aside className="tester-sidebar">
                        {/* Source & Form Info */}
                        <div className="tester-section-card">
                            <div className="tester-section-header">
                                <h3>Target Form & Template</h3>
                                <span className={`tester-badge ${isLiveWp ? "tester-badge-wp" : "tester-badge-sample"}`}>
                                    {isLiveWp ? "Live WordPress" : (submissionSource.source === "loading" ? "Connecting..." : "No Live Submissions")}
                                </span>
                            </div>
                            <div style={{ fontSize: "12px", color: "#475955", display: "flex", flexDirection: "column", gap: "4px" }}>
                                <div><strong>Form:</strong> {selectedForm?.title} (ID #{selectedForm?.id})</div>
                                <div><strong>Template:</strong> {selectedTemplate?.template?.filename}</div>
                                <div style={{ fontSize: "11px", color: "#6a7e78" }}>{submissionSource.message}</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowConnectionConfig((prev) => !prev)}
                                style={{
                                    marginTop: "4px",
                                    padding: "4px 8px",
                                    background: "#f0f6f4",
                                    border: "1px solid #c4ded5",
                                    borderRadius: "3px",
                                    color: "#176b50",
                                    fontSize: "11px",
                                    fontWeight: "700",
                                    cursor: "pointer",
                                    textAlign: "left",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "4px",
                                }}
                            >
                                {showConnectionConfig ? (
                                    <>
                                        <ChevronDown size={12} />
                                        <span>Hide Connection Settings</span>
                                    </>
                                ) : (
                                    <>
                                        <Settings size={12} />
                                        <span>Configure WordPress Connection</span>
                                    </>
                                )}
                            </button>
                            {showConnectionConfig && (
                                <form onSubmit={handleSaveConnection} style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "6px", padding: "8px", background: "#f8fbfa", border: "1px solid #d2e4de", borderRadius: "3px" }}>
                                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                        <label style={{ fontSize: "10px", fontWeight: "700", textTransform: "uppercase", color: "#506762" }}>WordPress REST URL</label>
                                        <input
                                            type="text"
                                            value={customFormsUrl}
                                            onChange={(e) => setCustomFormsUrl(e.target.value)}
                                            placeholder="https://fair-land.localsite.io/wp-json/pdf-generator/v1/forms"
                                            style={{ fontSize: "11px", padding: "5px 7px", border: "1px solid #c9dcd6", borderRadius: "2px" }}
                                        />
                                    </div>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                            <label style={{ fontSize: "10px", fontWeight: "700", textTransform: "uppercase", color: "#506762" }}>Live Link User</label>
                                            <input
                                                type="text"
                                                value={liveLinkUser}
                                                onChange={(e) => setLiveLinkUser(e.target.value)}
                                                placeholder="Username in LocalWP"
                                                style={{ fontSize: "11px", padding: "5px 7px", border: "1px solid #c9dcd6", borderRadius: "2px" }}
                                            />
                                        </div>
                                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                            <label style={{ fontSize: "10px", fontWeight: "700", textTransform: "uppercase", color: "#506762" }}>Live Link Password</label>
                                            <input
                                                type="password"
                                                value={liveLinkPass}
                                                onChange={(e) => setLiveLinkPass(e.target.value)}
                                                placeholder="Password in LocalWP"
                                                style={{ fontSize: "11px", padding: "5px 7px", border: "1px solid #c9dcd6", borderRadius: "2px" }}
                                            />
                                        </div>
                                    </div>
                                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                        <label style={{ fontSize: "10px", fontWeight: "700", textTransform: "uppercase", color: "#506762" }}>Plugin API Key (X-PDF-API-Key)</label>
                                        <input
                                            type="password"
                                            value={customApiKey}
                                            onChange={(e) => setCustomApiKey(e.target.value)}
                                            placeholder="Optional if admin or defined in wp-config.php"
                                            style={{ fontSize: "11px", padding: "5px 7px", border: "1px solid #c9dcd6", borderRadius: "2px" }}
                                        />
                                    </div>
                                    <div style={{ fontSize: "10px", color: "#788f89", lineHeight: "1.4" }}>
                                        LocalWP Live Links use HTTP Basic Auth. Enter the Username and Password shown under <strong>Tools &gt; Live Link</strong> in LocalWP.
                                    </div>
                                    <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                                        <button
                                            type="submit"
                                            style={{ flex: 1, padding: "5px 10px", background: "#176b50", color: "white", border: "none", borderRadius: "2px", fontSize: "11px", fontWeight: "700", cursor: "pointer" }}
                                        >
                                            Save & Re-test
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setShowConnectionConfig(false)}
                                            style={{ padding: "5px 10px", background: "white", color: "#425550", border: "1px solid #c9dcd6", borderRadius: "2px", fontSize: "11px", cursor: "pointer" }}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </form>
                            )}
                        </div>

                        {/* Submission Selector */}
                        <div className="tester-section-card">
                            <div className="tester-section-header">
                                <h3>Select Form Submission</h3>
                                <div style={{ display: "flex", gap: "8px" }}>
                                    <button
                                        type="button"
                                        onClick={() => loadSubmissions()}
                                        style={{ background: "none", border: "none", color: "#176b50", fontSize: "11px", fontWeight: "700", cursor: "pointer", textDecoration: "underline" }}
                                    >
                                        ↻ Refresh
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setActiveTab("json")}
                                        style={{ background: "none", border: "none", color: "#176b50", fontSize: "11px", fontWeight: "700", cursor: "pointer", textDecoration: "underline" }}
                                    >
                                        + Paste JSON
                                    </button>
                                </div>
                            </div>
                            {submissions.length > 0 ? (
                                <select
                                    className="tester-dropdown"
                                    value={selectedSubmissionId}
                                    onChange={(e) => handleSubmissionSelect(e.target.value)}
                                >
                                    {submissions.map((sub) => (
                                        <option key={sub.id} value={sub.id}>
                                            Entry #{sub.id} — {sub.submitter_name || `Entry ${sub.id}`} ({sub.date_created ? sub.date_created.split(" ")[0] : "Live"})
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <div style={{ padding: "8px 10px", background: "#f8fbfa", border: "1px dashed #c9ded6", borderRadius: "3px", fontSize: "11px", color: "#6a827c" }}>
                                    No live entries found on WordPress. Submit an entry in Gravity Forms to test.
                                </div>
                            )}
                        </div>

                        {/* Submission Values Live Editor */}
                        <div className="tester-section-card" style={{ flex: 1, minHeight: 0 }}>
                            <div className="tester-section-header">
                                <h3>Submission Values (Editable)</h3>
                                <span style={{ fontSize: "11px", color: "#778c86" }}>Live test inputs</span>
                            </div>
                            {currentEntry ? (
                                <div className="submission-fields-editor">
                                    <div className="submission-field-row">
                                        <label>Field 1 (First Name)</label>
                                        <input
                                            type="text"
                                            value={getDisplayFieldValue(currentEntry, "1", "firstName")}
                                            onChange={(e) => {
                                                handleFieldChange("1", e.target.value);
                                                handleFieldChange("1.3", e.target.value);
                                            }}
                                        />
                                    </div>
                                    <div className="submission-field-row">
                                        <label>Field 2 (Last Name)</label>
                                        <input
                                            type="text"
                                            value={getDisplayFieldValue(currentEntry, "2", "lastName")}
                                            onChange={(e) => {
                                                handleFieldChange("2", e.target.value);
                                                handleFieldChange("1.6", e.target.value);
                                            }}
                                        />
                                    </div>
                                    <div className="submission-field-row">
                                        <label>Field 3 (Date of Birth)</label>
                                        <input
                                            type="text"
                                            value={getDisplayFieldValue(currentEntry, "3", "dob")}
                                            onChange={(e) => handleFieldChange("3", e.target.value)}
                                        />
                                    </div>
                                    <div className="submission-field-row">
                                        <label>Field 4 / 19 (Address)</label>
                                        <input
                                            type="text"
                                            value={getDisplayFieldValue(currentEntry, "4.1", "address")}
                                            onChange={(e) => handleFieldChange("4.1", e.target.value)}
                                        />
                                    </div>
                                    <div className="submission-field-row">
                                        <label>Field 5 (Email)</label>
                                        <input
                                            type="email"
                                            value={getDisplayFieldValue(currentEntry, "5", "email")}
                                            onChange={(e) => handleFieldChange("5", e.target.value)}
                                        />
                                    </div>
                                    <div className="submission-field-row">
                                        <label>Field 6 (Phone Number)</label>
                                        <input
                                            type="text"
                                            value={getDisplayFieldValue(currentEntry, "6", "phone")}
                                            onChange={(e) => handleFieldChange("6", e.target.value)}
                                        />
                                    </div>
                                    <div className="submission-field-row">
                                        <label>Field 7 / 26 (USI Number)</label>
                                        <input
                                            type="text"
                                            value={getDisplayFieldValue(currentEntry, "7", "usi")}
                                            onChange={(e) => {
                                                handleFieldChange("7", e.target.value);
                                                handleFieldChange("26", e.target.value);
                                            }}
                                        />
                                    </div>
                                    <div className="submission-field-row">
                                        <label>Field 10 (Student Signature)</label>
                                        <input
                                            type="text"
                                            value={getDisplayFieldValue(currentEntry, "10", "signature")}
                                            onChange={(e) => handleFieldChange("10", e.target.value)}
                                        />
                                    </div>
                                    <div className="submission-field-row">
                                        <label>Field 11 (Date)</label>
                                        <input
                                            type="text"
                                            value={getDisplayFieldValue(currentEntry, "11", "date")}
                                            onChange={(e) => handleFieldChange("11", e.target.value)}
                                        />
                                    </div>
                                </div>
                            ) : (
                                <div style={{ fontSize: "12px", color: "#8a9a95" }}>No submission loaded.</div>
                            )}
                        </div>

                        {/* Generation Action */}
                        <button
                            type="button"
                            className="generate-btn"
                            onClick={runGeneration}
                            disabled={isGenerating || isPushingToWp || !pdfBytes || !currentEntry}
                            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                        >
                            {isGenerating ? (
                                <>
                                    <Loader2 size={13} className="animate-spin" />
                                    <span>Generating Filled PDF...</span>
                                </>
                            ) : (
                                <>
                                    <Zap size={13} />
                                    <span>Generate Filled PDF</span>
                                </>
                            )}
                        </button>

                        <button
                            type="button"
                            onClick={handlePushToWpAndEmail}
                            disabled={isGenerating || isPushingToWp || !currentEntry}
                            style={{
                                marginTop: "8px",
                                width: "100%",
                                padding: "10px 14px",
                                background: "#1d6fa5",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "4px",
                                fontSize: "13px",
                                fontWeight: "700",
                                cursor: (isGenerating || isPushingToWp || !currentEntry) ? "not-allowed" : "pointer",
                                opacity: (isGenerating || isPushingToWp || !currentEntry) ? 0.6 : 1,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: "6px",
                            }}
                        >
                            {isPushingToWp ? (
                                <>
                                    <Loader2 size={13} className="animate-spin" />
                                    <span>Pushing to WP & Sending Email...</span>
                                </>
                            ) : (
                                <>
                                    <Send size={13} />
                                    <span>Push PDF to WP & Email</span>
                                </>
                            )}
                        </button>

                        {pushNotice && (
                            <div style={{ padding: "8px 12px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "3px", color: "#166534", fontSize: "12px", marginTop: "8px", lineHeight: "1.4" }}>
                                {pushNotice}
                            </div>
                        )}

                        <div style={{ marginTop: "8px", padding: "8px 10px", background: "#f5faf7", border: "1px solid #d4e7df", borderRadius: "3px", fontSize: "11px", color: "#39524c" }}>
                            <label style={{ display: "flex", alignItems: "flex-start", gap: "6px", cursor: "pointer", fontWeight: "600" }}>
                                <input
                                    type="checkbox"
                                    checked={flattenPdf}
                                    onChange={(e) => setFlattenPdf(e.target.checked)}
                                    style={{ marginTop: "2px" }}
                                />
                                <div>
                                    <span>Flatten entire PDF (Static Non-Interactive)</span>
                                    <span style={{ display: "block", fontSize: "10px", fontWeight: "400", color: "#6a827c", marginTop: "2px", lineHeight: "1.3" }}>
                                        {flattenPdf
                                            ? "All fields including unmapped will be flattened to static print."
                                            : "Standard: Mapped fields are filled and locked (non-editable). Unmapped fields remain interactive and fillable."}
                                    </span>
                                </div>
                            </label>
                        </div>

                        <div style={{ marginTop: "8px", padding: "8px 10px", background: detectedUploadedFiles.length > 0 ? "#f2f7f9" : "#fafafa", border: `1px solid ${detectedUploadedFiles.length > 0 ? "#bcd7e0" : "#e5e5e5"}`, borderRadius: "3px", fontSize: "11px", color: "#2d444e" }}>
                            <label style={{ display: "flex", alignItems: "flex-start", gap: "6px", cursor: detectedUploadedFiles.length > 0 ? "pointer" : "default", fontWeight: "600" }}>
                                <input
                                    type="checkbox"
                                    checked={attachUploadedFiles}
                                    disabled={detectedUploadedFiles.length === 0}
                                    onChange={(e) => setAttachUploadedFiles(e.target.checked)}
                                    style={{ marginTop: "2px" }}
                                />
                                <div>
                                    <span>
                                        Attach & Embed Supporting Documents {detectedUploadedFiles.length > 0 ? `(${detectedUploadedFiles.length} detected)` : ""}
                                    </span>
                                    <span style={{ display: "block", fontSize: "10px", fontWeight: "400", color: "#546e7a", marginTop: "2px", lineHeight: "1.3" }}>
                                        {detectedUploadedFiles.length > 0
                                            ? `Embeds ${detectedUploadedFiles.map((f) => f.filename).join(", ")} directly into the PDF catalog (Acrobat paperclip attachments) and appends visual pages.`
                                            : "No uploaded files detected in this submission."}
                                    </span>
                                </div>
                            </label>
                        </div>

                        {error && (
                            <div style={{ padding: "8px 12px", background: "#fdf0ed", border: "1px solid #ecc9c2", borderRadius: "3px", color: "#a83220", fontSize: "12px" }}>
                                {error}
                            </div>
                        )}
                    </aside>

                    {/* Main Area: Preview & Audit Tabs */}
                    <main className="tester-main-panel">
                        {/* Toolbar */}
                        <div className="tester-toolbar">
                            <div className="tester-tab-group">
                                <button
                                    type="button"
                                    className={`tester-tab-btn ${activeTab === "preview" ? "is-active" : ""}`}
                                    onClick={() => setActiveTab("preview")}
                                >
                                    PDF Preview
                                </button>
                                <button
                                    type="button"
                                    className={`tester-tab-btn ${activeTab === "audit" ? "is-active" : ""}`}
                                    onClick={() => setActiveTab("audit")}
                                >
                                    Field Mapping Audit ({generationResult?.filledCount || 0} Filled)
                                </button>
                                <button
                                    type="button"
                                    className={`tester-tab-btn ${activeTab === "json" ? "is-active" : ""}`}
                                    onClick={() => setActiveTab("json")}
                                >
                                    Submission JSON
                                </button>
                            </div>

                            {generationResult && (
                                <div className="tester-actions-group">
                                    <button
                                        type="button"
                                        onClick={handlePushToWpAndEmail}
                                        disabled={isPushingToWp}
                                        className="action-secondary"
                                        style={{ background: "#1d6fa5", color: "#ffffff", borderColor: "#1d6fa5", fontWeight: "600", cursor: isPushingToWp ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: "5px" }}
                                    >
                                        <Send size={12} />
                                        {isPushingToWp ? "Pushing..." : "Push to WP & Email"}
                                    </button>
                                    <a
                                        href={generationResult.blobUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="action-secondary"
                                        style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
                                    >
                                        <ExternalLink size={12} />
                                        Open in New Tab
                                    </a>
                                    <a
                                        href={generationResult.blobUrl}
                                        download={downloadFilename}
                                        className="action-secondary"
                                        style={{ background: "#176b50", color: "white", borderColor: "#176b50", display: "inline-flex", alignItems: "center", gap: "5px" }}
                                    >
                                        <Download size={12} />
                                        Download Filled PDF
                                    </a>
                                </div>
                            )}
                        </div>

                        {/* Tab Contents */}
                        <div className="tester-preview-container">
                            {/* Tab 1: PDF Viewer */}
                            {activeTab === "preview" && (
                                generationResult?.blobUrl ? (
                                    <iframe
                                        title="Generated PDF Preview"
                                        src={generationResult.blobUrl}
                                        className="pdf-preview-frame"
                                    />
                                ) : (
                                    <div className="tester-empty-preview">
                                        <h4>Ready to test PDF generation</h4>
                                        <p>Click "Generate Filled PDF" to merge the WordPress submission into this PDF template.</p>
                                    </div>
                                )
                            )}

                            {/* Tab 2: Audit Table */}
                            {activeTab === "audit" && (
                                <div className="audit-table-wrapper">
                                    {generationResult?.attachedFiles && generationResult.attachedFiles.length > 0 && (
                                        <div style={{ marginBottom: "16px", padding: "12px 14px", background: "#f2f8f5", border: "1px solid #bde2d4", borderRadius: "4px", fontSize: "12px", color: "#194a3b" }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: "700", marginBottom: "6px" }}>
                                                <Paperclip size={13} />
                                                <span>Embedded Supporting Documents ({generationResult.attachedFiles.length})</span>
                                            </div>
                                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                                {generationResult.attachedFiles.map((file, i) => (
                                                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", background: "white", borderRadius: "3px", border: "1px solid #dbeae3" }}>
                                                        <span style={{ fontWeight: "600" }}>{file.filename}</span>
                                                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                            {file.pagesAppended && (
                                                                <span style={{ fontSize: "11px", color: "#546e7a" }}>
                                                                    +{file.pagesAppended} {file.pagesAppended === 1 ? "page" : "pages"} appended
                                                                </span>
                                                            )}
                                                            <span style={{ fontSize: "10px", fontWeight: "600", padding: "2px 6px", borderRadius: "10px", background: "#d1fae5", color: "#065f46", display: "inline-flex", alignItems: "center", gap: "3px" }}>
                                                                <Check size={10} />
                                                                Embedded in PDF
                                                            </span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    <table className="audit-table">
                                        <thead>
                                            <tr>
                                                <th>Target PDF Field</th>
                                                <th>Field Type</th>
                                                <th>Merged Value</th>
                                                <th>Source Mapping</th>
                                                <th>Fill Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(generationResult?.auditLog || []).map((row, idx) => (
                                                <tr key={idx}>
                                                    <td className="audit-field-name">{row.targetName}</td>
                                                    <td>{row.fieldType || "Field"}</td>
                                                    <td className="audit-value">
                                                        <strong>{row.value || "—"}</strong>
                                                    </td>
                                                    <td style={{ color: "#455955" }}>
                                                        {row.meta?.sourceLabel || "Direct mapping"}
                                                    </td>
                                                    <td>
                                                        <span className={`audit-status-tag ${row.status === "filled" ? "audit-status-filled" : "audit-status-not-found"}`}>
                                                            {row.status === "filled" ? "Filled" : row.status}
                                                        </span>
                                                    </td>
                                                </tr>
                                            ))}
                                            {(!generationResult?.auditLog || generationResult.auditLog.length === 0) && (
                                                <tr>
                                                    <td colSpan={5} style={{ textAlign: "center", padding: "30px", color: "#778c86" }}>
                                                        No generation log available yet. Generate a PDF to see the field fill audit.
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            {/* Tab 3: Raw Submission JSON */}
                            {activeTab === "json" && (
                                <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "white", border: "1px solid #c9d8d3", borderRadius: "3px", overflow: "hidden" }}>
                                    <div style={{ padding: "10px 14px", background: "#f4f8f5", borderBottom: "1px solid #dbe3e5", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                                        <div>
                                            <span style={{ fontSize: "11px", fontWeight: "700", fontFamily: "monospace", textTransform: "uppercase", color: "#4a5c5f" }}>
                                                Gravity Forms Entry Payload (Form ID {selectedForm?.id})
                                            </span>
                                            <span style={{ display: "block", fontSize: "11px", color: "#6e827d" }}>
                                                You can paste real submission data from WordPress or edit values below.
                                            </span>
                                        </div>
                                        <div style={{ display: "flex", gap: "8px" }}>
                                            <button
                                                type="button"
                                                className="action-secondary"
                                                onClick={() => navigator.clipboard?.writeText(rawJsonText)}
                                            >
                                                Copy JSON
                                            </button>
                                            <button
                                                type="button"
                                                style={{ background: "#176b50", color: "white", border: "none", borderRadius: "3px", padding: "6px 12px", fontSize: "12px", fontWeight: "700", cursor: "pointer" }}
                                                onClick={handleApplyJson}
                                            >
                                                Apply JSON & Test
                                            </button>
                                        </div>
                                    </div>
                                    {jsonParseError && (
                                        <div style={{ background: "#fff2f0", borderBottom: "1px solid #ffccc7", color: "#cf1322", padding: "8px 14px", fontSize: "12px" }}>
                                            {jsonParseError}
                                        </div>
                                    )}
                                    <textarea
                                        value={rawJsonText}
                                        onChange={(e) => {
                                            setRawJsonText(e.target.value);
                                            setJsonParseError("");
                                        }}
                                        spellCheck="false"
                                        style={{
                                            margin: 0,
                                            padding: "16px",
                                            flex: 1,
                                            resize: "none",
                                            border: "none",
                                            outline: "none",
                                            fontSize: "12px",
                                            fontFamily: "monospace",
                                            background: "#fdfdfd",
                                            color: "#18252d",
                                            lineHeight: "1.5",
                                        }}
                                        placeholder='Paste Gravity Forms entry JSON here: { "1": "Jane", "2": "Doe", ... }'
                                    />
                                </div>
                            )}
                        </div>
                    </main>
                </div>
            </div>
        </div>
    );
}
