import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { Eye, EyeOff, X } from "lucide-react";
import { humanizePdfFieldName } from "./mappingUtils";
import { fetchPdfBytes } from "./connectionManager";
import "./PdfViewer.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

function pdfFieldType(field) {
    const type = String(field?.type || "");
    if (type.includes("Btn") || type.includes("CheckBox")) return "Checkbox";
    if (type.includes("Radio")) return "Radio";
    if (type.includes("Ch")) return "Choice";
    return "Text";
}

function PdfFieldOverlay({
    field,
    pageSize,
    mappingInfo,
    activeSource,
    isSelected,
    onSelect,
    onEdit,
    onRemove,
}) {
    const xScale = 100 / pageSize.width;
    const yScale = 100 / pageSize.height;
    const isMapped = Boolean(mappingInfo);
    const isTarget = Boolean(activeSource);
    const displayLabel = humanizePdfFieldName(field.name);
    const mappedLabel = mappingInfo?.label || "";
    const style = {
        left: `${field.x * xScale}%`,
        top: `${field.y * yScale}%`,
        width: `${field.width * xScale}%`,
        height: `${field.height * yScale}%`,
    };

    return (
        <div
            className={`pdf-field-overlay ${isMapped ? "is-mapped" : ""} ${isTarget ? "is-target" : ""} ${isSelected ? "is-selected" : ""}`}
            style={style}
            tabIndex={0}
            role="button"
            aria-label={`PDF Field ID: ${field.name}${isMapped ? `, mapped to ${mappedLabel}` : ""}`}
            title={`${displayLabel}\nPDF Field ID: ${field.name}\nPage: ${field.page}\nType: ${pdfFieldType(field)}${isMapped ? `\nMapped from: ${mappedLabel}${mappingInfo?.mappedValue ? `\nMapped Value: "${mappingInfo.mappedValue}"` : ""}` : ""}`}
            onClick={() => onSelect(field)}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(field);
                }
            }}
        >
            <div className={`pdf-field-header ${field.y < 25 ? "header-below" : ""}`}>
                <span className="pdf-field-label" title={isMapped ? `Mapped: ${mappedLabel}` : displayLabel}>
                    {isMapped ? `Mapped · ${mappedLabel}` : displayLabel}
                </span>
                {isMapped && !activeSource && (
                    <span className="overlay-controls" onClick={(e) => e.stopPropagation()}>
                        <button
                            type="button"
                            className="overlay-control-btn overlay-edit-btn"
                            title={`Edit mapping for ${field.name}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onEdit(field);
                            }}
                        >
                            Edit
                        </button>
                        <button
                            type="button"
                            className="overlay-control-btn overlay-remove-btn"
                            title={`Remove mapping for ${field.name}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove(field.name);
                            }}
                        >
                            <X size={10} />
                        </button>
                    </span>
                )}
            </div>
        </div>
    );
}

function PdfPage({
    pdf,
    pageNumber,
    pageData,
    mappedDetailsByPdf = {},
    activeSource,
    selectedField,
    showOverlays = true,
    onFieldSelect,
    onFieldEdit,
    onFieldRemove,
    onError,
}) {
    const canvasRef = useRef(null);
    const pageFrameRef = useRef(null);
    const pageSurfaceRef = useRef(null);

    useEffect(() => {
        let cancelled = false;
        let renderTask;
        let rendering = false;

        async function renderPage() {
            if (rendering) return;
            rendering = true;
            try {
                const page = await pdf.getPage(pageNumber);
                if (cancelled || !pageFrameRef.current || !canvasRef.current || !pageSurfaceRef.current) return;
                const availableWidth = Math.max(pageFrameRef.current.clientWidth - 32, 280);
                const baseViewport = page.getViewport({ scale: 1 });
                const scale = availableWidth / baseViewport.width;
                const viewport = page.getViewport({ scale });
                const canvas = canvasRef.current;
                const surface = pageSurfaceRef.current;
                const deviceScale = window.devicePixelRatio || 1;
                canvas.width = Math.floor(viewport.width * deviceScale);
                canvas.height = Math.floor(viewport.height * deviceScale);
                canvas.style.width = `${viewport.width}px`;
                canvas.style.height = `${viewport.height}px`;
                surface.style.width = `${viewport.width}px`;
                surface.style.height = `${viewport.height}px`;
                renderTask = page.render({
                    canvasContext: canvas.getContext("2d"),
                    viewport,
                    transform: deviceScale === 1 ? null : [deviceScale, 0, 0, deviceScale, 0, 0],
                });
                await renderTask.promise;
            } catch (error) {
                if (!cancelled && error?.name !== "RenderingCancelledException") onError(error);
            } finally {
                renderTask = null;
                rendering = false;
            }
        }

        renderPage();
        const resizeObserver = new ResizeObserver(renderPage);
        if (pageFrameRef.current) resizeObserver.observe(pageFrameRef.current);
        return () => {
            cancelled = true;
            resizeObserver.disconnect();
            renderTask?.cancel();
        };
    }, [pdf, pageNumber, onError]);

    return (
        <div className="pdf-page-frame" ref={pageFrameRef}>
            <div className="pdf-page-surface" ref={pageSurfaceRef}>
                <div className="pdf-canvas-layer">
                    <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
                </div>
                {showOverlays && (
                    <div className="pdf-overlay-layer">
                        {(pageData?.fields || []).map((field) => (
                            <PdfFieldOverlay
                                key={field.name}
                                field={{ ...field, page: pageNumber }}
                                pageSize={pageData.size}
                                mappingInfo={mappedDetailsByPdf[field.name]}
                                activeSource={activeSource}
                                isSelected={selectedField?.name === field.name}
                                onSelect={onFieldSelect}
                                onEdit={onFieldEdit}
                                onRemove={onFieldRemove}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function PdfViewer({
    source,
    pages = [],
    mappedDetailsByPdf = {},
    sourceOptions = [],
    activeSource,
    onFieldSelect,
    onRemoveMapping,
    onEditMapping,
    onReassignMapping,
}) {
    const [pdf, setPdf] = useState(null);
    const [loadedSource, setLoadedSource] = useState("");
    const [pageNumber, setPageNumber] = useState(1);
    const [error, setError] = useState("");
    const [hoveredField, setHoveredField] = useState(null);
    const [selectedField, setSelectedField] = useState(null);
    const [isEditingField, setIsEditingField] = useState(false);
    const [selectedSourceKey, setSelectedSourceKey] = useState("");
    const [showOverlays, setShowOverlays] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function loadPdf() {
            if (!source) {
                if (!cancelled) {
                    setPdf(null);
                    setError("No PDF template source selected.");
                }
                return;
            }

            try {
                if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
                    const task = pdfjsLib.getDocument({ data: source });
                    const doc = await task.promise;
                    if (!cancelled) {
                        setPdf(doc);
                        setLoadedSource(source);
                        setPageNumber(1);
                        setError("");
                    }
                    return;
                }

                if (typeof source === "string") {
                    const result = await fetchPdfBytes(source);
                    if (cancelled) return;
                    if (result?.bytes) {
                        const task = pdfjsLib.getDocument({ data: result.bytes });
                        const doc = await task.promise;
                        if (!cancelled) {
                            setPdf(doc);
                            setLoadedSource(source);
                            setPageNumber(1);
                            setError("");
                        }
                        return;
                    }

                    // Fallback to direct URL if fetchPdfBytes returned null
                    const task = pdfjsLib.getDocument({ url: source });
                    const doc = await task.promise;
                    if (!cancelled) {
                        setPdf(doc);
                        setLoadedSource(source);
                        setPageNumber(1);
                        setError("");
                    }
                }
            } catch (err) {
                console.error("PdfViewer error loading template:", err);
                if (!cancelled) {
                    setLoadedSource(source);
                    setError("Unable to load PDF template. " + (err.message || "Please check network or template source."));
                }
            }
        }

        loadPdf();
        return () => {
            cancelled = true;
        };
    }, [source]);

    function handleRenderError() {
        setError("Unable to load PDF template.");
    }

    function handleFieldSelect(field) {
        if (activeSource) {
            onFieldSelect?.(field);
            setSelectedField(field);
            setIsEditingField(false);
            return;
        }
        setSelectedField(field);
        setHoveredField(field);
        const mapped = mappedDetailsByPdf[field.name];
        if (mapped) {
            setSelectedSourceKey(mapped.sourceInputId ? `${mapped.sourceFieldId}:${mapped.sourceInputId}` : String(mapped.sourceFieldId || ""));
        } else {
            setSelectedSourceKey("");
        }
    }

    function handleFieldEdit(field) {
        setSelectedField(field);
        setHoveredField(field);
        setIsEditingField(true);
        const mapped = mappedDetailsByPdf[field.name];
        if (mapped) {
            setSelectedSourceKey(mapped.sourceInputId ? `${mapped.sourceFieldId}:${mapped.sourceInputId}` : String(mapped.sourceFieldId || ""));
        } else {
            setSelectedSourceKey("");
        }
        onEditMapping?.(field);
    }

    function handleFieldRemove(fieldName) {
        onRemoveMapping?.(fieldName);
        setIsEditingField(false);
    }

    function handleApplyReassign() {
        const targetField = selectedField || hoveredField;
        if (!targetField || !selectedSourceKey) return;
        onReassignMapping?.(targetField.name, selectedSourceKey);
        setIsEditingField(false);
    }

    if (error) return <div className="pdf-error" role="alert">{error}</div>;
    if (!pdf || loadedSource !== source) return <div className="pdf-loading">Loading PDF template...</div>;

    const pageData = pages[pageNumber - 1] || { size: { width: 1, height: 1 }, fields: [] };
    const activeDisplayField = selectedField || hoveredField;
    const activeMapping = activeDisplayField ? mappedDetailsByPdf[activeDisplayField.name] : null;
    const isEditing = Boolean(isEditingField && !activeSource);

    return (
        <div className="pdf-viewer">
            <div className="pdf-navigation">
                <button
                    type="button"
                    onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
                    disabled={pageNumber === 1}
                >
                    Previous
                </button>
                <span>Page {pageNumber} of {pdf.numPages}</span>
                <button
                    type="button"
                    onClick={() => setPageNumber((current) => Math.min(pdf.numPages, current + 1))}
                    disabled={pageNumber === pdf.numPages}
                >
                    Next
                </button>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
                    <button
                        type="button"
                        onClick={() => setShowOverlays((v) => !v)}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            height: "30px",
                            padding: "0 10px",
                            fontSize: "11px",
                            fontWeight: "600",
                            background: showOverlays ? "#f0f6f4" : "#ffffff",
                            borderColor: showOverlays ? "#176b50" : "#c6d1d1",
                            color: showOverlays ? "#176b50" : "#506762",
                            cursor: "pointer",
                            borderRadius: "3px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                        }}
                        title={showOverlays ? "Hide mapping overlays to view clean original PDF template" : "Show mapping overlays to interact with form fields"}
                    >
                        {showOverlays ? (
                            <>
                                <Eye size={13} />
                                <span>Overlays: Visible</span>
                            </>
                        ) : (
                            <>
                                <EyeOff size={13} />
                                <span>Clean PDF (No Overlays)</span>
                            </>
                        )}
                    </button>
                </div>
            </div>
            {activeSource && (
                <div className="mapping-mode">
                    Mapping: Gravity Forms <strong>→ {activeSource.label}</strong>
                    <span>Click a PDF field to assign target</span>
                </div>
            )}
            {activeDisplayField ? (
                <div className={`pdf-field-toolbar ${activeMapping ? "is-mapped-active" : ""}`}>
                    <div className="field-info-meta">
                        <strong>{humanizePdfFieldName(activeDisplayField.name)}</strong>
                        <span className="field-meta-tag">PDF Field ID: <code>{activeDisplayField.name}</code></span>
                        <span className="field-meta-tag">Page {activeDisplayField.page || pageNumber}</span>
                        <span className="field-meta-tag">{pdfFieldType(activeDisplayField)}</span>
                        {activeMapping ? (
                            <span className="field-mapped-indicator">
                                Mapped: <strong>{activeMapping.label}</strong>
                                {activeMapping.mappedValue ? (
                                    <span className="field-mapped-val"> · Value: <code>"{activeMapping.mappedValue}"</code></span>
                                ) : null}
                            </span>
                        ) : (
                            <span className="field-unmapped-indicator">Unmapped</span>
                        )}
                    </div>
                    <div className="field-toolbar-actions">
                        {isEditing && activeDisplayField ? (
                            <div className="inline-edit-group">
                                <label className="inline-edit-label">
                                    <span>Map to:</span>
                                    <select
                                        value={selectedSourceKey}
                                        onChange={(e) => setSelectedSourceKey(e.target.value)}
                                    >
                                        <option value="">-- Select Source Field --</option>
                                        {sourceOptions.map((opt) => (
                                            <option key={opt.key} value={opt.key}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <button
                                    type="button"
                                    className="action-btn-apply"
                                    disabled={!selectedSourceKey}
                                    onClick={handleApplyReassign}
                                >
                                    Apply
                                </button>
                                <button
                                    type="button"
                                    className="action-btn-cancel"
                                    onClick={() => setIsEditingField(false)}
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : activeMapping ? (
                            <>
                                <button
                                    type="button"
                                    className="action-btn-edit"
                                    onClick={() => handleFieldEdit(activeDisplayField)}
                                    title="Edit mapping / change source"
                                >
                                    Edit Mapping
                                </button>
                                <button
                                    type="button"
                                    className="action-btn-remove"
                                    onClick={() => handleFieldRemove(activeDisplayField.name)}
                                    title="Remove mapping from this field"
                                >
                                    Remove Mapping
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                className="action-btn-edit"
                                onClick={() => handleFieldEdit(activeDisplayField)}
                                title="Map this PDF field to a Gravity Form field"
                            >
                                + Map Field
                            </button>
                        )}
                    </div>
                </div>
            ) : (
                <div className="pdf-field-info pdf-field-hint">
                    <span>Hover or click any field in the PDF template to inspect, edit, or remove its mapping.</span>
                </div>
            )}
            <PdfPage
                pdf={pdf}
                pageNumber={pageNumber}
                pageData={pageData}
                mappedDetailsByPdf={mappedDetailsByPdf}
                activeSource={activeSource}
                selectedField={selectedField}
                showOverlays={showOverlays}
                onFieldSelect={handleFieldSelect}
                onFieldEdit={handleFieldEdit}
                onFieldRemove={handleFieldRemove}
                onError={handleRenderError}
            />
        </div>
    );
}
