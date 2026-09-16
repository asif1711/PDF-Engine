import { useEffect, useMemo, useState } from "react";
import {
    X,
    Settings,
    RefreshCw,
    Wand2,
    RotateCcw,
    Check,
    Play,
    ArrowRight,
    GitFork,
    Combine,
    Repeat,
    Clock,
} from "lucide-react";
import "./App.css";
import pdfTemplate from "../../NPA_Credit Transfer Forms_V2.1.pdf";
import PdfViewer from "./PdfViewer";
import SaveConfirmationModal from "./SaveConfirmationModal";
import PdfGenerationTester from "./PdfGenerationTester";
import WpConnectionModal from "./WpConnectionModal";
import TopNavigation from "./components/TopNavigation";
import TemplateIngestionPage from "./components/TemplateIngestionPage";
import AutomationDispatchPage from "./components/AutomationDispatchPage";
import WpConnectionManagerModal from "./components/WpConnectionManagerModal";
import TemplateIngestModal from "./components/TemplateIngestModal";
import WpSourceModal from "./components/WpSourceModal";
import TemplateEditModal from "./components/TemplateEditModal";
import JsonDatabaseModal from "./components/JsonDatabaseModal";
import {
    getWpConnections,
    getActiveWpConnection,
    setActiveWpConnectionId,
    testWpConnection,
    getPdfTemplates,
    getActivePdfTemplate,
    setActivePdfTemplateId,
    deleteWpConnection,
    deletePdfTemplate,
    DEFAULT_PDF_TEMPLATE,
    resolvePdfUrl,
    fetchPdfBytes,
} from "./connectionManager";
import { analyzePdfBytes } from "./templateAnalyzer";
import { extractEntryValue, resolvePreviewValue, formatDate, parseListRows } from "./pdfGenerator";
import { fetchFormSubmissions } from "./submissionService";
import {
    findFamily,
    findMatch,
    humanizePdfFieldName,
    indexedFamily,
    mappingKey,
    normalize,
    normalizeSavedMappings,
    normalizeWpFormsUrl,
} from "./mappingUtils";

const EMPTY_MAPPING = {};
const CANONICAL_MAPPINGS = import.meta.glob("../../mappings/**/*.json", { eager: true, import: "default" });
const WORDPRESS_FORMS_URL = import.meta.env.VITE_WORDPRESS_FORMS_URL || "https://tenisha-shapelier-elijah.ngrok-free.dev/wp-json/pdf-generator/v1/forms";
const WORDPRESS_API_KEY = import.meta.env.VITE_WORDPRESS_API_KEY || "aso107mzNrZId001GebX6ew8";

function templateId(template, fallback = "") {
    const raw =
        template?.templateId ||
        template?.id ||
        template?.template?.id ||
        template?.template?.filename ||
        template?.filename ||
        template?.name ||
        fallback;

    if (!raw) return fallback || "template-default";

    const cleaned = String(raw)
        .replace(/\.pdf$/i, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return cleaned || fallback || "template-default";
}

function toTemplateModel(t) {
    if (!t) return null;
    const baseId = t.id || templateId(t.analysis || t);
    const filename = t.filename || t.analysis?.template?.filename || t.name || `${baseId}.pdf`;
    const title = t.name || t.analysis?.template?.title || filename;

    const analysis = t.analysis
        ? { ...t.analysis }
        : {
              template: {
                  id: baseId,
                  filename,
                  title,
              },
              technical: {
                  pages: 1,
                  fieldCount: 0,
                  hasAcroForm: false,
              },
              schema: {
                  fields: [],
              },
              context: {
                  pages: [],
              },
          };

    if (!analysis.template) {
        analysis.template = {
            id: baseId,
            filename,
            title,
        };
    } else {
        analysis.template = {
            ...analysis.template,
            id: analysis.template.id || baseId,
            filename: analysis.template.filename || filename,
            title: analysis.template.title || title,
        };
    }

    if (!analysis.context) {
        analysis.context = { pages: [] };
    }

    const tId = t.templateId || templateId(analysis, baseId);

    return {
        ...analysis,
        id: t.id || tId,
        templateId: tId,
        url: t.url,
        category: t.category,
        sourceUrl: t.sourceUrl,
        cdnUrl: t.cdnUrl,
        filename,
    };
}

function pdfType(field) {
    const type = String(field?.type || "");
    if (type.includes("CheckBox")) return "Btn / checkbox";
    if (type.includes("Radio")) return "Btn / radio";
    if (type.includes("Dropdown")) return "Ch / dropdown";
    if (type.includes("List")) return "Ch / list";
    return "Tx / text";
}

function isRepeatable(field) {
    const type = String(field?.type || "").toLowerCase();
    const label = normalize(field?.label);
    return type === "list" || label.includes("listyourunit") || label.includes("unitsofcompetency");
}

function isRepeatCountField(field) {
    const label = normalize(field?.label);
    return label.includes("numberofunit") || label.includes("howmanyunit");
}

function isMappableField(field) {
    if (!field) return false;
    const type = String(field.type || "").toLowerCase();
    const visibility = String(field.visibility || "").toLowerCase();
    if (type === "hidden" || visibility === "hidden" || visibility === "administrative") return false;
    return true;
}

function fieldInputs(field) {
    if (Array.isArray(field?.inputs) && field.inputs.length) return field.inputs;
    return [];
}

function repeatInputs(field) {
    if (fieldInputs(field).length) return fieldInputs(field);
    if (isRepeatable(field) && Array.isArray(field?.choices)) {
        return field.choices.map((choice, index) => ({
            id: String(choice.value || `${field.id}.${index + 1}`),
            label: String(choice.text || choice.value || `Item ${index + 1}`),
        }));
    }
    return [];
}

function GravityFormPanel({ form, mappings, activeSource, onSelectSource, onRemoveMapping, onSelectSystem, activeSubmission, wpSyncInfo, isCheckingWp, onRefreshWp, onOpenWpConfig }) {
    if (!form) return <div className="source-empty">Unable to load Gravity Forms.</div>;

    const visibleFields = (form.fields || []).filter(isMappableField);

    function sourceButton(field, input = null) {
        const key = mappingKey(field.id, input?.id || "");
        const mapping = mappings[key];
        const isChildInput = Boolean(input);
        const sourceLabel = isChildInput
            ? (input.label ? `${input.label} (${field.label || "Field"})` : `${field.label || "Field"} - Input ${input.id}`)
            : (field.label || `Field ${field.id}`);
        const source = { key, field, input, label: sourceLabel };
        const selected = activeSource?.key === key || (activeSource?.mode === "compose" && activeSource.sources?.some((item) => item.key === key));
        const hasMapping = Boolean(mapping?.pdfField || mapping?.targets?.length || Object.values(mappings).some((item) => item?.sourceFieldId === String(field.id) && (!input || item.sourceInputId === String(input.id))));
        const sampleVal = extractEntryValue(activeSubmission, field.id, input?.id || "", input?.label || field.label);
        const strVal = sampleVal !== undefined && sampleVal !== null && typeof sampleVal !== "object" ? String(sampleVal).trim() : "";

        return <div className={`gravity-source-select ${selected ? "is-selected" : ""} ${hasMapping ? "is-mapped" : ""}`} key={key}>
            <button type="button" className="gravity-source-button" onClick={() => onSelectSource(source)}>
                <div className="source-btn-body">
                    <div className="source-label-row">
                        <span className="source-field-name">{isChildInput ? (input.label || `Input ${input.id}`) : (field.label || "Untitled field")}</span>
                        {isChildInput && <span className="source-parent-tag">of {field.label || `Field ${field.id}`}</span>}
                    </div>
                    <div className="technical-meta source-meta-row">
                        <span className="id-badge">
                            {isChildInput ? <>GF Input ID: <strong>{input.id}</strong></> : <>GF Field ID: <strong>{field.id}</strong></>}
                        </span>
                        {isChildInput ? (
                            <span className="parent-ref">Parent ID: {field.id}</span>
                        ) : (
                            <span className="field-type-pill">{field.type || "text"}</span>
                        )}
                        {mapping?.pdfField && (
                            <span className="mapped-target-hint">→ {mapping.pdfField}</span>
                        )}
                    </div>
                    {strVal ? (
                        <div className="source-sample-val">
                            <span className="sample-val-prefix">Sample:</span>
                            <code>{strVal.length > 28 ? strVal.slice(0, 25) + "…" : strVal}</code>
                        </div>
                    ) : null}
                </div>
                <span className="source-state">{hasMapping ? "Mapped" : selected ? "Target PDF" : "Select"}</span>
            </button>
            {hasMapping && (
                <button type="button" className="remove-mapping-button" onClick={() => onRemoveMapping(key)} title="Remove mapping">
                    <X size={12} />
                </button>
            )}
        </div>;
    }

    const sysDateVal = activeSubmission?.date_created || activeSubmission?.submitted_at ? formatDate(activeSubmission.date_created || activeSubmission.submitted_at) : "";

    return <div className="gravity-source-content">
        <div className="source-heading">
            <div className="source-heading-top">
                <span className="section-kicker">Gravity Forms Schema</span>
                <div className="wp-sync-controls">
                    {wpSyncInfo?.isLive ? (
                        <span className="wp-sync-status live" title={wpSyncInfo.message}>
                            <span className="sync-dot live" /> Live from WP
                        </span>
                    ) : (
                        <span className="wp-sync-status synced" title={wpSyncInfo?.message || "Schema verified with WP site"}>
                            <span className="sync-dot synced" /> Synced Schema
                        </span>
                    )}
                    <button
                        type="button"
                        className="wp-check-btn"
                        onClick={onRefreshWp}
                        disabled={isCheckingWp}
                        title="Fetch latest fields live from WordPress site"
                    >
                        <RefreshCw size={11} className={isCheckingWp ? "animate-spin" : ""} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                        {isCheckingWp ? "Checking WP…" : "Check WP"}
                    </button>
                    <button
                        type="button"
                        className="wp-config-toggle-btn"
                        onClick={onOpenWpConfig}
                        title="Configure WordPress endpoint connection"
                        aria-label="Configure WordPress endpoint connection"
                    >
                        <Settings size={12} />
                    </button>
                </div>
            </div>
            <h3 className="gf-form-name">{form.title || "Untitled Form"}</h3>
            <div className="form-summary-badges">
                <span className="id-badge">Form ID: <strong>{form.id}</strong></span>
                <span className="field-count-pill">{visibleFields.length} fields</span>
                {wpSyncInfo?.isLive ? (
                    <span className="source-origin-pill live">Live WordPress Connection</span>
                ) : (
                    <span className="source-origin-pill verified">Schema Verified</span>
                )}
            </div>
            {wpSyncInfo?.message && (
                <div className={`wp-sync-notice ${wpSyncInfo.isLive ? "is-live" : "is-fallback"}`}>
                    <span className="sync-msg-text">{wpSyncInfo.message}</span>
                </div>
            )}
            <p className="gf-panel-instruction">Select any Gravity Form field or sub-input below to map directly to a PDF field.</p>
        </div>
        <div className="system-source-list">
            <span className="section-kicker">System values</span>
            <button type="button" className={`system-source-button ${activeSource?.kind === "system" ? "is-selected" : ""}`} onClick={onSelectSystem}>
                <div className="source-btn-body">
                    <span className="source-field-name">Submission Date</span>
                    <div className="technical-meta source-meta-row">
                        <span className="id-badge">Key: <strong>submission.date_created</strong></span>
                    </div>
                    {sysDateVal ? <div className="source-sample-val"><span className="sample-val-prefix">Sample:</span><code>{sysDateVal}</code></div> : null}
                </div>
                <span className="source-state">{activeSource?.kind === "system" ? "Target PDF" : "Select"}</span>
            </button>
        </div>
        <div className="gravity-field-list">
            {visibleFields.map((field) => {
                const inputs = fieldInputs(field);
                const isCompound = inputs.length > 0;
                return <article className="gravity-source-field" key={field.id}>
                    <div className="gravity-source-summary">
                        <div className="field-title-block">
                            <div className="field-name-row">
                                <span className="field-label-text">{field.label || `Field ${field.id}`}</span>
                                {field.adminLabel && field.adminLabel !== field.label && (
                                    <span className="admin-label-tag" title="Gravity Forms Admin Label">({field.adminLabel})</span>
                                )}
                            </div>
                            <div className="field-tech-row">
                                <span className="id-badge">GF Field ID: <strong>{field.id}</strong></span>
                                <span className="field-type-pill">{field.type || "text"}</span>
                                {isCompound && <span className="compound-count-pill">{inputs.length} inputs</span>}
                                {field.choices && field.choices.length > 0 && !isCompound && (
                                    <span className="choice-count-pill">{field.choices.length} choices</span>
                                )}
                            </div>
                        </div>
                        {field.required && <span className="required-badge">Required</span>}
                    </div>
                    {isCompound ? (
                        <div className="gravity-input-list">
                            <div className="subfield-list-header">Sub-inputs for "{field.label || `Field ${field.id}`}":</div>
                            {inputs.map((input) => sourceButton(field, input))}
                        </div>
                    ) : (
                        sourceButton(field)
                    )}
                </article>;
            })}
        </div>
    </div>;
}

function compatible(gravityType, pdfField) {
    const type = String(gravityType || "").toLowerCase();
    const pdf = pdfType(pdfField);
    if (["checkbox", "radio"].includes(type)) return pdf.includes("checkbox") || pdf.includes("radio");
    if (["select", "multiselect"].includes(type)) return pdf.includes("dropdown") || pdf.includes("list") || pdf.includes("text");
    return pdf.includes("text");
}

function sourceDescriptor(source) {
    return source?.input
        ? { kind: "gravity_field", fieldId: String(source.field.id), inputId: String(source.input.id), label: source.label }
        : { kind: "gravity_field", fieldId: String(source.field.id), label: source.label };
}

function mappingTargets(mapping) {
    if (mapping?.type === "one_to_many") return mapping.targets || [];
    if (mapping?.target?.fieldName || mapping?.pdfField) return [{ kind: "pdf_field", fieldName: mapping.target?.fieldName || mapping.pdfField }];
    return [];
}

function mappingTargetNames(mapping, pdfFields) {
    const directTargets = mappingTargets(mapping).map((target) => target.fieldName);
    if (mapping?.type !== "repeat") return directTargets;
    const repeatTargets = (mapping.children || []).flatMap((child) => pdfFields
        .filter((field) => new RegExp(`^${String(child.targetPattern || "").replace("{index}", "\\d+")}$`).test(field.name))
        .map((field) => field.name));
    return [...directTargets, ...repeatTargets];
}

const SAMPLE_FORMS = [
    {
        id: "1",
        title: "Credit Transfer",
        fields: [
            {
                id: "1",
                label: "Student Name",
                type: "name",
                required: true,
                inputs: [
                    { id: "1.2", label: "Prefix" },
                    { id: "1.3", label: "First" },
                    { id: "1.4", label: "Middle" },
                    { id: "1.6", label: "Last" },
                    { id: "1.8", label: "Suffix" },
                ],
            },
            { id: "3", label: "Date of Birth", type: "date", required: true },
            {
                id: "19",
                label: "Address",
                type: "address",
                required: false,
                inputs: [
                    { id: "19.1", label: "Street Address" },
                    { id: "19.2", label: "Address Line 2" },
                    { id: "19.3", label: "City" },
                    { id: "19.4", label: "State / Province" },
                    { id: "19.5", label: "ZIP / Postal Code" },
                    { id: "19.6", label: "Country" },
                ],
            },
            { id: "26", label: "Student ID", type: "text", required: false },
            { id: "4", label: "Email Address", type: "email", required: true },
            { id: "5", label: "Mobile Number", type: "phone", required: true },
            {
                id: "34",
                label: "Faculty",
                type: "select",
                required: true,
                choices: [
                    { text: "Faculty of Business and Technology", value: "Faculty of Business and Technology" },
                    { text: "Faculty of Community Services", value: "Faculty of Community Services" },
                    { text: "Faculty of Engineering Technology", value: "Faculty of Engineering Technology" },
                    { text: "Faculty of English", value: "Faculty of English" },
                    { text: "Faculty of Hospitality", value: "Faculty of Hospitality" },
                ],
            },
            {
                id: "21",
                label: "Number of units",
                type: "select",
                required: true,
                choices: [
                    { text: "1", value: "1" },
                    { text: "2", value: "2" },
                    { text: "3", value: "3" },
                    { text: "4", value: "4" },
                    { text: "5", value: "5" },
                    { text: "6", value: "6" },
                    { text: "7", value: "7" },
                    { text: "8", value: "8" },
                    { text: "9", value: "9" },
                    { text: "10", value: "10" },
                ],
            },
            {
                id: "8",
                label: "List your units of competency",
                type: "list",
                required: true,
                choices: [
                    { text: "Unit Code", value: "Unit Code" },
                    { text: "Unit Name", value: "Unit Name" },
                ],
                inputs: [
                    { id: "8.1", label: "Unit Code" },
                    { id: "8.2", label: "Unit Name" },
                ],
            },
            {
                id: "13",
                label: "Supporting document Attachment checklist",
                type: "checkbox",
                required: true,
                choices: [
                    { text: "A certified copy of transcripts", value: "A certified copy of transcripts" },
                    { text: "A certified copy of statement of attainment", value: "A certified copy of statement of attainment" },
                    { text: "A certified copy of statement of results", value: "A certified copy of statement of results" },
                ],
            },
            { id: "15", label: "Upload Supporting Documents", type: "fileupload", required: true },
            { id: "16", label: "Declaration", type: "checkbox", required: true },
            { id: "28", label: "Total cost (including fees)", type: "product", required: false },
            { id: "22", label: "Amount to pay today", type: "total", required: false },
        ],
    },
];

async function loadGravityForms(options = {}) {
    const rawTargetUrl = options.url || localStorage.getItem("pfgf_custom_forms_url") || WORDPRESS_FORMS_URL;
    const targetUrl = normalizeWpFormsUrl(rawTargetUrl);
    const apiKey = options.apiKey !== undefined ? options.apiKey : (localStorage.getItem("pfgf_custom_api_key") || WORDPRESS_API_KEY);
    const basicUser = options.basicUser !== undefined ? options.basicUser : (localStorage.getItem("pfgf_livelink_user") || "");
    const basicPass = options.basicPass !== undefined ? options.basicPass : (localStorage.getItem("pfgf_livelink_pass") || "");

    console.info("Gravity Forms request configuration", {
        url: targetUrl,
        apiKeyConfigured: Boolean(apiKey),
        hasBasicAuth: Boolean(basicUser || basicPass),
    });

    if (!targetUrl) {
        return {
            forms: SAMPLE_FORMS,
            source: "sample",
            message: "No WordPress endpoint configured; using verified schema.",
            url: "",
            isLive: false,
        };
    }

    let requestUrl = targetUrl;
    if (requestUrl.includes("ngrok")) {
        const sep = requestUrl.includes("?") ? "&" : "?";
        if (!requestUrl.includes("ngrok-skip-browser-warning")) {
            requestUrl = `${requestUrl}${sep}ngrok-skip-browser-warning=true`;
        }
    }

    const headers = {
        Accept: "application/json",
    };
    if (apiKey) {
        headers["X-PDF-API-Key"] = apiKey;
    }
    if (basicUser || basicPass) {
        try {
            headers["Authorization"] = `Basic ${btoa(`${basicUser}:${basicPass}`)}`;
        } catch {
            // ignore
        }
    }

    let response;
    // Attempt via server-side /api/wp-proxy first to bypass ngrok browser warning & CORS
    try {
        let proxyQuery = `/api/wp-proxy?url=${encodeURIComponent(targetUrl)}`;
        if (apiKey) proxyQuery += `&apiKey=${encodeURIComponent(apiKey)}`;
        if (basicUser) proxyQuery += `&basicUser=${encodeURIComponent(basicUser)}`;
        if (basicPass) proxyQuery += `&basicPass=${encodeURIComponent(basicPass)}`;
        
        const proxyRes = await fetch(proxyQuery);
        if (proxyRes.ok) {
            response = proxyRes;
        }
    } catch {
        // Fall back to direct fetch below
    }

    if (!response) {
        try {
            response = await fetch(requestUrl, { headers });
        } catch (err) {
            const isMixedContent = typeof window !== "undefined" && window.location.protocol === "https:" && targetUrl.startsWith("http://");
            const msg = isMixedContent
                ? `Browser blocked HTTP request to ${targetUrl} (Mixed Content). Use LocalWP Live Link (HTTPS) or a secure tunnel.`
                : `Could not connect to ${targetUrl} (${err.message}).`;
            console.warn("Could not connect to WordPress connector:", msg);
            return {
                forms: SAMPLE_FORMS,
                source: "network_error",
                message: msg,
                url: targetUrl,
                isLive: false,
            };
        }
    }

    if (response.status === 401 || response.status === 403) {
        const msg = `WordPress authentication failed (${response.status}). Check API key or Live Link credentials.`;
        console.warn("Gravity Forms response status", response.status);
        return {
            forms: SAMPLE_FORMS,
            source: "auth_error",
            message: msg,
            url: targetUrl,
            isLive: false,
        };
    }

    if (!response.ok) {
        const msg = `HTTP ${response.status} returned from WordPress endpoint.`;
        console.warn("Gravity Forms HTTP status", response.status);
        return {
            forms: SAMPLE_FORMS,
            source: "http_error",
            message: msg,
            url: targetUrl,
            isLive: false,
        };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        const msg = `WordPress endpoint returned non-JSON response (${contentType}). Ensure gravity-forms-reader.php is activated.`;
        console.warn(msg);
        return {
            forms: SAMPLE_FORMS,
            source: "invalid_response",
            message: msg,
            url: targetUrl,
            isLive: false,
        };
    }

    let data;
    try {
        data = await response.json();
    } catch {
        return {
            forms: SAMPLE_FORMS,
            source: "invalid_json",
            message: "Failed to parse JSON response from WordPress connector.",
            url: targetUrl,
            isLive: false,
        };
    }

    if (!data || !Array.isArray(data.forms) || data.forms.length === 0) {
        return {
            forms: SAMPLE_FORMS,
            source: "empty_forms",
            message: "WordPress connector returned no forms.",
            url: targetUrl,
            isLive: false,
        };
    }

    return {
        forms: data.forms,
        source: "live_wp",
        message: `Successfully loaded ${data.forms.length} form(s) live from WordPress (${targetUrl}).`,
        url: targetUrl,
        isLive: true,
    };
}

function App() {
    // 3-page routing state (/analyze, /mapper, /automation)
    const [currentRoute, setCurrentRoute] = useState(() => {
        const path = window.location.pathname.toLowerCase();
        if (path.includes("analyze")) return "/analyze";
        if (path.includes("automation")) return "/automation";
        return "/mapper";
    });

    const navigate = (path) => {
        window.history.pushState(null, "", path);
        setCurrentRoute(path);
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    useEffect(() => {
        const handlePopState = () => {
            const path = window.location.pathname.toLowerCase();
            if (path.includes("analyze")) setCurrentRoute("/analyze");
            else if (path.includes("automation")) setCurrentRoute("/automation");
            else setCurrentRoute("/mapper");
        };
        window.addEventListener("popstate", handlePopState);
        return () => window.removeEventListener("popstate", handlePopState);
    }, []);

    // WordPress Connections State
    const [wpConnections, setWpConnections] = useState(() => getWpConnections());
    const [activeWpConn, setActiveWpConn] = useState(() => getActiveWpConnection());
    const [wpConnStatus, setWpConnStatus] = useState({ ok: true, loading: false, formsCount: 1, message: "Connected" });
    const [isWpManagerOpen, setIsWpManagerOpen] = useState(false);
    const [isWpSourceModalOpen, setIsWpSourceModalOpen] = useState(false);
    const [wpSourceModalConn, setWpSourceModalConn] = useState(null);
    const [isJsonDbModalOpen, setIsJsonDbModalOpen] = useState(false);

    // PDF Templates State
    const [pdfTemplatesList, setPdfTemplatesList] = useState(() => getPdfTemplates());
    const [activePdfTemplate, setActivePdfTemplate] = useState(() => getActivePdfTemplate());
    const [isTplModalOpen, setIsTplModalOpen] = useState(false);
    const [isTplEditModalOpen, setIsTplEditModalOpen] = useState(false);
    const [pdfTemplateToEdit, setPdfTemplateToEdit] = useState(null);

    const [templates, setTemplates] = useState([]);
    const [forms, setForms] = useState([]);
    const [selectedTemplate, setSelectedTemplate] = useState(null);
    const [selectedForm, setSelectedForm] = useState(null);
    const [mappings, setMappings] = useState(EMPTY_MAPPING);
    const [loading, setLoading] = useState({ templates: true, forms: true, mapping: false });
    const [errors, setErrors] = useState({ templates: "", forms: "", mapping: "", save: "" });
    const [savedMessage, setSavedMessage] = useState("");
    const [showJson, setShowJson] = useState(false);
    const [activeSource, setActiveSource] = useState(null);
    const [mappingMode, setMappingMode] = useState("direct");
    const [composeSources, setComposeSources] = useState([]);
    const [composeLiteral, setComposeLiteral] = useState(" ");
    const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");
    const [oneManySource, setOneManySource] = useState(null);
    const [oneManyTargets, setOneManyTargets] = useState([]);
    const [editingMappingKey, setEditingMappingKey] = useState(null);
    const [savedModalInfo, setSavedModalInfo] = useState(null);
    const [isSavedModalOpen, setIsSavedModalOpen] = useState(false);
    const [isTesterOpen, setIsTesterOpen] = useState(false);
    const [liveSubmissionsList, setLiveSubmissionsList] = useState([]);
    const [isLoadingSubmissions, setIsLoadingSubmissions] = useState(false);
    const [selectedSubmissionId, setSelectedSubmissionId] = useState("");
    const [activeSubmission, setActiveSubmission] = useState(null);
    const [wpSyncInfo, setWpSyncInfo] = useState({
        source: "loading",
        message: "",
        url: WORDPRESS_FORMS_URL,
        isLive: false,
    });
    const [isCheckingWp, setIsCheckingWp] = useState(false);
    const [showWpConfig, setShowWpConfig] = useState(false);

    const currentPdfSource = resolvePdfUrl(selectedTemplate || activePdfTemplate) || pdfTemplate;
    const [isAnalyzingTemplate, setIsAnalyzingTemplate] = useState(false);

    useEffect(() => {
        if (!selectedTemplate) return;
        const hasFields = (selectedTemplate?.technical?.fields || []).length > 0;
        const hasContext = (selectedTemplate?.context?.pages || []).length > 0;
        if (hasFields && hasContext) return;

        let cancelled = false;

        async function analyzeCurrentTemplate() {
            setIsAnalyzingTemplate(true);
            try {
                const category = selectedTemplate.category || activePdfTemplate?.category || "AIBT";
                const filename = selectedTemplate.template?.filename || selectedTemplate.filename || activePdfTemplate?.filename || "";
                const cleanBase = filename.replace(/%20/g, "_").replace(/ /g, "_").replace(/\.pdf$/i, "");

                // 1. Check if a pre-generated analysis JSON exists on the server
                if (cleanBase) {
                    try {
                        const jsonRes = await fetch(`/templates/${encodeURIComponent(category)}/${encodeURIComponent(cleanBase)}-analysis.json`);
                        if (jsonRes.ok) {
                            const cached = await jsonRes.json();
                            if (!cancelled && cached?.technical && cached?.context) {
                                setSelectedTemplate((curr) => {
                                    if (!curr) return curr;
                                    return {
                                        ...curr,
                                        ...cached,
                                        technical: cached.technical,
                                        context: cached.context,
                                        schema: cached.schema || { fields: cached.technical.fields },
                                        analysis: cached,
                                    };
                                });
                                setPdfTemplatesList((currList) =>
                                    currList.map((item) =>
                                        item.id === selectedTemplate.id || item.filename === filename
                                            ? { ...item, analysis: cached }
                                            : item
                                    )
                                );
                                return;
                            }
                        }
                    } catch {
                        // proceed to client-side analysis
                    }
                }

                // 2. Fetch bytes and analyze dynamically in browser
                const res = await fetchPdfBytes(selectedTemplate || activePdfTemplate);
                if (cancelled || !res?.bytes) return;

                const analysis = await analyzePdfBytes(res.bytes, filename || "template.pdf");
                if (cancelled) return;

                setSelectedTemplate((curr) => {
                    if (!curr) return curr;
                    return {
                        ...curr,
                        ...analysis,
                        technical: analysis.technical,
                        context: analysis.context,
                        schema: analysis.schema,
                        url: res.successfulUrl || curr.url,
                        analysis,
                    };
                });

                setPdfTemplatesList((currList) =>
                    currList.map((item) =>
                        item.id === selectedTemplate.id || item.filename === filename
                            ? { ...item, analysis, url: res.successfulUrl || item.url }
                            : item
                    )
                );
            } catch (err) {
                console.warn("Dynamic template analysis error:", err);
            } finally {
                if (!cancelled) setIsAnalyzingTemplate(false);
            }
        }

        analyzeCurrentTemplate();
        return () => {
            cancelled = true;
        };
    }, [selectedTemplate?.id, selectedTemplate?.templateId, selectedTemplate?.template?.filename]);

    useEffect(() => {
        if (!selectedForm) {
            setLiveSubmissionsList([]);
            setActiveSubmission(null);
            return;
        }

        let isSubscribed = true;
        setIsLoadingSubmissions(true);

        const customUrl = localStorage.getItem("pfgf_custom_forms_url") || WORDPRESS_FORMS_URL;
        const customKey = localStorage.getItem("pfgf_custom_api_key") || WORDPRESS_API_KEY;
        const liveUser = localStorage.getItem("pfgf_livelink_user") || "";
        const livePass = localStorage.getItem("pfgf_livelink_pass") || "";

        fetchFormSubmissions(
            selectedForm.id,
            customUrl,
            customKey,
            { basicAuthUser: liveUser, basicAuthPass: livePass }
        ).then((res) => {
            if (!isSubscribed) return;
            const entries = res.entries || [];
            setLiveSubmissionsList(entries);
            if (entries.length > 0) {
                setSelectedSubmissionId(String(entries[0].id));
                setActiveSubmission(entries[0]);
            } else {
                setSelectedSubmissionId("");
                setActiveSubmission(null);
            }
        }).catch((err) => {
            console.warn("Could not fetch live entries:", err);
            if (!isSubscribed) return;
            setLiveSubmissionsList([]);
            setActiveSubmission(null);
        }).finally(() => {
            if (isSubscribed) setIsLoadingSubmissions(false);
        });

        return () => {
            isSubscribed = false;
        };
    }, [selectedForm, wpSyncInfo.isLive]);

    function handleSelectSubmission(subId) {
        setSelectedSubmissionId(subId);
        const found = liveSubmissionsList.find((s) => String(s.id) === String(subId));
        if (found) setActiveSubmission(found);
    }

    async function loadData(options = {}) {
        setLoading({ templates: true, forms: true, mapping: false });
        setErrors({ templates: "", forms: "", mapping: "", save: "" });

        // Load templates from registry
        const tpls = getPdfTemplates();
        setPdfTemplatesList(tpls);
        const currentActiveTpl = getActivePdfTemplate();
        setActivePdfTemplate(currentActiveTpl);
        const mappedTpls = tpls.map(toTemplateModel).filter(Boolean);
        setTemplates(mappedTpls);
        const activeTplObj = toTemplateModel(currentActiveTpl) || mappedTpls[0];
        setSelectedTemplate(activeTplObj);

        const conn = options.conn || activeWpConn;
        const targetUrl = options.url || conn?.url || WORDPRESS_FORMS_URL;
        const targetKey = options.apiKey !== undefined ? options.apiKey : (conn?.apiKey || WORDPRESS_API_KEY);
        const targetUser = options.basicUser !== undefined ? options.basicUser : (conn?.basicUser || "");
        const targetPass = options.basicPass !== undefined ? options.basicPass : (conn?.basicPass || "");

        try {
            const syncResult = await loadGravityForms({
                url: targetUrl,
                apiKey: targetKey,
                basicUser: targetUser,
                basicPass: targetPass,
            });
            setForms(syncResult.forms);
            setSelectedForm(syncResult.forms[0] || null);
            setWpSyncInfo({
                source: syncResult.source,
                message: syncResult.message,
                url: syncResult.url,
                isLive: syncResult.isLive,
            });
            setWpConnStatus({
                ok: syncResult.isLive,
                loading: false,
                formsCount: syncResult.forms.length,
                message: syncResult.message,
            });
        } catch (error) {
            setForms(SAMPLE_FORMS);
            setSelectedForm(SAMPLE_FORMS[0] || null);
            setErrors((current) => ({ ...current, forms: error.message }));
            setWpSyncInfo({
                source: "error",
                message: error.message,
                url: targetUrl,
                isLive: false,
            });
            setWpConnStatus({
                ok: false,
                loading: false,
                formsCount: 0,
                message: error.message,
            });
        }
        setLoading({ templates: false, forms: false, mapping: false });
    }

    function handleSelectWpConn(connId) {
        const found = wpConnections.find((c) => c.id === connId);
        if (found) {
            setActiveWpConn(found);
            setActiveWpConnectionId(found.id);
            loadData({ conn: found });
            testWpConnection(found).then((res) => {
                setWpConnStatus({
                    ok: res.ok,
                    loading: false,
                    formsCount: res.formsCount ?? 0,
                    message: res.message,
                });
            });
        }
    }

    async function handleTestActiveWpConn() {
        if (!activeWpConn) return;
        setWpConnStatus((prev) => ({ ...prev, loading: true }));
        try {
            const res = await testWpConnection(activeWpConn);
            setWpConnStatus({
                ok: res.ok,
                loading: false,
                formsCount: res.formsCount ?? forms.length,
                message: res.message,
            });
            if (res.ok && Array.isArray(res.forms) && res.forms.length > 0) {
                setForms(res.forms);
            }
        } catch (err) {
            setWpConnStatus({
                ok: false,
                loading: false,
                formsCount: 0,
                message: err.message,
            });
        }
    }

    function handleSelectPdfTemplate(tplId) {
        const found = pdfTemplatesList.find((t) => t.id === tplId);
        if (found) {
            setActivePdfTemplate(found);
            setActivePdfTemplateId(found.id);
            const tplObj = toTemplateModel(found);
            setSelectedTemplate(tplObj);
        }
    }

    function handleAddWpConn() {
        setWpSourceModalConn(null);
        setIsWpSourceModalOpen(true);
    }

    function handleEditWpConn(conn) {
        setWpSourceModalConn(conn || activeWpConn);
        setIsWpSourceModalOpen(true);
    }

    function handleRemoveWpConn(connIdToRemove) {
        const targetId = connIdToRemove || activeWpConn?.id;
        if (!targetId) return;
        if (wpConnections.length <= 1) {
            alert("At least one WordPress connection must remain.");
            return;
        }
        const connToRemove = wpConnections.find((c) => c.id === targetId);
        const confirmed = window.confirm(`Are you sure you want to remove Gravity Form source "${connToRemove?.name || targetId}"?`);
        if (!confirmed) return;

        const updated = deleteWpConnection(targetId);
        setWpConnections(updated);
        if (activeWpConn?.id === targetId) {
            const nextConn = updated[0];
            setActiveWpConn(nextConn);
            setActiveWpConnectionId(nextConn.id);
            loadData({ conn: nextConn });
        }
    }

    function handleAddPdfTemplate() {
        setIsTplModalOpen(true);
    }

    function handleEditPdfTemplate(tplToEdit) {
        setPdfTemplateToEdit(tplToEdit || activePdfTemplate);
        setIsTplEditModalOpen(true);
    }

    function handleRemovePdfTemplate(tplIdToRemove) {
        const targetId = tplIdToRemove || activePdfTemplate?.id;
        if (!targetId) return;
        if (targetId === "default-npa" || targetId === "npa-credit-transfer-default") {
            alert("The built-in default NPA template cannot be deleted.");
            return;
        }
        const tplToRemove = pdfTemplatesList.find((t) => t.id === targetId);
        const confirmed = window.confirm(`Are you sure you want to remove PDF template "${tplToRemove?.name || tplToRemove?.filename || targetId}"?`);
        if (!confirmed) return;

        const updated = deletePdfTemplate(targetId);
        setPdfTemplatesList(updated);
        if (activePdfTemplate?.id === targetId) {
            const nextTpl = updated[0] || DEFAULT_PDF_TEMPLATE;
            setActivePdfTemplate(nextTpl);
            setActivePdfTemplateId(nextTpl.id);
            const tplObj = toTemplateModel(nextTpl);
            setSelectedTemplate(tplObj);
        }
    }

    async function handleRefreshWp(customOptions = {}) {
        setIsCheckingWp(true);
        try {
            const syncResult = await loadGravityForms(customOptions);
            setForms(syncResult.forms);
            if (syncResult.forms.length > 0) {
                setSelectedForm((prev) => {
                    const match = syncResult.forms.find((f) => String(f.id) === String(prev?.id));
                    return match || syncResult.forms[0];
                });
            }
            setWpSyncInfo({
                source: syncResult.source,
                message: syncResult.message,
                url: syncResult.url,
                isLive: syncResult.isLive,
            });
        } catch (err) {
            setWpSyncInfo({
                source: "error",
                message: err.message,
                url: WORDPRESS_FORMS_URL,
                isLive: false,
            });
        } finally {
            setIsCheckingWp(false);
        }
    }

    useEffect(() => { loadData(); }, []);

    const rawPdfFields = useMemo(() => selectedTemplate?.technical?.fields || [], [selectedTemplate]);
    const contextFields = useMemo(() => Object.fromEntries((selectedTemplate?.context?.pages || []).flatMap((page) => (page.fields || []).map((field) => [field.name, { page: page.page }]))), [selectedTemplate]);
    const pdfFields = useMemo(() => rawPdfFields.map((field) => ({ ...field, ...(contextFields[field.name] || {}) })), [rawPdfFields, contextFields]);
    const pdfFieldByName = useMemo(() => Object.fromEntries(pdfFields.map((field) => [field.name, field])), [pdfFields]);
    const pdfFamilies = useMemo(() => {
        const families = new Map();
        pdfFields.forEach((field) => {
            const family = indexedFamily(field);
            if (!family) return;
            const current = families.get(family.key) || { ...family, capacity: 0, fields: [] };
            current.capacity = Math.max(current.capacity, family.index);
            current.fields.push(field);
            families.set(family.key, current);
        });
        return [...families.values()].filter((family) => family.capacity > 1);
    }, [pdfFields]);
    const gravityFields = useMemo(() => (selectedForm?.fields || []).filter(isMappableField), [selectedForm]);
    const repeatGroups = gravityFields.filter(isRepeatable);
    const repeatCountFields = gravityFields.filter(isRepeatCountField);
    const directFields = gravityFields.filter((field) => !isRepeatable(field) && !fieldInputs(field).length);
    const compoundFields = gravityFields.filter((field) => !isRepeatable(field) && fieldInputs(field).length);
    const selectedTemplateId = selectedTemplate?.templateId || "";
    const mappedEntries = Object.entries(mappings).filter(([, item]) => item && (item.pdfField || item.target?.fieldName || item.children?.length || item.targets?.length)).map(([key, item]) => ({ key, ...item }));
    const mappedPdfFields = useMemo(() => new Set(mappedEntries.flatMap((item) => mappingTargetNames(item, pdfFields))), [mappedEntries, pdfFields]);
    const mappedCount = mappedEntries.length;
    const allMappedTargets = mappedEntries.flatMap((item) => mappingTargetNames(item, pdfFields));
    const duplicateConflict = allMappedTargets.length !== new Set(allMappedTargets).size;
    const mappedByPdf = useMemo(() => Object.fromEntries(mappedEntries.flatMap((item) => {
        const targetNames = mappingTargetNames(item, pdfFields);
        if (targetNames.length) return targetNames.map((targetName) => [targetName, item.inputLabel || item.gravityFieldLabel || item.sourceFieldId || "Mapped"]);
        return (item.targets || []).map((targetItem) => [targetItem.fieldName, item.gravityFieldLabel || "Mapped"]);
    })), [mappedEntries, pdfFields]);

    const mappedDetailsByPdf = useMemo(() => {
        const details = {};
        mappedEntries.forEach((item) => {
            const targetNames = mappingTargetNames(item, pdfFields);
            const val = resolvePreviewValue(activeSubmission, item);
            const gfId = item.type === "system"
                ? "submission.date_created"
                : item.type === "compose"
                ? (item.sources || []).map((s) => s.inputId || s.fieldId).join(" + ")
                : item.type === "repeat"
                ? `${item.sourceFieldId || item.gravityFieldId}`
                : item.sourceInputId || item.sourceFieldId || item.source?.fieldId || "";

            targetNames.forEach((targetName) => {
                details[targetName] = {
                    key: item.key,
                    mapping: item,
                    label: item.inputLabel
                        ? `[GF ID: ${gfId}] ${item.gravityFieldLabel || "Field"} — ${item.inputLabel}`
                        : `[GF ID: ${gfId}] ${item.gravityFieldLabel || item.sourceFieldId || "Mapped"}`,
                    type: item.type,
                    sourceFieldId: item.sourceFieldId,
                    sourceInputId: item.sourceInputId,
                    gfFieldId: gfId,
                    mappedValue: val,
                };
            });
            (item.targets || []).forEach((targetItem) => {
                if (!details[targetItem.fieldName]) {
                    details[targetItem.fieldName] = {
                        key: item.key,
                        mapping: item,
                        label: `[GF ID: ${gfId}] ${item.gravityFieldLabel || "Mapped"}`,
                        type: item.type,
                        sourceFieldId: item.sourceFieldId,
                        sourceInputId: item.sourceInputId,
                        gfFieldId: gfId,
                        mappedValue: val,
                    };
                }
            });
        });
        return details;
    }, [mappedEntries, pdfFields, activeSubmission]);

    const sourceOptions = useMemo(() => {
        const options = [];
        directFields.forEach((field) => {
            const val = extractEntryValue(activeSubmission, field.id, "", field.label);
            const strVal = val !== undefined && val !== null && typeof val !== "object" ? String(val).trim() : "";
            options.push({
                key: String(field.id),
                id: String(field.id),
                label: `GF Field ID: ${field.id} — ${field.label || "Untitled field"}${strVal ? ` (Value: "${strVal}")` : ""}`,
                type: field.type,
            });
        });
        compoundFields.forEach((field) => {
            fieldInputs(field).forEach((input) => {
                const val = extractEntryValue(activeSubmission, field.id, input.id, input.label);
                const strVal = val !== undefined && val !== null && typeof val !== "object" ? String(val).trim() : "";
                options.push({
                    key: `${field.id}:${input.id}`,
                    id: `${field.id}.${input.id}`,
                    label: `GF Input ID: ${input.id} — ${field.label}: ${input.label}${strVal ? ` (Value: "${strVal}")` : ""}`,
                    type: field.type,
                });
            });
        });
        const sysVal = activeSubmission?.date_created ? formatDate(activeSubmission.date_created) : "";
        options.push({
            key: "system:submission.date_created",
            id: "system",
            label: `System Key: submission.date_created (Submission Date)${sysVal ? ` (Value: "${sysVal}")` : ""}`,
            type: "system",
        });
        return options;
    }, [directFields, compoundFields, activeSubmission]);

    useEffect(() => {
        async function loadMapping() {
            if (!selectedForm || !selectedTemplateId) return;
            setLoading((current) => ({ ...current, mapping: true }));
            setErrors((current) => ({ ...current, mapping: "" }));
            try {
                let configToLoad = null;
                try {
                    const res = await fetch(`/api/mappings?formId=${encodeURIComponent(selectedForm.id)}&templateId=${encodeURIComponent(selectedTemplateId)}`);
                    if (res.ok) {
                        configToLoad = await res.json();
                    }
                } catch (fetchErr) {
                    console.warn("Could not fetch mapping from /api/mappings:", fetchErr);
                }

                if (!configToLoad) {
                    const canonicalKey = `../../mappings/form-${selectedForm.id}/${selectedTemplateId}.json`;
                    configToLoad = CANONICAL_MAPPINGS[canonicalKey] || null;
                }

                if (!configToLoad) {
                    setMappings(EMPTY_MAPPING);
                    return;
                }
                setMappings(normalizeSavedMappings(configToLoad));
            } catch (error) {
                setMappings(EMPTY_MAPPING);
                setErrors((current) => ({ ...current, mapping: error.message }));
            } finally {
                setLoading((current) => ({ ...current, mapping: false }));
            }
        }
        loadMapping();
    }, [selectedForm, selectedTemplateId, pdfFields]);

    function setMapping(key, value) {
        setMappings((current) => ({ ...current, [key]: value || undefined }));
    }

    function buildMappingPayload(mappingState) {
        if (!selectedForm || !selectedTemplate) return null;
        const entries = Object.values(mappingState).filter((item) => item && (item.pdfField || item.target?.fieldName || item.children?.length || item.targets?.length));
        const payload = {
            formId: String(selectedForm.id),
            formTitle: selectedForm.title,
            templateId: selectedTemplateId,
            templateFilename: selectedTemplate.template?.filename || "Template.pdf",
            source: "gravity_forms",
            savedAt: new Date().toISOString(),
            mappings: entries.map((item) => ({ ...item, pdfFieldData: undefined })),
        };
        return {
            formId: String(selectedForm.id),
            formTitle: selectedForm.title,
            templateId: selectedTemplateId,
            templateFilename: selectedTemplate.template?.filename || "Template.pdf",
            jsonFilePath: `mappings/form-${selectedForm.id}/${selectedTemplateId}.json`,
            mappedCount: entries.length,
            totalFormFields: gravityFields.length,
            payload,
        };
    }

    function removeMapping(key) {
        const [sourceFieldId, sourceInputId] = String(key).split(":");
        const keysToRemove = mappings[key]
            ? [key]
            : Object.entries(mappings).filter(([, item]) => item?.sourceFieldId === String(activeSource?.field?.id || sourceFieldId) && (!activeSource?.input && !sourceInputId || item.sourceInputId === String(activeSource?.input?.id || sourceInputId))).map(([itemKey]) => itemKey);
        const nextMappings = { ...mappings };
        keysToRemove.forEach((itemKey) => { nextMappings[itemKey] = undefined; });
        setMappings(nextMappings);
        setActiveSource(null);
    }

    function removePdfMapping(pdfFieldName) {
        const entry = mappedEntries.find((item) => mappingTargetNames(item, pdfFields).includes(pdfFieldName));
        if (!entry) return;

        if (entry.type === "one_to_many" && entry.targets && entry.targets.length > 1) {
            const nextTargets = entry.targets.filter((t) => t.fieldName !== pdfFieldName);
            const nextMappings = { ...mappings, [entry.key]: { ...entry, targets: nextTargets } };
            setMappings(nextMappings);
            return;
        }

        if (entry.type === "repeat") {
            const nextChildren = (entry.children || []).filter((child) => {
                const regex = new RegExp(`^${String(child.targetPattern || "").replace("{index}", "\\d+")}$`);
                return !regex.test(pdfFieldName);
            });
            const nextRepeat = nextChildren.length > 0
                ? { ...entry, children: nextChildren, target: { ...entry.target, children: nextChildren } }
                : undefined;
            const nextMappings = { ...mappings, [entry.key]: nextRepeat };
            setMappings(nextMappings);
            return;
        }

        removeMapping(entry.key);
    }

    function reassignPdfMapping(pdfFieldName, newSourceKey) {
        if (!newSourceKey) {
            removePdfMapping(pdfFieldName);
            return;
        }
        removePdfMapping(pdfFieldName);

        const directField = directFields.find((f) => String(f.id) === String(newSourceKey));
        if (directField) {
            updateMapping(directField, pdfFieldName);
            return;
        }

        const [fieldId, inputId] = String(newSourceKey).split(":");
        const compoundField = compoundFields.find((f) => String(f.id) === fieldId);
        if (compoundField) {
            const input = fieldInputs(compoundField).find((inp) => String(inp.id) === inputId);
            if (input) {
                updateCompoundMapping(compoundField, input, pdfFieldName);
                return;
            }
        }

        if (newSourceKey === "system:submission.date_created") {
            const key = `system:${pdfFieldName}`;
            const newMapping = {
                type: "system",
                source: { kind: "system", value: "submission.date_created", format: dateFormat },
                target: { kind: "pdf_field", fieldName: pdfFieldName },
                pdfField: pdfFieldName,
                targetField: pdfFieldName,
                gravityFieldLabel: "Submission Date",
            };
            const nextMappings = { ...mappings, [key]: newMapping };
            setMappings(nextMappings);
        }
    }

    function selectSource(source) {
        if (mappingMode === "one_to_many") {
            const existing = Object.entries(mappings).find(([, item]) => item?.type === "one_to_many" && item.source?.fieldId === String(source.field.id) && (!source.input || item.source?.inputId === String(source.input.id)));
            setOneManySource(source);
            if (editingMappingKey && existing?.[0] === editingMappingKey) {
                setOneManyTargets(existing[1].targets || []);
            } else {
                setOneManyTargets([]);
                setEditingMappingKey(null);
            }
            setActiveSource(source);
            setErrors((current) => ({ ...current, mapping: "" }));
            return;
        }
        if (mappingMode === "compose") {
            setComposeSources((current) => current.some((item) => item.key === source.key)
                ? current.filter((item) => item.key !== source.key)
                : [...current, source]);
            setActiveSource({ mode: "compose", sources: composeSources.some((item) => item.key === source.key) ? composeSources.filter((item) => item.key !== source.key) : [...composeSources, source], label: "combined source" });
        } else {
            setMappingMode("direct");
            setActiveSource(source);
        }
        setErrors((current) => ({ ...current, mapping: "" }));
    }

    function selectSystemSource() {
        setMappingMode("system");
        setActiveSource({ kind: "system", label: "Submission Date", source: { kind: "system", value: "submission.date_created", format: dateFormat } });
        setErrors((current) => ({ ...current, mapping: "" }));
    }

    function saveOneMany() {
        if (!oneManySource || !oneManyTargets.length) {
            setErrors((current) => ({ ...current, mapping: "Select a source and at least one PDF target." }));
            return;
        }
        const key = editingMappingKey || `one-to-many:${Date.now()}`;
        setMapping(key, {
            id: mappings[key]?.id || key,
            type: "one_to_many",
            source: sourceDescriptor(oneManySource),
            sourceFieldId: String(oneManySource.field.id),
            sourceInputId: oneManySource.input ? String(oneManySource.input.id) : "",
            gravityFieldLabel: oneManySource.field.label,
            inputLabel: oneManySource.input?.label,
            targets: oneManyTargets,
        });
        setActiveSource(null);
        setOneManySource(null);
        setOneManyTargets([]);
        setEditingMappingKey(null);
        setMappingMode("direct");
    }

    function editMapping(item) {
        const sourceField = gravityFields.find((field) => String(field.id) === String(item.sourceFieldId || item.source?.fieldId));
        const sourceInput = sourceField && fieldInputs(sourceField).find((input) => String(input.id) === String(item.sourceInputId || item.source?.inputId));
        const source = sourceField ? { key: mappingKey(sourceField.id, sourceInput?.id || ""), field: sourceField, input: sourceInput || null, label: sourceInput?.label || sourceField.label } : null;
        setEditingMappingKey(item.key);
        if (item.type === "one_to_many") {
            setMappingMode("one_to_many");
            setOneManySource(source);
            setOneManyTargets(item.targets || []);
            setActiveSource(source);
        } else if (item.type === "compose") {
            setMappingMode("compose");
            const sources = (item.sources || []).map((part) => {
                const field = gravityFields.find((candidate) => String(candidate.id) === String(part.fieldId));
                const input = field && fieldInputs(field).find((candidate) => String(candidate.id) === String(part.inputId));
                return field ? { key: mappingKey(field.id, input?.id || ""), field, input: input || null, label: input?.label || field.label } : null;
            }).filter(Boolean);
            setComposeSources(sources);
            setActiveSource({ key: item.key, mode: "compose", sources, label: "combined source" });
        } else if (item.type === "system") {
            setMappingMode("system");
            setDateFormat(item.source?.format || "DD/MM/YYYY");
            setActiveSource({ key: item.key, kind: "system", label: "Submission Date", source: item.source });
        } else if (item.type === "repeat") {
            setMappingMode("repeat");
            setActiveSource(source);
        } else {
            setMappingMode("direct");
            setActiveSource(source);
        }
    }

    function selectPdfField(field) {
        if (!activeSource) return;
        if (mappingMode === "one_to_many") {
            if (oneManyTargets.some((target) => target.fieldName === field.name)) return;
            const alreadyUsed = allMappedTargets.includes(field.name) && !oneManyTargets.some((target) => target.fieldName === field.name);
            if (alreadyUsed) {
                setErrors((current) => ({ ...current, mapping: "That PDF field is already mapped. Choose another target." }));
                return;
            }
            setOneManyTargets((current) => [...current, { kind: "pdf_field", fieldName: field.name }]);
            return;
        }
        if (mappingMode === "compose" && !composeSources.length) {
            setErrors((current) => ({ ...current, mapping: "Select at least two source values before choosing a PDF field." }));
            return;
        }
        const ignoredKeys = new Set([activeSource.key, editingMappingKey].filter(Boolean));
        const duplicate = mappedEntries.some((item) => !ignoredKeys.has(item.key) && mappingTargetNames(item, pdfFields).includes(field.name));
        if (duplicate) {
            setErrors((current) => ({ ...current, mapping: "That PDF field is already mapped. Remove the existing mapping before reusing it." }));
            return;
        }
        const nextMappingKey = mappingMode === "compose" ? `compose:${field.name}` : mappingMode === "system" ? `system:${field.name}` : "";
        if (editingMappingKey && nextMappingKey && editingMappingKey !== nextMappingKey) {
            setMappings((current) => ({ ...current, [editingMappingKey]: undefined }));
        }
        if (mappingMode === "compose" && composeSources.length) {
            setMapping(`compose:${field.name}`, {
                type: "compose",
                sources: composeSources.map((source) => source.input ? { kind: "gravity_field", fieldId: String(source.field.id), inputId: String(source.input.id), label: source.label } : { kind: "gravity_field", fieldId: String(source.field.id), label: source.label }),
                literals: [composeLiteral],
                parts: composeSources.flatMap((source, index) => [
                    source.input ? { kind: "gravity_field", fieldId: String(source.field.id), inputId: String(source.input.id) } : { kind: "gravity_field", fieldId: String(source.field.id) },
                    ...(index < composeSources.length - 1 ? [{ literal: composeLiteral }] : []),
                ]),
                target: { kind: "pdf_field", fieldName: field.name },
                pdfField: field.name,
                targetField: field.name,
                gravityFieldLabel: composeSources.map((source) => source.label).join(" + "),
            });
            setComposeSources([]);
        } else if (activeSource.kind === "system") {
            setMapping(`system:${field.name}`, {
                type: "system",
                source: { kind: "system", value: "submission.date_created", format: dateFormat },
                target: { kind: "pdf_field", fieldName: field.name },
                pdfField: field.name,
                targetField: field.name,
                gravityFieldLabel: "Submission Date",
            });
        } else if (activeSource.input) updateCompoundMapping(activeSource.field, activeSource.input, field.name);
        else updateMapping(activeSource.field, field.name);
        setActiveSource(null);
        setMappingMode("direct");
        setEditingMappingKey(null);
        setErrors((current) => ({ ...current, mapping: "" }));
    }

    function updateMapping(gravityField, pdfName) {
        const pdfField = pdfFieldByName[pdfName];
        setMapping(mappingKey(gravityField.id), pdfName ? {
            type: "direct", sourceFieldId: String(gravityField.id), gravityFieldId: String(gravityField.id), gravityFieldLabel: gravityField.label, gravityFieldType: gravityField.type,
            source: { kind: "gravity_field", fieldId: String(gravityField.id) }, target: { kind: "pdf_field", fieldName: pdfName },
            pdfField: pdfName, targetField: pdfName, pdfFieldType: pdfField?.type || "",
        } : undefined);
    }

    function updateCompoundMapping(field, input, pdfName) {
        const pdfField = pdfFieldByName[pdfName];
        setMapping(mappingKey(field.id, input.id), pdfName ? {
            type: "direct", sourceFieldId: String(field.id), sourceInputId: String(input.id), gravityFieldId: String(field.id), gravityFieldLabel: field.label, gravityFieldType: field.type, inputLabel: input.label,
            source: { kind: "gravity_field", fieldId: String(field.id), inputId: String(input.id) }, target: { kind: "pdf_field", fieldName: pdfName },
            pdfField: pdfName, targetField: pdfName, pdfFieldType: pdfField?.type || "",
        } : undefined);
    }

    function updateRepeatMapping(field, input, familyKey) {
        const family = pdfFamilies.find((item) => item.key === familyKey);
        const key = `repeat:${field.id}`;
        const current = mappings[key] || { type: "repeat", sourceFieldId: String(field.id), gravityFieldId: String(field.id), gravityFieldLabel: field.label, gravityFieldType: field.type, source: { kind: "gravity_field", fieldId: String(field.id), mode: "repeat" }, children: [] };
        const children = current.children.filter((child) => child.sourceInputId !== String(input.id));
        if (family && children.some((child) => child.targetPattern === family.pattern)) {
            setErrors((currentErrors) => ({ ...currentErrors, mapping: "That PDF family is already assigned within this repeating mapping." }));
            return;
        }
        if (family) children.push({ sourceInputId: String(input.id), inputLabel: input.label, targetPattern: family.pattern, familyKey: family.key, target: { kind: "pdf_field_family", pattern: family.pattern, capacity: family.capacity } });
        setMapping(key, { ...current, type: "repeat", capacity: family?.capacity || current.capacity || 0, children, target: { kind: "pdf_field_family", children } });
    }

    function updateRepeatCount(field, repeatCountFieldId) {
        const key = `repeat:${field.id}`;
        const current = mappings[key] || { type: "repeat", sourceFieldId: String(field.id), gravityFieldId: String(field.id), gravityFieldLabel: field.label, gravityFieldType: field.type, children: [] };
        setMapping(key, { ...current, repeatCountFieldId: repeatCountFieldId ? String(repeatCountFieldId) : "" });
    }

    function autoMap() {
        const next = {};
        const used = new Set();
        directFields.forEach((gravityField) => {
            const match = findMatch(gravityField.label, pdfFields, used);
            if (match) {
                used.add(match.name);
                next[mappingKey(gravityField.id)] = { type: "direct", sourceFieldId: String(gravityField.id), gravityFieldId: String(gravityField.id), gravityFieldLabel: gravityField.label, gravityFieldType: gravityField.type, pdfField: match.name, targetField: match.name, pdfFieldType: match.type };
            }
        });
        compoundFields.forEach((field) => fieldInputs(field).forEach((input) => {
            const match = findMatch(input.label, pdfFields, used);
            if (match) {
                used.add(match.name);
                next[mappingKey(field.id, input.id)] = { type: "direct", sourceFieldId: String(field.id), sourceInputId: String(input.id), gravityFieldId: String(field.id), gravityFieldLabel: field.label, gravityFieldType: field.type, inputLabel: input.label, pdfField: match.name, targetField: match.name, pdfFieldType: match.type };
            }
        }));
        repeatGroups.forEach((field) => {
            const familyUsed = new Set();
            const children = repeatInputs(field).map((input) => {
                const family = findFamily(input.label, pdfFamilies, familyUsed);
                if (!family) return null;
                familyUsed.add(family.key);
                return { sourceInputId: String(input.id), inputLabel: input.label, targetPattern: family.pattern, familyKey: family.key, target: { kind: "pdf_field_family", pattern: family.pattern, capacity: family.capacity } };
            }).filter(Boolean);
            if (children.length) {
                next[`repeat:${field.id}`] = { type: "repeat", sourceFieldId: String(field.id), gravityFieldId: String(field.id), gravityFieldLabel: field.label, gravityFieldType: field.type, source: { kind: "gravity_field", fieldId: String(field.id), mode: "repeat" }, repeatCountFieldId: String(repeatCountFields[0]?.id || ""), capacity: Math.min(...children.map((child) => pdfFamilies.find((family) => family.key === child.familyKey)?.capacity || 0)), children, target: { kind: "pdf_field_family", children } };
            }
        });
        setMappings(next);
    }

    async function saveMapping() {
        setErrors((current) => ({ ...current, save: "" }));
        setSavedMessage("");
        if (!selectedForm || !selectedTemplate || duplicateConflict) return;
        try {
            const saveInfo = buildMappingPayload(mappings);
            if (saveInfo) {
                const res = await fetch("/api/save-mapping", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(saveInfo.payload),
                });
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.error || `Server returned HTTP ${res.status}`);
                }
                setSavedMessage(`Mapping configuration saved in mappings/form-${selectedForm.id}/${selectedTemplateId}.json`);
                setSavedModalInfo(saveInfo);
                setIsSavedModalOpen(true);
            }
        } catch (err) {
            setErrors((current) => ({ ...current, save: `Unable to save mapping: ${err.message}` }));
        }
    }

    const preview = {
        formId: selectedForm?.id || null,
        formTitle: selectedForm?.title || null,
        templateId: selectedTemplateId || null,
        templateFilename: selectedTemplate?.template?.filename || null,
        source: "gravity_forms",
        activeSampleSubmission: activeSubmission ? {
            id: activeSubmission.id,
            submitter_name: activeSubmission.submitter_name || (activeSubmission["1.3"] ? `${activeSubmission["1.3"]} ${activeSubmission["1.6"] || ""}`.trim() : "Submission"),
        } : null,
        mappings: mappedEntries.map((item) => {
            const actualGfId = item.type === "system"
                ? "submission.date_created"
                : item.type === "compose"
                ? (item.sources || []).map((s) => s.inputId || s.fieldId).join(" + ")
                : item.type === "repeat"
                ? `${item.sourceFieldId || item.gravityFieldId} (Repeating rows)`
                : item.sourceInputId
                ? `${item.sourceInputId} (Field ${item.sourceFieldId})`
                : item.sourceFieldId || item.source?.fieldId || "";
            const actualPdfId = item.type === "one_to_many"
                ? (item.targets || []).map((t) => t.fieldName).join(", ")
                : item.type === "repeat"
                ? (item.children || []).map((c) => `${c.sourceInputId} -> ${c.targetPattern}`).join("; ")
                : item.pdfField || item.target?.fieldName || item.targetField || "";
            return {
                mappingKey: item.key,
                type: item.type,
                gfFieldId: actualGfId,
                gfParentFieldId: item.sourceFieldId || undefined,
                gfInputId: item.sourceInputId || undefined,
                gfFieldLabel: mappingLabel(item),
                pdfFieldId: actualPdfId,
                mappedValue: resolvePreviewValue(activeSubmission, item),
            };
        }),
    };

    const pdfOptions = (current) => <>
        <option value="">Not mapped</option>
        {pdfFields.map((pdfField) => (
            <option
                key={pdfField.name}
                value={pdfField.name}
                disabled={mappedPdfFields.has(pdfField.name) && current !== pdfField.name}
            >
                {pdfField.name === humanizePdfFieldName(pdfField.name)
                    ? `${pdfField.name} · ${pdfType(pdfField)}`
                    : `${humanizePdfFieldName(pdfField.name)} [PDF Field ID: "${pdfField.name}"] · ${pdfType(pdfField)}`}
            </option>
        ))}
    </>;

    const assignmentRow = (key, sourceLabel, sourceMeta, current, onChange, targetMeta, status = "Matched", sampleVal = null) => <div className="assignment-row" key={key}>
        <div className="source-cell">
            <strong>{sourceLabel}</strong>
            <div className="source-meta-line">{sourceMeta}</div>
            {sampleVal !== null && sampleVal !== undefined && (
                <div className="source-value-preview">
                    <span className="value-label">Mapped Value:</span>
                    <code className="value-code">{sampleVal ? `"${sampleVal}"` : <span className="empty-val">(empty)</span>}</code>
                </div>
            )}
        </div>
        <div className="target-cell"><select value={current} onChange={onChange}>{pdfOptions(current)}</select>{targetMeta}</div>
        <span className={`match-status ${current ? (status === "Type warning" ? "warning" : "matched") : "unmapped"}`}>{current ? status : "Unmapped"}</span>
    </div>;

    function mappingLabel(item) {
        if (item.type === "system") return "Submission Date";
        if (item.type === "compose") return (item.sources || []).map((source) => source.label || source.fieldId).join(" + ");
        return item.inputLabel || item.gravityFieldLabel || item.source?.label || item.sourceFieldId || "Source field";
    }

    function mappingTargetLabel(item) {
        if (item.type === "one_to_many") return (item.targets || []).map((target) => humanizePdfFieldName(target.fieldName)).join(", ");
        if (item.type === "repeat") return (item.children || []).map((child) => child.targetPattern).join(", ");
        return humanizePdfFieldName(item.pdfField || item.target?.fieldName || "Unmapped");
    }

    function mappingRegistry() {
        if (!mappedEntries.length) return null;
        return <section className="saved-mappings">
            <div className="section-title">
                <span className="section-kicker">Saved mappings</span>
                <h3>Independent assignments</h3>
                <p>Edit or unmap one relationship without changing the others. Exact Field IDs and values shown below.</p>
            </div>
            {mappedEntries.map((item) => {
                const actualGfId = item.type === "system"
                    ? "submission.date_created"
                    : item.type === "compose"
                    ? (item.sources || []).map((s) => s.inputId || s.fieldId).join(" + ")
                    : item.type === "repeat"
                    ? `${item.sourceFieldId || item.gravityFieldId} (Repeating rows)`
                    : item.sourceInputId
                    ? `${item.sourceInputId} (Field ${item.sourceFieldId})`
                    : item.sourceFieldId || item.source?.fieldId || "N/A";
                const actualPdfId = item.type === "one_to_many"
                    ? (item.targets || []).map((target) => target.fieldName).join(", ")
                    : item.type === "repeat"
                    ? (item.children || []).map((child) => `${child.sourceInputId} → ${child.targetPattern}`).join("; ")
                    : item.pdfField || item.target?.fieldName || item.targetField || "Unmapped";
                const currentVal = resolvePreviewValue(activeSubmission, item);
                return <div className="saved-mapping-row" key={item.key}>
                    <div>
                        <strong>{mappingLabel(item)}</strong>
                        <span className="technical-meta">
                            <span className="id-badge">GF Field ID: <strong>{actualGfId}</strong></span>
                            {" · "}
                            <span>{item.type === "one_to_many" ? "One → Many" : item.type === "compose" ? "Compose" : item.type === "repeat" ? "Repeating / Multiple" : item.type === "system" ? "System Value" : "Direct"}</span>
                        </span>
                    </div>
                    <div className="saved-mapping-target">
                        <div className="target-id-row">
                            <span className="target-arrow">→</span>
                            <span className="target-id-label">PDF Field ID:</span>
                            <code className="pdf-id-badge">{actualPdfId}</code>
                            {mappingTargetLabel(item) !== actualPdfId && (
                                <span className="pdf-human-name">({mappingTargetLabel(item)})</span>
                            )}
                        </div>
                        <div className="saved-mapping-val">
                            <span className="val-label">Mapped Value:</span>
                            <code className="val-preview">{currentVal ? `"${currentVal}"` : <span className="empty-val">(empty)</span>}</code>
                        </div>
                    </div>
                    <div className="saved-mapping-actions">
                        <button type="button" onClick={() => editMapping(item)}>Edit</button>
                        <button type="button" onClick={() => removeMapping(item.key)}>Unmap</button>
                    </div>
                </div>;
            })}
        </section>;
    }

    function enhancedMappings() {
        if (!selectedForm) return null;
        return <div className="mapping-sections">
            <section className="field-section">
                <div className="section-title">
                    <span className="section-kicker">Direct fields</span>
                    <h3>Form details</h3>
                    <p>One Gravity Forms value maps to one PDF field. Inspect field IDs and live values below.</p>
                </div>
                {directFields.map((field) => {
                    const mapping = mappings[mappingKey(field.id)];
                    const current = mapping?.pdfField || "";
                    const target = pdfFieldByName[current];
                    const val = resolvePreviewValue(activeSubmission, mapping || {
                        type: "direct",
                        sourceFieldId: String(field.id),
                        gravityFieldId: String(field.id),
                        gravityFieldLabel: field.label,
                        gravityFieldType: field.type,
                    });
                    const sourceMeta = <>
                        <span className="id-badge">GF Field ID: <strong>{field.id}</strong></span>
                        <span> · {field.type || "field"}{field.required ? " · Required" : ""}</span>
                    </>;
                    const targetMeta = <span className="technical-meta">
                        {target ? (
                            <>
                                PDF Field ID: <code className="pdf-id-badge">{target.name}</code>
                                {" · "}Page {target.page || "?"} · {pdfType(target)}
                            </>
                        ) : "Not mapped"}
                    </span>;
                    return assignmentRow(
                        field.id,
                        field.label || "Untitled field",
                        sourceMeta,
                        current,
                        (event) => updateMapping(field, event.target.value),
                        targetMeta,
                        target && !compatible(field.type, target) ? "Type warning" : "Matched",
                        val
                    );
                })}
            </section>
            {compoundFields.map((field) => (
                <section className="field-section" key={field.id}>
                    <div className="section-title">
                        <span className="section-kicker">Compound field</span>
                        <h3>{field.label}</h3>
                        <p>
                            Parent <span className="id-badge">GF Field ID: <strong>{field.id}</strong></span> · Map each input independently.
                        </p>
                    </div>
                    {fieldInputs(field).map((input) => {
                        const mapping = mappings[mappingKey(field.id, input.id)];
                        const current = mapping?.pdfField || "";
                        const target = pdfFieldByName[current];
                        const val = resolvePreviewValue(activeSubmission, mapping || {
                            type: "direct",
                            sourceFieldId: String(field.id),
                            sourceInputId: String(input.id),
                            gravityFieldId: String(field.id),
                            gravityFieldLabel: field.label,
                            inputLabel: input.label,
                        });
                        const sourceMeta = <>
                            <span className="id-badge">GF Input ID: <strong>{input.id}</strong></span>
                            <span> (Field {field.id})</span>
                        </>;
                        const targetMeta = <span className="technical-meta">
                            {target ? (
                                <>
                                    PDF Field ID: <code className="pdf-id-badge">{target.name}</code>
                                    {" · "}Page {target.page || "?"}
                                </>
                            ) : "Not mapped"}
                        </span>;
                        return assignmentRow(
                            `${field.id}:${input.id}`,
                            input.label || "Unnamed input",
                            sourceMeta,
                            current,
                            (event) => updateCompoundMapping(field, input, event.target.value),
                            targetMeta,
                            "Matched",
                            val
                        );
                    })}
                </section>
            ))}
            {repeatGroups.map((field) => {
                const repeat = mappings[`repeat:${field.id}`] || {};
                const listRows = parseListRows(activeSubmission?.[field.id] || activeSubmission?.[String(field.id)]);
                const capacity = repeat.capacity || Math.max(...pdfFamilies.map((family) => family.capacity), 0);
                return <section className="field-section repeat-section" key={field.id}>
                    <div className="section-title">
                        <span className="section-kicker">Repeating group</span>
                        <h3>{field.label}</h3>
                        <p>
                            Group <span className="id-badge">GF Field ID: <strong>{field.id}</strong></span> · One mapping applies to every row. <strong>PDF capacity: {capacity} rows</strong>
                        </p>
                    </div>
                    <label className="repeat-count">
                        Repeat count
                        <select
                            value={repeat.repeatCountFieldId || ""}
                            onChange={(event) => updateRepeatCount(field, event.target.value)}
                        >
                            <option value="">Select count field</option>
                            {repeatCountFields.map((countField) => (
                                <option key={countField.id} value={countField.id}>
                                    GF Field ID: {countField.id} — {countField.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    {repeatInputs(field).map((input) => {
                        const child = repeat.children?.find((item) => item.sourceInputId === String(input.id));
                        const family = pdfFamilies.find((item) => item.pattern === child?.targetPattern);
                        const sampleRowVal = listRows.length > 0
                            ? (listRows[0][input.label] || listRows[0][input.id] || Object.values(listRows[0])[0] || "")
                            : "";
                        return <div className="assignment-row" key={input.id}>
                            <div className="source-cell">
                                <strong>{input.label || "Unnamed input"}</strong>
                                <div className="source-meta-line">
                                    <span className="id-badge">GF Input ID: <strong>{input.id}</strong></span>
                                    <span className="technical-meta"> (Group {field.id})</span>
                                </div>
                                {sampleRowVal ? (
                                    <div className="source-value-preview">
                                        <span className="value-label">Row 1 Value:</span>
                                        <code className="value-code">"{sampleRowVal}"</code>
                                    </div>
                                ) : null}
                            </div>
                            <div className="target-cell">
                                <select
                                    value={family?.key || ""}
                                    onChange={(event) => updateRepeatMapping(field, input, event.target.value)}
                                >
                                    <option value="">Not mapped</option>
                                    {pdfFamilies.map((item) => (
                                        <option key={item.key} value={item.key}>
                                            {item.label} — Pattern ID: "{item.pattern}" ({item.capacity} rows)
                                        </option>
                                    ))}
                                </select>
                                <span className="technical-meta">
                                    {family ? (
                                        <>
                                            PDF Pattern ID: <code className="pdf-id-badge">{family.pattern}</code>
                                            {" · "}{family.capacity} rows
                                        </>
                                    ) : "Choose an indexed PDF family"}
                                </span>
                            </div>
                            <span className={`match-status ${family ? "matched" : "unmapped"}`}>
                                {family ? "Matched" : "Unmapped"}
                            </span>
                        </div>;
                    })}
                </section>;
            })}
        </div>;
    }

    return <div className="app">
        {/* Global 3-page Top Navigation Bar */}
        <TopNavigation
            currentRoute={currentRoute}
            onNavigate={navigate}
            wpConnections={wpConnections}
            activeWpConn={activeWpConn}
            onSelectWpConn={handleSelectWpConn}
            onOpenWpManager={() => setIsWpManagerOpen(true)}
            wpConnectionStatus={wpConnStatus}
            onTestWpConn={handleTestActiveWpConn}
            forms={forms}
            selectedForm={selectedForm}
            onSelectForm={(formId) => {
                const found = forms.find((f) => String(f.id) === String(formId));
                if (found) setSelectedForm(found);
            }}
            pdfTemplates={pdfTemplatesList}
            activePdfTemplate={activePdfTemplate}
            onSelectPdfTemplate={handleSelectPdfTemplate}
            onOpenTemplateModal={() => setIsTplModalOpen(true)}
            onAddWpConn={handleAddWpConn}
            onEditWpConn={() => handleEditWpConn(activeWpConn)}
            onRemoveWpConn={() => handleRemoveWpConn(activeWpConn?.id)}
            onAddPdfTemplate={handleAddPdfTemplate}
            onEditPdfTemplate={() => handleEditPdfTemplate(activePdfTemplate)}
            onRemovePdfTemplate={() => handleRemovePdfTemplate(activePdfTemplate?.id)}
        />

        <main>
            {(errors.templates || errors.forms) && <div className="error-banner"><strong>Connection needs attention</strong><span>{errors.templates || errors.forms}</span><button type="button" onClick={loadData}>Retry</button></div>}

            {/* ROUTE 1: /analyze (PDF Template Ingestion & Analysis) */}
            {currentRoute === "/analyze" && (
                <TemplateIngestionPage
                    activeTemplate={activePdfTemplate}
                    pdfTemplatesList={pdfTemplatesList}
                    onSelectPdfTemplate={handleSelectPdfTemplate}
                    onAddPdfTemplate={handleAddPdfTemplate}
                    onEditPdfTemplate={handleEditPdfTemplate}
                    onRemovePdfTemplate={handleRemovePdfTemplate}
                    wpConnections={wpConnections}
                    activeWpConn={activeWpConn}
                    onSelectWpConn={handleSelectWpConn}
                    onAddWpConn={handleAddWpConn}
                    onEditWpConn={() => handleEditWpConn(activeWpConn)}
                    onRemoveWpConn={handleRemoveWpConn}
                    wpConnStatus={wpConnStatus}
                    onTestWpConn={handleTestActiveWpConn}
                    forms={forms}
                    selectedForm={selectedForm}
                    onSelectForm={(formId) => {
                        const found = forms.find((f) => String(f.id) === String(formId));
                        if (found) setSelectedForm(found);
                    }}
                    onUseTemplateInMapper={(newTpl) => {
                        const list = getPdfTemplates();
                        setPdfTemplatesList(list);
                        setActivePdfTemplate(newTpl);
                        setActivePdfTemplateId(newTpl.id);
                        setSelectedTemplate(toTemplateModel(newTpl));
                        navigate("/mapper");
                    }}
                    onOpenJsonDb={() => setIsJsonDbModalOpen(true)}
                />
            )}

            {/* ROUTE 3: /automation (Automation Dispatch, Storage & Notifications) */}
            {currentRoute === "/automation" && (
                <AutomationDispatchPage
                    forms={forms}
                    selectedForm={selectedForm}
                    onSelectForm={(formId) => {
                        const found = forms.find((f) => String(f.id) === String(formId));
                        if (found) setSelectedForm(found);
                    }}
                    pdfTemplates={pdfTemplatesList}
                    activePdfTemplate={activePdfTemplate}
                    mappings={mappings}
                    pdfTemplateUrl={currentPdfSource}
                    wordpressFormsUrl={activeWpConn?.url || WORDPRESS_FORMS_URL}
                    wordpressApiKey={activeWpConn?.apiKey || WORDPRESS_API_KEY}
                    onOpenTester={() => setIsTesterOpen(true)}
                />
            )}

            {/* ROUTE 2: /mapper (Field Mapping Workspace) */}
            {currentRoute === "/mapper" && (
                <>
                    <section className="configuration">
                        <label>Source<select value="gravity_forms" readOnly><option value="gravity_forms">Gravity Forms</option></select></label>
                        <label>Gravity Form<select value={selectedForm?.id || ""} onChange={(event) => setSelectedForm(forms.find((form) => String(form.id) === event.target.value) || null)}><option value="">Select Gravity Form</option>{forms.map((form) => <option key={form.id} value={form.id}>{form.title}</option>)}</select></label>
                        <label>PDF Template
                            <select
                                value={selectedTemplateId}
                                onChange={(event) => {
                                    const val = event.target.value;
                                    const found = templates.find((template) => template.templateId === val || template.id === val);
                                    setSelectedTemplate(found || null);
                                    if (found) {
                                        const matchedRaw = pdfTemplatesList.find((t) => t.id === found.id || t.filename === found.template?.filename || t.filename === found.filename);
                                        const resolvedRaw = matchedRaw || found;
                                        setActivePdfTemplate(resolvedRaw);
                                        setActivePdfTemplateId(resolvedRaw.id);
                                    }
                                }}
                            >
                                <option value="">Select PDF Template</option>
                                {templates.map((template, idx) => {
                                    const optKey = template.id || template.templateId || `tpl-opt-${idx}`;
                                    const optVal = template.templateId || template.id;
                                    const optLabel = template.template?.title || template.template?.filename || template.name || template.filename || optVal;
                                    return (
                                        <option key={optKey} value={optVal}>
                                            {optLabel}
                                        </option>
                                    );
                                })}
                            </select>
                        </label>
                    </section>
                    {selectedTemplate && (
                        <section className="template-info">
                            <div>
                                <h2>{selectedTemplate.template?.filename || selectedTemplate.name}</h2>
                                <p>
                                    {selectedTemplate.technical?.pages || 1} pages <span>•</span> {selectedTemplate.technical?.fieldCount || 0} AcroForm fields <span>•</span> {selectedTemplate.technical?.hasAcroForm ? "AcroForm detected" : "Standard PDF"}
                                    {isAnalyzingTemplate && <span style={{ marginLeft: "10px", color: "#2563eb", fontWeight: 600 }}>• Ingesting field coordinates & context...</span>}
                                </p>
                            </div>
                        </section>
                    )}
                    <section className="mapping-builder">
                        <div>
                            <h3>Choose how the source value reaches the PDF</h3>
                        </div>
                        <div className="mapping-mode-buttons">
                            <button type="button" className={mappingMode === "direct" ? "is-active" : ""} onClick={() => { setMappingMode("direct"); setComposeSources([]); setActiveSource(null); }}>
                                <ArrowRight size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                Direct
                            </button>
                            <button type="button" className={mappingMode === "one_to_many" ? "is-active" : ""} onClick={() => { setMappingMode("one_to_many"); setActiveSource(oneManySource); }}>
                                <GitFork size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                One → Many
                            </button>
                            <button type="button" className={mappingMode === "compose" ? "is-active" : ""} onClick={() => { setMappingMode("compose"); setActiveSource({ mode: "compose", sources: composeSources, label: "combined source" }); }}>
                                <Combine size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                Compose / Combine
                            </button>
                            <button type="button" className={mappingMode === "repeat" ? "is-active" : ""} onClick={() => { setMappingMode("repeat"); setActiveSource(null); }}>
                                <Repeat size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                Repeating / Multiple
                            </button>
                            <button type="button" className={mappingMode === "system" ? "is-active" : ""} onClick={selectSystemSource}>
                                <Clock size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                System Value
                            </button>
                        </div>
                        {mappingMode === "one_to_many" && <div className="compose-builder"><strong>Source:</strong><span>{oneManySource?.label || "Select one source field on the left"}</span><strong>PDF targets:</strong><div className="one-many-targets">{oneManyTargets.length ? oneManyTargets.map((target) => <span className="one-many-target" key={target.fieldName}>{humanizePdfFieldName(target.fieldName)}<button type="button" onClick={() => setOneManyTargets((current) => current.filter((item) => item.fieldName !== target.fieldName))}>Remove</button></span>) : <span>Click PDF fields to add targets</span>}</div><button type="button" onClick={saveOneMany} disabled={!oneManySource || !oneManyTargets.length}>Save One → Many</button><small>Source reuse is allowed; PDF targets must be unique.</small></div>}
                        {mappingMode === "compose" && <div className="compose-builder"><strong>Sources:</strong><span>{composeSources.length ? composeSources.map((source) => source.label).join(" + ") : "Select multiple source fields on the left"}</span><label>Literal separator<input value={composeLiteral} onChange={(event) => setComposeLiteral(event.target.value)} aria-label="Literal separator" /></label><small>Click source fields, then click a PDF field.</small></div>}
                        {mappingMode === "repeat" && <div className="compose-builder"><strong>Repeating / Multiple</strong><span>Use the existing repeat controls below to configure source inputs, {"{index}"} target families, and capacity.</span></div>}
                        {mappingMode === "system" && <div className="compose-builder"><strong>Submission Date</strong><span>submission.date_created</span><label>Format<select value={dateFormat} onChange={(event) => { setDateFormat(event.target.value); setActiveSource((current) => current ? { ...current, source: { ...current.source, format: event.target.value } } : current); }}><option>DD/MM/YYYY</option><option>YYYY-MM-DD</option><option>DD Month YYYY</option></select></label></div>}
                    </section>
                    <section className="visual-workspace">
                        <section className="source-panel gravity-source-panel"><div className="panel-heading"><h2>Form schema</h2><p>Choose a field, then click its PDF target.</p></div><GravityFormPanel form={selectedForm} mappings={mappings} activeSource={activeSource} onSelectSource={selectSource} onSelectSystem={selectSystemSource} onRemoveMapping={removeMapping} activeSubmission={activeSubmission} wpSyncInfo={wpSyncInfo} isCheckingWp={isCheckingWp} onRefreshWp={() => handleRefreshWp()} onOpenWpConfig={() => setShowWpConfig(true)} /></section>
                        <section className="source-panel pdf-source-panel"><div className="panel-heading"><h2>{selectedTemplate?.template?.filename || "PDF template"}</h2><p>Click an existing AcroForm field to assign, edit, or remove mappings.</p></div><PdfViewer source={currentPdfSource} pages={selectedTemplate?.context?.pages} mappedByPdf={mappedByPdf} mappedDetailsByPdf={mappedDetailsByPdf} sourceOptions={sourceOptions} activeSource={activeSource} onFieldSelect={selectPdfField} onRemoveMapping={removePdfMapping} onEditMapping={(field) => { const entry = mappedEntries.find((item) => mappingTargetNames(item, pdfFields).includes(field.name)); if (entry) editMapping(entry); }} onReassignMapping={reassignPdfMapping} /></section>
                    </section>
                    <section className="mapping-panel">
                        <div className="mapping-header">
                            <div>
                                <h2>Field assignments</h2>
                                <p>{mappedCount} of {gravityFields.length} Gravity Forms fields assigned {loading.mapping ? "· Loading saved mapping..." : ""}</p>
                            </div>
                            <div className="mapping-actions">
                                <button type="button" onClick={autoMap} disabled={!selectedForm || !selectedTemplate}>
                                    <Wand2 size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                    Auto Match
                                </button>
                                <button type="button" className="quiet" onClick={() => setMappings(EMPTY_MAPPING)}>
                                    <RotateCcw size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                    Clear Mappings
                                </button>
                                <button type="button" className="primary" onClick={saveMapping} disabled={!selectedForm || !selectedTemplate || duplicateConflict}>
                                    <Check size={14} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                    Save Mapping
                                </button>
                                <button type="button" className="test-generation-btn" onClick={() => setIsTesterOpen(true)} disabled={!selectedForm || !selectedTemplate}>
                                    <Play size={13} style={{ display: "inline-block", marginRight: "5px", verticalAlign: "middle" }} />
                                    Test PDF Generation
                                </button>
                            </div>
                        </div>

                        {selectedForm && (
                            <div className="debug-submission-bar">
                                <div className="debug-submission-info">
                                    <span className="debug-indicator-dot" />
                                    <span className="debug-bar-title">Active Live Entry:</span>
                                    {liveSubmissionsList.length > 0 ? (
                                        <select
                                            className="debug-entry-select"
                                            value={selectedSubmissionId}
                                            onChange={(e) => handleSelectSubmission(e.target.value)}
                                            aria-label="Active live submission for mapping preview"
                                        >
                                            {liveSubmissionsList.map((sub) => (
                                                <option key={sub.id} value={sub.id}>
                                                    Entry #{sub.id} — {sub.submitter_name || `Entry ${sub.id}`}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        <span className="debug-bar-note">
                                            {isLoadingSubmissions ? "Fetching live entries from WordPress..." : "No live submissions found on WordPress."}
                                        </span>
                                    )}
                                </div>
                                {liveSubmissionsList.length > 0 && (
                                    <span className="debug-bar-note">
                                        Live submission values are displayed in form fields below.
                                    </span>
                                )}
                            </div>
                        )}

                        {mappingRegistry()}
                        {enhancedMappings()}
                        <div className="progress-wrap"><div><span>Mapping progress</span><strong>{mappedCount} / {gravityFields.length}</strong></div><progress value={mappedCount} max={gravityFields.length || 1} /></div>
                        {errors.mapping && <div className="inline-warning">{errors.mapping}</div>}
                        {errors.save && <div className="inline-warning">{errors.save}</div>}
                        {savedMessage && (
                            <div className="inline-success">
                                <span>{savedMessage}</span>
                                {savedModalInfo && (
                                    <button
                                        type="button"
                                        className="view-saved-info-btn"
                                        onClick={() => setIsSavedModalOpen(true)}
                                    >
                                        View Saved Confirmation
                                    </button>
                                )}
                            </div>
                        )}
                        {!selectedForm && <div className="empty">{loading.forms ? "Loading real Gravity Forms..." : "Select a Gravity Form to begin."}</div>}
                        {selectedForm && <div className="table-scroll"><div className="mapping-row mapping-heading"><div>Gravity Forms Field & ID</div><div>Type</div><div>PDF Field ID</div><div>PDF Type</div><div>Status</div></div>{gravityFields.map((field) => { const mapping = mappings[field.id]; const current = mapping?.pdfField || ""; const warning = current && !compatible(field.type, mapping.pdfFieldData); const val = extractEntryValue(activeSubmission, field.id, "", field.label); const strVal = val !== undefined && val !== null && typeof val !== "object" ? String(val).trim() : ""; return <div className="mapping-row" key={field.id}><div className="gravity-field"><strong>{field.label || "Untitled field"}</strong><span><span className="id-badge">GF Field ID: <strong>{field.id}</strong></span>{field.required ? " · Required" : ""}</span>{strVal ? <span className="source-sample-val">Value: <code>{strVal.length > 20 ? strVal.slice(0, 18) + "…" : strVal}</code></span> : null}</div><div className="type-cell">{field.type}</div><div><select value={current} onChange={(event) => updateMapping(field, event.target.value)}><option value="">Not mapped</option>{pdfFields.map((pdfField) => <option key={pdfField.name} value={pdfField.name} disabled={mappedPdfFields.has(pdfField.name) && current !== pdfField.name}>{pdfField.name} · {pdfType(pdfField)}</option>)}</select></div><div className="type-cell">{mapping ? pdfType(mapping.pdfFieldData) : "—"}</div><div><span className={`match-status ${warning ? "warning" : current ? "matched" : "unmapped"}`}>{warning ? "Type warning" : current ? "Matched" : "Unmapped"}</span></div></div>; })}</div>}
                        {selectedForm && !gravityFields.length && <div className="empty">This real form contains no fields.</div>}{duplicateConflict && <div className="inline-warning">Duplicate PDF assignments must be resolved before saving.</div>}
                    </section>
                    <details className="mapping-output" open={showJson} onToggle={(event) => setShowJson(event.currentTarget.open)}><summary><span><span className="section-kicker">Debug view</span><strong>Mapping JSON</strong></span><span>Current selection</span></summary><div className="json-toolbar"><button type="button" onClick={() => navigator.clipboard?.writeText(JSON.stringify(preview, null, 2))}>Copy JSON</button></div><pre>{JSON.stringify(preview, null, 2)}</pre></details>
                </>
            )}
        </main>
        <SaveConfirmationModal
            isOpen={isSavedModalOpen}
            onClose={() => setIsSavedModalOpen(false)}
            info={savedModalInfo}
            onTestPdf={() => setIsTesterOpen(true)}
        />
        <WpConnectionModal
            isOpen={showWpConfig}
            onClose={() => setShowWpConfig(false)}
            currentUrl={WORDPRESS_FORMS_URL}
            currentApiKey={WORDPRESS_API_KEY}
            syncInfo={wpSyncInfo}
            isChecking={isCheckingWp}
            onSaveAndFetch={(opts) => {
                handleRefreshWp(opts);
            }}
        />
        <WpConnectionManagerModal
            isOpen={isWpManagerOpen}
            onClose={() => setIsWpManagerOpen(false)}
            activeConnId={activeWpConn?.id}
            onSelectConn={handleSelectWpConn}
            onConnectionsUpdated={(newList) => {
                setWpConnections(newList);
            }}
        />
        <TemplateIngestModal
            isOpen={isTplModalOpen}
            onClose={() => setIsTplModalOpen(false)}
            onTemplateAdded={(newTpl) => {
                const updatedList = getPdfTemplates();
                setPdfTemplatesList(updatedList);
                setActivePdfTemplate(newTpl);
                setActivePdfTemplateId(newTpl.id);
                setSelectedTemplate(toTemplateModel(newTpl));
            }}
        />
        <PdfGenerationTester
            isOpen={isTesterOpen}
            onClose={() => setIsTesterOpen(false)}
            selectedForm={selectedForm}
            selectedTemplate={selectedTemplate || activePdfTemplate?.analysis}
            mappings={mappings}
            pdfTemplateUrl={currentPdfSource}
            wordpressFormsUrl={activeWpConn?.url || WORDPRESS_FORMS_URL}
            wordpressApiKey={activeWpConn?.apiKey || WORDPRESS_API_KEY}
        />
        <WpSourceModal
            isOpen={isWpSourceModalOpen}
            onClose={() => setIsWpSourceModalOpen(false)}
            connection={wpSourceModalConn}
            onSave={(savedConn, updatedList) => {
                setWpConnections(updatedList);
                setActiveWpConn(savedConn);
                setActiveWpConnectionId(savedConn.id);
                loadData({ conn: savedConn });
            }}
        />
        <TemplateEditModal
            isOpen={isTplEditModalOpen}
            onClose={() => setIsTplEditModalOpen(false)}
            template={pdfTemplateToEdit}
            onSave={(updatedTpl) => {
                const updatedList = getPdfTemplates();
                setPdfTemplatesList(updatedList);
                if (activePdfTemplate?.id === updatedTpl.id) {
                    setActivePdfTemplate(updatedTpl);
                    const tplObj = toTemplateModel(updatedTpl);
                    setSelectedTemplate(tplObj);
                }
            }}
        />
        <JsonDatabaseModal
            isOpen={isJsonDbModalOpen}
            onClose={() => setIsJsonDbModalOpen(false)}
            onSaved={() => {
                const conns = getWpConnections();
                const tpls = getPdfTemplates();
                setWpConnections(conns);
                setPdfTemplatesList(tpls);
                const nextConn = getActiveWpConnection();
                setActiveWpConn(nextConn);
                const nextTpl = getActivePdfTemplate();
                setActivePdfTemplate(nextTpl);
                setSelectedTemplate(toTemplateModel(nextTpl));
                loadData({ conn: nextConn, skipRegistrySync: true });
            }}
        />
    </div>;
}

export default App;
