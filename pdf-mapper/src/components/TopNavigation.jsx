import { useState } from "react";
import {
    Plus,
    Pencil,
    Trash2,
    Settings,
    RefreshCw,
    FileText,
    Globe,
    Database,
    Cloud,
    LogOut,
} from "lucide-react";
import "./TopNavigation.css";

function StepOneIcon({ size = 12, className = "" }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="currentColor"
            className={className}
            aria-hidden="true"
        >
            <path d="M7.2 3.2h2.2v9.6H7.2V5.6L5.6 6.6V4.8l1.6-1.6z" />
        </svg>
    );
}

function StepTwoIcon({ size = 12, className = "" }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="currentColor"
            className={className}
            aria-hidden="true"
        >
            <path d="M5.2 5.2c0-1.5 1.2-2.5 2.8-2.5s2.8 1 2.8 2.4c0 1.3-.8 2.3-1.8 3.3L7 10.4h4v1.8H5v-1.6l3.2-3.1c.8-.8 1.2-1.4 1.2-2.2 0-.7-.5-1.1-1.2-1.1-.7 0-1.2.4-1.2 1.1H5.2z" />
        </svg>
    );
}

function StepThreeIcon({ size = 12, className = "" }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="currentColor"
            className={className}
            aria-hidden="true"
        >
            <path d="M5.5 4.8c.3-1.2 1.3-2 2.6-2 1.5 0 2.5.9 2.5 2.2 0 .9-.5 1.6-1.3 1.9 1 .3 1.6 1.1 1.6 2.2 0 1.5-1.2 2.6-2.8 2.6-1.5 0-2.6-.9-2.8-2.3h2c.2.6.6.9 1.1.9.7 0 1.2-.4 1.2-1.1s-.5-1.1-1.3-1.1H7.1V6.9h.9c.7 0 1.1-.4 1.1-1 0-.5-.4-.9-1-.9-.5 0-.9.3-1.1.8H5.5z" />
        </svg>
    );
}

function StepFourIcon({ size = 12, className = "" }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="currentColor"
            className={className}
            aria-hidden="true"
        >
            <path d="M9.6 3v6.2h1.6V11H9.6v2.2H7.6V11H4.4V9.2L9.2 3h.4zm-3.4 6.2h1.4V5.4L6.2 9.2z" />
        </svg>
    );
}

export default function TopNavigation({
    currentRoute,
    onNavigate,
    wpConnections,
    activeWpConn,
    onSelectWpConn,
    onOpenWpManager,
    wpConnectionStatus,
    onTestWpConn,
    forms,
    selectedForm,
    onSelectForm,
    pdfTemplates,
    activePdfTemplate,
    onSelectPdfTemplate,
    onOpenTemplateModal,
    onAddWpConn,
    onEditWpConn,
    onRemoveWpConn,
    onAddPdfTemplate,
    onEditPdfTemplate,
    onRemovePdfTemplate,
    dbStatus,
    onCheckDb,
    onOpenDbConfig,
    gcsStatus,
    onOpenGcsModal,
    user,
    onLogout,
}) {
    const [isChecking, setIsChecking] = useState(false);

    const handleCheckConnection = async () => {
        if (!activeWpConn) return;
        setIsChecking(true);
        try {
            await onTestWpConn();
        } finally {
            setIsChecking(false);
        }
    };

    return (
        <header className="top-nav-bar" id="app-top-navigation">
            {/* Top row: Brand + 3 Page Tabs */}
            <div className="top-nav-primary">
                <div
                    className="top-nav-brand"
                    onClick={() => onNavigate("/analyze")}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onNavigate("/analyze"); }}
                    title="PDF Engine"
                    aria-label="PDF Engine"
                >
                    <svg className="brand-pdf-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <defs>
                            <linearGradient id="headerPdfBody" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
                                <stop stopColor="#EF4444" />
                                <stop offset="1" stopColor="#B91C1C" />
                            </linearGradient>
                            <linearGradient id="headerPdfFold" x1="19.5" y1="2" x2="28" y2="10.5" gradientUnits="userSpaceOnUse">
                                <stop stopColor="#FECACA" />
                                <stop offset="1" stopColor="#F87171" />
                            </linearGradient>
                        </defs>
                        {/* Document Sheet */}
                        <path d="M7 2C5.34315 2 4 3.34315 4 5V27C4 28.6569 5.34315 30 7 30H25C26.6569 30 28 28.6569 28 27V10.5L19.5 2H7Z" fill="url(#headerPdfBody)" />
                        {/* Fold Corner Shadow */}
                        <path d="M19.5 2V8.5C19.5 9.60457 20.3954 10.5 21.5 10.5H28L19.5 2Z" fill="#7F1D1D" fillOpacity="0.35" />
                        {/* Fold Flap */}
                        <path d="M19.5 2L28 10.5H21.5C20.3954 10.5 19.5 9.60457 19.5 8.5V2Z" fill="url(#headerPdfFold)" />
                        {/* Document Header Line */}
                        <rect x="7.5" y="7" width="8" height="1.8" rx="0.9" fill="#FFFFFF" fillOpacity="0.5" />
                        {/* Letters PDF */}
                        <path fillRule="evenodd" clipRule="evenodd" d="M7.5 13.5H10.7C12.1 13.5 13 14.4 13 15.8V16.1C13 17.5 12.1 18.4 10.7 18.4H9.3V22.5H7.5V13.5ZM9.3 16.9H10.6C11.1 16.9 11.3 16.6 11.3 16.1V16C11.3 15.5 11.1 15.2 10.6 15.2H9.3V16.9Z" fill="#FFFFFF" />
                        <path fillRule="evenodd" clipRule="evenodd" d="M13.7 13.5H16.6C18.2 13.5 19.4 14.6 19.4 16.3V18.7C19.4 20.4 18.2 21.5 16.6 21.5H13.7V13.5ZM15.5 19.8H16.6C17.3 19.8 17.7 19.3 17.7 18.5V16.4C17.7 15.6 17.3 15.1 16.6 15.1H15.5V19.8Z" fill="#FFFFFF" />
                        <path d="M20.3 13.5H24.7V15.1H22.1V17.3H24.3V18.9H22.1V22.5H20.3V13.5Z" fill="#FFFFFF" />
                        {/* Document Footer Line */}
                        <rect x="7.5" y="25" width="17" height="1.6" rx="0.8" fill="#FFFFFF" fillOpacity="0.4" />
                    </svg>
                    <span className="brand-engine-text">ENGINE</span>
                </div>

                <nav className="top-nav-tabs" aria-label="Application Steps">
                    <button
                        type="button"
                        id="nav-tab-analyze"
                        className={`nav-tab-item ${currentRoute === "/analyze" ? "is-active" : ""}`}
                        onClick={() => onNavigate("/analyze")}
                    >
                        <span className="tab-step-num"><StepOneIcon size={12} /></span>
                        <span className="tab-title">PDF Ingestion</span>
                    </button>

                    <button
                        type="button"
                        id="nav-tab-mapper"
                        className={`nav-tab-item ${currentRoute === "/mapper" ? "is-active" : ""}`}
                        onClick={() => onNavigate("/mapper")}
                    >
                        <span className="tab-step-num"><StepTwoIcon size={12} /></span>
                        <span className="tab-title">Field Mapper</span>
                    </button>

                    <button
                        type="button"
                        id="nav-tab-automation"
                        className={`nav-tab-item ${currentRoute === "/automation" ? "is-active" : ""}`}
                        onClick={() => onNavigate("/automation")}
                    >
                        <span className="tab-step-num"><StepThreeIcon size={12} /></span>
                        <span className="tab-title">Automation & Dispatch</span>
                    </button>

                    <button
                        type="button"
                        id="nav-tab-wp-integration"
                        className={`nav-tab-item ${currentRoute === "/wp-integration" ? "is-active" : ""}`}
                        onClick={() => onNavigate("/wp-integration")}
                    >
                        <span className="tab-step-num"><StepFourIcon size={12} /></span>
                        <span className="tab-title">WP Integration & Mail</span>
                    </button>
                </nav>

                {onLogout && (
                    <div className="top-nav-user-actions">
                        <div className="nav-admin-badge" title={`Authenticated Administrator: ${user?.email || 'admin'}`}>
                            <span className="nav-admin-dot" aria-hidden="true" />
                            <span className="nav-admin-email">{user?.email || 'Admin'}</span>
                        </div>
                        <button
                            type="button"
                            className="nav-logout-btn"
                            onClick={onLogout}
                            title="Sign out of PDF Generator"
                        >
                            <LogOut size={12} /> Sign Out
                        </button>
                    </div>
                )}
            </div>

            {/* Secondary row: Dynamic Source & Template Selectors & Database */}
            <div className="top-nav-selectors-bar">
                {/* Left side: Gravity Forms Source & Site */}
                <div className="nav-selector-cluster cluster-left">
                    <div className="cluster-header-row">
                        <span className="cluster-eyebrow">
                            <Globe size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                            Gravity Form Source
                        </span>
                        <div className="cluster-actions">
                            <button
                                type="button"
                                className="cluster-mini-btn"
                                onClick={onAddWpConn || onOpenWpManager}
                                title="Add new Gravity Form source"
                            >
                                <Plus size={11} /> Add
                            </button>
                            <button
                                type="button"
                                className="cluster-mini-btn"
                                onClick={onEditWpConn || onOpenWpManager}
                                disabled={!activeWpConn}
                                title="Edit active Gravity Form source"
                            >
                                <Pencil size={11} /> Edit
                            </button>
                            <button
                                type="button"
                                className="cluster-mini-btn danger"
                                onClick={onRemoveWpConn}
                                disabled={!activeWpConn || !wpConnections || wpConnections.length <= 1}
                                title={!activeWpConn ? "No source selected" : wpConnections?.length <= 1 ? "Cannot remove the only configured source" : "Remove active Gravity Form source"}
                            >
                                <Trash2 size={11} /> Remove
                            </button>
                        </div>
                    </div>

                    <div className="selector-group">
                        <label htmlFor="top-wp-conn-select" className="sr-only">WordPress Site</label>
                        <select
                            id="top-wp-conn-select"
                            className="nav-compact-select wp-dropdown"
                            value={activeWpConn?.id || ""}
                            onChange={(e) => {
                                if (e.target.value === "__add_new__") {
                                    onOpenWpManager();
                                } else {
                                    onSelectWpConn(e.target.value);
                                }
                            }}
                            title="Selected WordPress Instance"
                        >
                            <option value="">Select a Source</option>
                            {(wpConnections || []).map((conn) => (
                                <option key={conn.id} value={conn.id}>
                                    {conn.name}
                                </option>
                            ))}
                            <option value="__add_new__">+ Add / Edit WordPress Sites...</option>
                        </select>

                        {/* Connection status check pill */}
                        <div
                            className={`nav-status-pill ${!activeWpConn ? "" : wpConnectionStatus?.ok ? "is-ok" : wpConnectionStatus?.loading ? "is-loading" : "is-error"}`}
                            title={wpConnectionStatus?.message || "Connection check status"}
                        >
                            <span className="status-indicator-dot" />
                            <span className="status-text">
                                {wpConnectionStatus?.loading
                                    ? "Checking..."
                                    : !activeWpConn
                                    ? (wpConnections?.length === 0 ? "No sources available" : "Select a Source")
                                    : wpConnectionStatus?.ok
                                    ? `Connected (${wpConnectionStatus.formsCount ?? forms.length} Forms)`
                                    : "Check Needed"}
                            </span>
                            {activeWpConn && (
                                <button
                                    type="button"
                                    className="status-retry-btn"
                                    onClick={handleCheckConnection}
                                    disabled={isChecking}
                                    title="Run Connection Check"
                                >
                                    <RefreshCw size={11} className={isChecking ? "animate-spin" : ""} />
                                </button>
                            )}
                        </div>

                        <button
                            type="button"
                            className="nav-action-btn"
                            onClick={onOpenWpManager}
                            title="Configure WordPress URL, API Key & Live Link credentials"
                        >
                            <Settings size={12} /> Config
                        </button>
                    </div>

                    <div className="cluster-separator" aria-hidden="true" />

                    <div className="selector-group form-selector-group">
                        <span className="selector-inline-label">Form:</span>
                        <label htmlFor="top-form-select" className="sr-only">Active Gravity Form</label>
                        <select
                            id="top-form-select"
                            className="nav-compact-select form-dropdown"
                            value={selectedForm?.id || ""}
                            onChange={(e) => onSelectForm(e.target.value)}
                            title="Active Gravity Form Schema"
                            disabled={!activeWpConn}
                        >
                            <option value="">Select Gravity Form</option>
                            {(forms || []).map((form) => (
                                <option key={form.id} value={form.id}>
                                    Form #{form.id}: {form.title}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Middle: PDF Template Viewer Selection */}
                <div className="nav-selector-cluster cluster-right">
                    <div className="cluster-header-row">
                        <span className="cluster-eyebrow">
                            <FileText size={12} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                            PDF Template Target
                        </span>
                        <div className="cluster-actions">
                            <button
                                type="button"
                                className="cluster-mini-btn"
                                onClick={onAddPdfTemplate || onOpenTemplateModal}
                                title="Add new PDF template"
                            >
                                <Plus size={11} /> Add
                            </button>
                            <button
                                type="button"
                                className="cluster-mini-btn"
                                onClick={onEditPdfTemplate}
                                disabled={!activePdfTemplate}
                                title="Edit active PDF template"
                            >
                                <Pencil size={11} /> Edit
                            </button>
                            <button
                                type="button"
                                className="cluster-mini-btn danger"
                                onClick={onRemovePdfTemplate}
                                disabled={!activePdfTemplate}
                                title={!activePdfTemplate ? "No template selected" : "Remove active PDF template"}
                            >
                                <Trash2 size={11} /> Remove
                            </button>
                        </div>
                    </div>

                    <div className="selector-group">
                        <label htmlFor="top-pdf-tpl-select" className="sr-only">Active PDF Template</label>
                        <select
                            id="top-pdf-tpl-select"
                            className="nav-compact-select tpl-dropdown"
                            value={activePdfTemplate?.id || ""}
                            onChange={(e) => {
                                if (e.target.value === "__add_cloud_url__") {
                                    onOpenTemplateModal();
                                } else {
                                    onSelectPdfTemplate(e.target.value);
                                }
                            }}
                            title="Active PDF Template"
                        >
                            <option value="">Select a PDF Template</option>
                            {(pdfTemplates || []).map((tpl, idx) => (
                                <option key={tpl.id || tpl.filename || `nav-tpl-${idx}`} value={tpl.id}>
                                    {tpl.name || tpl.filename}
                                </option>
                            ))}
                            <option value="__add_cloud_url__">+ Ingest PDF via Google Cloud / URL...</option>
                        </select>

                        {/* Template specs badge */}
                        {activePdfTemplate ? (
                            <div className="nav-tpl-specs-badge">
                                <span>
                                    {activePdfTemplate?.analysis?.technical?.pages || 0} pgs
                                </span>
                                <span>•</span>
                                <span>
                                    {activePdfTemplate?.analysis?.technical?.fieldCount || 0} fields
                                </span>
                            </div>
                        ) : (
                            <div className="nav-tpl-specs-badge empty">
                                <span>{pdfTemplates?.length === 0 ? "No templates available" : "No template selected"}</span>
                            </div>
                        )}

                        <button
                            type="button"
                            className="nav-action-btn"
                            onClick={onOpenTemplateModal}
                            title="Add or inspect PDF templates"
                        >
                            <Plus size={12} /> Add PDF
                        </button>
                    </div>
                </div>

                {/* Right side: Database & Cloud Storage stacked in two rows */}
                <div className="nav-right-stacked-clusters">
                    {/* Row 1: Database Status & Config */}
                    <div className="nav-selector-cluster cluster-db">
                        <div className="cluster-header-row">
                            <span className="cluster-eyebrow">
                                <Database size={11} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                Database
                            </span>
                        </div>

                        <div className="selector-group">
                            <div
                                className={`nav-status-pill ${dbStatus?.status === "connected" ? "is-ok" : dbStatus?.status === "checking" ? "is-loading" : "is-error"}`}
                                title={dbStatus?.message || "PostgreSQL / Neon database connection"}
                            >
                                <span className="status-indicator-dot" />
                                <span className="status-text">
                                    {dbStatus?.status === "checking"
                                        ? "Checking..."
                                        : dbStatus?.status === "connected"
                                        ? "Connected"
                                        : "Disconnected"}
                                </span>
                                <button
                                    type="button"
                                    className="status-retry-btn"
                                    onClick={onCheckDb}
                                    disabled={dbStatus?.status === "checking"}
                                    title="Check connection"
                                >
                                    <RefreshCw size={11} className={dbStatus?.status === "checking" ? "animate-spin" : ""} />
                                </button>
                            </div>

                            <button
                                type="button"
                                className="nav-action-btn"
                                onClick={onOpenDbConfig}
                                title="Configure Database"
                            >
                                <Settings size={11} /> Config
                            </button>
                        </div>
                    </div>

                    {/* Row 2: Cloud Storage GCP Credentials & Target */}
                    <div className="nav-selector-cluster cluster-gcs">
                        <div className="cluster-header-row">
                            <span className="cluster-eyebrow">
                                <Cloud size={11} style={{ display: "inline-block", marginRight: "4px", verticalAlign: "middle" }} />
                                Cloud Storage
                            </span>
                        </div>

                        <div className="selector-group">
                            <div
                                className={`nav-status-pill ${gcsStatus?.hasEnvCredentials || gcsStatus?.authenticated ? "is-ok" : "is-warning"}`}
                                title={gcsStatus?.hasEnvCredentials || gcsStatus?.authenticated ? `Active bucket: gs://${gcsStatus.bucket || "vc-pdf-generator-storage"}` : "No active GCP credentials configured"}
                            >
                                <span className="status-indicator-dot" />
                                <span className="status-text">
                                    {gcsStatus?.hasEnvCredentials || gcsStatus?.authenticated ? "GCP Ready" : "Local Cache"}
                                </span>
                            </div>

                            <button
                                type="button"
                                className="nav-action-btn"
                                onClick={onOpenGcsModal}
                                title="Configure Google Cloud Storage Service Account"
                            >
                                <Cloud size={11} /> GCP Keys
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </header>
    );
}
