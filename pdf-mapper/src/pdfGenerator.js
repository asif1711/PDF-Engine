import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, StandardFonts, rgb } from "pdf-lib";

/**
 * Format a date string based on format pattern.
 */
export function formatDate(dateValue, format = "DD/MM/YYYY") {
    if (!dateValue) return "";
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return String(dateValue);

    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = String(date.getFullYear());
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthName = monthNames[date.getMonth()] || month;

    if (format === "YYYY-MM-DD") return `${year}-${month}-${day}`;
    if (format === "DD Month YYYY") return `${day} ${monthName} ${year}`;
    return `${day}/${month}/${year}`;
}

/**
 * Detect and extract all uploaded file documents from a Gravity Forms entry.
 * Supports:
 * - Multi-file upload fields (JSON-encoded array of URLs)
 * - Single-file upload fields (string URLs)
 * - Raw arrays of URLs
 */
export function extractUploadedFilesFromEntry(rawEntry) {
    if (!rawEntry || typeof rawEntry !== "object") return [];
    const files = [];

    // If pre-indexed by backend
    if (Array.isArray(rawEntry._uploaded_files) && rawEntry._uploaded_files.length > 0) {
        return rawEntry._uploaded_files.map((f) => ({
            fieldId: String(f.field_id || f.fieldId || ""),
            url: f.url,
            filename: f.filename || decodeURIComponent((f.url || "").split("/").pop() || "attachment"),
        }));
    }

    for (const [key, val] of Object.entries(rawEntry)) {
        if (!val) continue;

        if (Array.isArray(val)) {
            val.forEach((item) => {
                if (typeof item === "string" && (item.startsWith("http") || item.includes("/uploads/"))) {
                    const filename = decodeURIComponent(item.split("/").pop() || "attachment");
                    files.push({ fieldId: key, url: item, filename });
                } else if (item && typeof item === "object" && item.url) {
                    files.push({ fieldId: key, url: item.url, filename: item.filename || item.name || "attachment" });
                }
            });
            continue;
        }

        if (typeof val !== "string") continue;
        const trimmed = val.trim();

        // Multi-file upload JSON array string: ["http://..."]
        if (trimmed.startsWith("[") && (trimmed.includes("http") || trimmed.includes("uploads") || trimmed.includes("gravity_forms"))) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    parsed.forEach((url) => {
                        if (typeof url === "string" && (url.startsWith("http") || url.includes("/uploads/"))) {
                            const filename = decodeURIComponent(url.split("/").pop() || "attachment");
                            files.push({ fieldId: key, url, filename });
                        }
                    });
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (trimmed.startsWith("http") && (trimmed.includes("/uploads/") || trimmed.includes("/gravity_forms/") || /\.(pdf|png|jpe?g|webp|gif)$/i.test(trimmed))) {
            const filename = decodeURIComponent(trimmed.split("/").pop() || "attachment");
            files.push({ fieldId: key, url: trimmed, filename });
        }
    }

    return files;
}

/**
 * Securely download and attach/embed uploaded files to a PDF document.
 * 1. Attaches raw file into PDF embedded files catalog (Acrobat attachments paperclip).
 * 2. Appends visual pages for PDFs (merged pages) and images (scaled A4 view).
 */
export async function attachUploadedFilesToPdf(pdfDoc, files, options = {}) {
    if (!Array.isArray(files) || files.length === 0) return [];
    const { formsUrl, apiKey, helveticaFont } = options;
    const font = helveticaFont || (await pdfDoc.embedFont(StandardFonts.Helvetica));
    const attachmentResults = [];

    for (const fileInfo of files) {
        try {
            const rawUrl = fileInfo.url;
            if (!rawUrl) continue;

            // Normalize URL: replace local development host with live forms URL if applicable
            let downloadUrl = rawUrl;
            if (formsUrl) {
                try {
                    const parsedRaw = new URL(rawUrl);
                    const parsedForms = new URL(formsUrl);
                    downloadUrl = parsedForms.origin + parsedRaw.pathname + parsedRaw.search;
                } catch {
                    // Ignore URL parsing errors
                }
            }

            // Fetch via proxy (with API key) or direct
            const proxyTarget = `/api/wp-proxy?url=${encodeURIComponent(downloadUrl)}${apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : ""}`;
            let response;
            try {
                response = await fetch(proxyTarget);
            } catch {
                try {
                    response = await fetch(downloadUrl);
                } catch (fetchErr) {
                    attachmentResults.push({
                        filename: fileInfo.filename,
                        status: "download_failed",
                        error: fetchErr.message,
                    });
                    continue;
                }
            }

            if (!response || !response.ok) {
                attachmentResults.push({
                    filename: fileInfo.filename,
                    status: "download_failed",
                    error: `HTTP ${response?.status || "unavailable"}`,
                });
                continue;
            }

            const arrayBuf = await response.arrayBuffer();
            const bytes = new Uint8Array(arrayBuf);
            if (bytes.byteLength === 0) {
                attachmentResults.push({
                    filename: fileInfo.filename,
                    status: "empty_file",
                });
                continue;
            }

            const lowerName = (fileInfo.filename || "").toLowerCase();
            let mimeType = "application/octet-stream";
            if (lowerName.endsWith(".pdf")) mimeType = "application/pdf";
            else if (lowerName.endsWith(".png")) mimeType = "image/png";
            else if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) mimeType = "image/jpeg";
            else if (lowerName.endsWith(".webp")) mimeType = "image/webp";

            // 1. Embed as native PDF file attachment (accessible via Adobe Acrobat / Reader attachments panel)
            try {
                await pdfDoc.attach(bytes, fileInfo.filename, {
                    mimeType,
                    description: `Gravity Forms Upload (Field #${fileInfo.fieldId || ""}): ${fileInfo.filename}`,
                });
            } catch (attachErr) {
                console.warn(`Could not register ${fileInfo.filename} in PDF attachments:`, attachErr);
            }

            // 2. Visually append pages into document
            if (lowerName.endsWith(".pdf")) {
                try {
                    const uploadedDoc = await PDFDocument.load(bytes);
                    const pageIndices = uploadedDoc.getPageIndices();
                    const copiedPages = await pdfDoc.copyPages(uploadedDoc, pageIndices);
                    for (const copiedPage of copiedPages) {
                        pdfDoc.addPage(copiedPage);
                    }
                    attachmentResults.push({
                        filename: fileInfo.filename,
                        fieldId: fileInfo.fieldId,
                        status: "merged_and_attached",
                        pagesAppended: copiedPages.length,
                    });
                } catch (pdfMergeErr) {
                    attachmentResults.push({
                        filename: fileInfo.filename,
                        fieldId: fileInfo.fieldId,
                        status: "attached_as_file",
                        note: `Attached as file; visual page render skipped: ${pdfMergeErr.message}`,
                    });
                }
            } else if (lowerName.endsWith(".png") || lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
                try {
                    let embeddedImg;
                    if (lowerName.endsWith(".png")) {
                        embeddedImg = await pdfDoc.embedPng(bytes);
                    } else {
                        embeddedImg = await pdfDoc.embedJpg(bytes);
                    }

                    // A4 standard page dimensions
                    const pageWidth = 595.28;
                    const pageHeight = 841.89;
                    const page = pdfDoc.addPage([pageWidth, pageHeight]);

                    // Header title
                    page.drawText(`Attached Supporting Document: ${fileInfo.filename}`, {
                        x: 40,
                        y: pageHeight - 38,
                        size: 11,
                        font,
                        color: rgb(0.12, 0.25, 0.2),
                    });

                    // Subtitle metadata
                    page.drawText(`Submitted via Gravity Forms Upload Field #${fileInfo.fieldId || "15"}`, {
                        x: 40,
                        y: pageHeight - 52,
                        size: 8.5,
                        font,
                        color: rgb(0.45, 0.52, 0.48),
                    });

                    // Draw image scaled to fit margins
                    const maxWidth = pageWidth - 80;
                    const maxHeight = pageHeight - 90;
                    const { width, height } = embeddedImg.scaleToFit(maxWidth, maxHeight);

                    page.drawImage(embeddedImg, {
                        x: (pageWidth - width) / 2,
                        y: (pageHeight - 65 - height) / 2 + 10,
                        width,
                        height,
                    });

                    attachmentResults.push({
                        filename: fileInfo.filename,
                        fieldId: fileInfo.fieldId,
                        status: "embedded_and_attached",
                        pagesAppended: 1,
                    });
                } catch (imgEmbedErr) {
                    attachmentResults.push({
                        filename: fileInfo.filename,
                        fieldId: fileInfo.fieldId,
                        status: "attached_as_file",
                        note: `Attached as file; visual embed skipped: ${imgEmbedErr.message}`,
                    });
                }
            } else {
                attachmentResults.push({
                    filename: fileInfo.filename,
                    fieldId: fileInfo.fieldId,
                    status: "attached_as_file",
                });
            }
        } catch (err) {
            attachmentResults.push({
                filename: fileInfo.filename,
                fieldId: fileInfo.fieldId,
                status: "error",
                error: err.message,
            });
        }
    }

    return attachmentResults;
}

/**
 * Extract raw field value from a Gravity Forms entry.
 * Supports:
 * - Direct input ID matches (e.g., "1.3", "19.1")
 * - Direct field ID matches (e.g., "4", "3", "26")
 * - Gravity Forms compound sub-keys strictly under `{fieldId}.*`
 * 
 * Strict rules:
 * 1. Explicit Sub-Input ID: Look up entry[inputId]. If the key exists, return its value (even if "").
 * 2. Field ID: If entry[fieldId] exists as a primitive string or number, return it directly.
 *    If it is "" (empty/hidden), return "". Never cross over to another field ID.
 *    If entry[fieldId] is not a direct primitive, inspect ONLY compound sub-keys strictly under `${fieldId}.*`.
 * 3. Never cross field IDs or use loose label heuristics.
 */
export function extractEntryValue(entry, fieldId, inputId) {
    if (!entry || typeof entry !== "object") return "";

    const strInputId = inputId !== undefined && inputId !== null ? String(inputId).trim() : "";
    const strFieldId = fieldId !== undefined && fieldId !== null ? String(fieldId).trim() : "";

    // 1. Explicit Sub-Input ID (e.g., 1.3, 19.1, 8.1)
    // Look up entry[inputId]. If the key exists in the entry, return its value (even if it is "").
    if (strInputId) {
        if (strInputId in entry && entry[strInputId] !== undefined && entry[strInputId] !== null) {
            return String(entry[strInputId]);
        }
    }

    // 2. Field ID (e.g., 4, 3, 19, 26)
    if (strFieldId) {
        // If entry[fieldId] exists as a string or number, return that value directly.
        // If it is "" (empty / hidden), return "". Never cross over to another field ID.
        if (strFieldId in entry && entry[strFieldId] !== undefined && entry[strFieldId] !== null) {
            const directVal = entry[strFieldId];
            if (typeof directVal !== "object") {
                return String(directVal);
            }
        }

        // If entry[fieldId] is not a direct primitive, inspect ONLY compound sub-keys that belong strictly to that field: entry[`${fieldId}.${subId}`]
        const subKeys = Object.keys(entry)
            .filter((k) => k.startsWith(`${strFieldId}.`))
            .sort((a, b) => parseFloat(a) - parseFloat(b));

        if (subKeys.length > 0) {
            const nonEmpties = subKeys
                .map((k) => entry[k])
                .filter((v) => v !== "" && v !== null && v !== undefined && typeof v !== "object");
            if (nonEmpties.length > 0) {
                return nonEmpties.join(" ");
            }
            return "";
        }
    }

    return "";
}

/**
 * Parse Gravity Forms list / repeating field data.
 * Handles:
 * - Native JavaScript arrays
 * - JSON encoded strings (e.g., '[{"Unit Code": "BSB401"}]')
 * - PHP serialized strings (e.g., 'a:1:{i:0;a:2:{s:9:"Unit Code";s:7:"2312312";...}}')
 * - Object dictionaries
 */
export function parseListRows(rawData) {
    if (!rawData) return [];
    if (Array.isArray(rawData)) return rawData;
    if (typeof rawData === "object" && rawData !== null) {
        return Object.values(rawData);
    }
    if (typeof rawData !== "string") return [];

    const trimmed = rawData.trim();
    if (!trimmed) return [];

    // Attempt JSON parse
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
            if (typeof parsed === "object" && parsed !== null) return Object.values(parsed);
        } catch {
            // Ignore JSON parse error and continue
        }
    }

    // Parse PHP serialized array (standard Gravity Forms list field format in WP MySQL database)
    if (trimmed.startsWith("a:") || trimmed.includes("s:")) {
        const rows = [];
        const itemRegex = /a:\d+:\{([^}]+)\}/g;
        let match;
        while ((match = itemRegex.exec(trimmed)) !== null) {
            const inner = match[1];
            const pairs = {};
            const pairRegex = /s:\d+:"([^"]*)";s:\d+:"([^"]*)";/g;
            let pm;
            while ((pm = pairRegex.exec(inner)) !== null) {
                pairs[pm[1]] = pm[2];
            }
            if (Object.keys(pairs).length > 0) {
                rows.push(pairs);
            }
        }
        if (rows.length > 0) return rows;
    }

    return [];
}

/**
 * Normalize submission payload to transparently handle wrapper shapes
 * like `{ entry_id, entry: { ... } }` or raw entry objects `{ "1.3": "...", ... }`.
 */
export function normalizeSubmissionData(rawSubmission) {
    if (!rawSubmission || typeof rawSubmission !== "object") return {};
    let base = { ...rawSubmission };
    if (rawSubmission.entry && typeof rawSubmission.entry === "object") {
        base = {
            ...rawSubmission,
            ...rawSubmission.entry,
        };
    }
    return base;
}

/**
 * Resolve the evaluated string value for a mapping given an entry.
 * Used for live debugging and mapping inspection in the UI.
 */
export function resolvePreviewValue(rawSubmission, mapping) {
    if (!rawSubmission || !mapping) return "";
    const submission = normalizeSubmissionData(rawSubmission);

    if (mapping.type === "system") {
        const rawDate = submission.date_created || submission.submitted_at || "";
        return rawDate ? formatDate(rawDate, mapping.source?.format || "DD/MM/YYYY") : "(submission date)";
    }

    if (mapping.type === "compose") {
        const parts = (mapping.sources || []).map((s) => {
            return extractEntryValue(submission, s.fieldId, s.inputId);
        }).filter((v) => v !== "" && v !== undefined && v !== null);
        const sep = mapping.literal !== undefined ? mapping.literal : (mapping.literals?.[0] || " ");
        return parts.join(sep);
    }

    if (mapping.type === "repeat") {
        const sourceFieldId = mapping.sourceFieldId || mapping.source?.fieldId;
        const rawList = submission[sourceFieldId];
        const rows = parseListRows(rawList);
        if (!rows || rows.length === 0) return "(No repeat rows found)";
        const count = rows.length;
        const first = rows[0];
        if (typeof first === "object" && first !== null) {
            const rowSummary = Object.entries(first).map(([k, v]) => `${k}: "${v}"`).join(", ");
            return `${count} row${count > 1 ? "s" : ""} (Row 1: ${rowSummary})`;
        }
        return `${count} row${count > 1 ? "s" : ""} (Row 1: ${String(first)})`;
    }

    const sourceFieldId = mapping.sourceFieldId || mapping.gravityFieldId || mapping.source?.fieldId;
    const sourceInputId = mapping.sourceInputId || mapping.source?.inputId;

    let val = extractEntryValue(submission, sourceFieldId, sourceInputId);

    if (mapping.gravityFieldType === "date" && val) {
        val = formatDate(val);
    }

    return val !== undefined && val !== null ? String(val) : "";
}

/**
 * Generate a filled PDF using the template, active mappings, and submission entry.
 */
export async function generateFilledPdf({
    templateBytes,
    mappings,
    submission: rawSubmission,
    flatten = false,
    formsUrl = "",
    apiKey = "",
    attachUploadedFiles = true,
}) {
    if (!templateBytes) {
        throw new Error("No PDF template data provided.");
    }

    const submission = normalizeSubmissionData(rawSubmission);
    const pdfDoc = await PDFDocument.load(templateBytes);
    const form = pdfDoc.getForm();
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const auditLog = [];
    const mappedPdfFieldNames = new Set();
    const filledPdfFieldNames = new Set();

    // Normalize mapping entries into a unified list
    const mappingList = Array.isArray(mappings)
        ? mappings
        : Object.values(mappings || {}).filter(Boolean);

    function fillAcroField(targetName, value, meta) {
        if (!targetName) return;
        mappedPdfFieldNames.add(targetName);

        const strVal = value !== undefined && value !== null ? String(value).trim() : "";

        // Exception 2: If field is empty or unmapped or hidden, keep that field untouched in the PDF template,
        // so it stays fillable even after generated.
        if (!strVal) {
            auditLog.push({
                targetName,
                value: "",
                status: "untouched_empty",
                meta,
            });
            return;
        }

        try {
            const field = form.getField(targetName);
            if (!field) {
                auditLog.push({
                    targetName,
                    value: strVal,
                    status: "not_found_in_pdf",
                    meta,
                });
                return;
            }

            if (field instanceof PDFTextField) {
                field.setText(strVal);
                filledPdfFieldNames.add(targetName);

                // Enforce uniform font size across all filled text fields.
                // Standard font size is 10pt (prevents oversized tall fields like USI from blowing up to 24pt).
                const standardFontSize = 10;
                let calculatedFontSize = standardFontSize;
                try {
                    const widgets = field.acroField?.getWidgets?.() || [];
                    if (widgets.length > 0 && strVal) {
                        const rect = widgets[0].getRectangle();
                        const availableWidth = rect.width - 4;
                        const textWidthAt10 = helveticaFont.widthOfTextAtSize(strVal, standardFontSize);
                        if (textWidthAt10 > availableWidth && availableWidth > 15) {
                            // Proportionally scale down narrow table columns / long text so it never clips
                            calculatedFontSize = Math.max(6.5, Math.floor((availableWidth / textWidthAt10) * standardFontSize * 10) / 10);
                        }
                    }
                } catch {
                    calculatedFontSize = standardFontSize;
                }
                try {
                    field.setFontSize(calculatedFontSize);
                } catch {
                    // Ignore if font size cannot be set
                }

                auditLog.push({
                    targetName,
                    value: strVal,
                    fieldType: "Text",
                    status: "filled",
                    fontSize: calculatedFontSize,
                    meta,
                });
            } else if (field instanceof PDFCheckBox) {
                const isChecked = strVal === "1" || strVal.toLowerCase() === "true" || strVal.toLowerCase() === "yes" || strVal.toLowerCase() === "on";
                if (isChecked) {
                    field.check();
                    filledPdfFieldNames.add(targetName);
                }
                auditLog.push({
                    targetName,
                    value: isChecked ? "Checked" : "Untouched",
                    fieldType: "CheckBox",
                    status: isChecked ? "filled" : "untouched_empty",
                    meta,
                });
            } else if (field instanceof PDFDropdown) {
                try {
                    field.select(strVal);
                    filledPdfFieldNames.add(targetName);
                } catch {
                    // If option doesn't exist in predefined list, try setting text
                }
                auditLog.push({
                    targetName,
                    value: strVal,
                    fieldType: "Dropdown",
                    status: "filled",
                    meta,
                });
            } else if (field instanceof PDFRadioGroup) {
                try {
                    field.select(strVal);
                    filledPdfFieldNames.add(targetName);
                } catch {
                    // Ignore radio mismatch
                }
                auditLog.push({
                    targetName,
                    value: strVal,
                    fieldType: "Radio",
                    status: "filled",
                    meta,
                });
            } else {
                auditLog.push({
                    targetName,
                    value: strVal,
                    fieldType: field.constructor.name,
                    status: "unsupported_field_type",
                    meta,
                });
            }
        } catch (err) {
            auditLog.push({
                targetName,
                value: strVal,
                status: "error",
                error: err.message,
                meta,
            });
        }
    }

    for (const item of mappingList) {
        if (!item) continue;

        // DIRECT MAPPING
        if (item.type === "direct" || (!item.type && (item.pdfField || item.pdfFieldName || item.targetField || item.target?.fieldName))) {
            const targetPdfField = item.pdfField || item.target?.fieldName || item.targetField || item.pdfFieldName;
            const sourceFieldId = item.sourceFieldId || item.gravityFieldId || item.source?.fieldId;
            const sourceInputId = item.sourceInputId || item.source?.inputId;
            let val = extractEntryValue(submission, sourceFieldId, sourceInputId);

            // Format dates if gravity field type is date
            let finalVal = val;
            if (item.gravityFieldType === "date" && val) {
                finalVal = formatDate(val);
            }

            fillAcroField(targetPdfField, finalVal, {
                sourceLabel: item.gravityFieldLabel || item.inputLabel || `Field ${sourceFieldId}`,
                sourceId: sourceInputId || sourceFieldId,
                type: "direct",
            });
        }

        // ONE TO MANY MAPPING
        else if (item.type === "one_to_many") {
            const sourceFieldId = item.sourceFieldId || item.source?.fieldId;
            const sourceInputId = item.sourceInputId || item.source?.inputId;
            const val = extractEntryValue(submission, sourceFieldId, sourceInputId);
            const targets = item.targets || [];
            targets.forEach((target) => {
                fillAcroField(target.fieldName, val, {
                    sourceLabel: item.gravityFieldLabel || `Field ${sourceFieldId}`,
                    sourceId: sourceInputId || sourceFieldId,
                    type: "one_to_many",
                });
            });
        }

        // COMPOSE / COMBINE MAPPING
        else if (item.type === "compose") {
            const targetPdfField = item.pdfField || item.target?.fieldName;
            const sources = item.sources || [];
            const separator = item.literal || " ";
            const combinedValue = sources
                .map((s) => extractEntryValue(submission, s.fieldId, s.inputId))
                .filter((v) => v !== "" && v !== null && v !== undefined)
                .join(separator);

            fillAcroField(targetPdfField, combinedValue, {
                sourceLabel: sources.map((s) => s.label || s.fieldId).join(" + "),
                type: "compose",
            });
        }

        // SYSTEM VALUE MAPPING
        else if (item.type === "system") {
            const targetPdfField = item.pdfField || item.target?.fieldName;
            const systemKey = item.source?.systemKey || item.systemKey || "submission.date_created";
            let rawDate = submission?.date_created || submission?.submitted_at || new Date().toISOString();
            if (systemKey === "submission.date_created" && submission?.date_created) {
                rawDate = submission.date_created;
            }
            const formatted = formatDate(rawDate, item.source?.format || "DD/MM/YYYY");

            fillAcroField(targetPdfField, formatted, {
                sourceLabel: "Submission Date (System)",
                type: "system",
            });
        }

        // REPEATING LIST / TABLE MAPPING
        else if (item.type === "repeat") {
            const sourceFieldId = item.sourceFieldId || item.gravityFieldId || item.source?.fieldId;
            const rawList = submission?.[sourceFieldId] || submission?.[item.repeatCountFieldId];

            const rows = parseListRows(rawList);
            const children = item.children || [];

            rows.forEach((row, rowIndex) => {
                const oneBasedIndex = rowIndex + 1;
                children.forEach((child) => {
                    const targetName = String(child.targetPattern || "").replace("{index}", oneBasedIndex);
                    
                    // Match value by input label or row keys
                    let val = "";
                    if (typeof row === "object" && row !== null) {
                        if (child.inputLabel && row[child.inputLabel] !== undefined) {
                            val = row[child.inputLabel];
                        } else if (child.sourceInputId && row[child.sourceInputId] !== undefined) {
                            val = row[child.sourceInputId];
                        } else {
                            // Try common field variations (e.g. Unit Code, Unit Title / Unit Name)
                            const targetNorm = String(child.inputLabel || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                            const labelKey = Object.keys(row).find((k) => {
                                const kNorm = k.toLowerCase().replace(/[^a-z0-9]/g, "");
                                if (kNorm === targetNorm) return true;
                                if ((targetNorm.includes("title") || targetNorm.includes("name")) && (kNorm.includes("title") || kNorm.includes("name"))) return true;
                                if (targetNorm.includes("code") && kNorm.includes("code")) return true;
                                return false;
                            });
                            if (labelKey) {
                                val = row[labelKey];
                            }
                        }
                    } else if (typeof row === "string") {
                        val = row;
                    }

                    fillAcroField(targetName, val, {
                        sourceLabel: `${item.gravityFieldLabel || "List"} Row ${oneBasedIndex} (${child.inputLabel})`,
                        type: "repeat",
                        rowIndex: oneBasedIndex,
                    });
                });
            });
        }
    }

    // Requirement: Only fields actually filled with data become read-only.
    // If a field is empty, hidden, or unmapped, keep it untouched and fillable.
    try {
        const allPdfFields = form.getFields();
        for (const field of allPdfFields) {
            const fieldName = field.getName();
            if (filledPdfFieldNames.has(fieldName)) {
                try {
                    field.enableReadOnly();
                } catch {
                    // Ignore specialized field errors
                }
            } else {
                try {
                    field.disableReadOnly();
                } catch {
                    // Ignore
                }
            }
        }
    } catch (fieldLockErr) {
        console.warn("Could not set field read-only flags:", fieldLockErr);
    }

    // Refresh appearances so all text fields render consistently with the embedded font and exact font size
    try {
        form.updateFieldAppearances(helveticaFont);
    } catch (appErr) {
        console.warn("Could not update field appearances:", appErr);
    }

    if (flatten) {
        try {
            form.flatten();
        } catch (flattenErr) {
            console.warn("Could not flatten PDF form:", flattenErr);
        }
    }

    // Securely attach and embed uploaded Gravity Forms files (transcripts, certificates, IDs, photos)
    let attachedFiles = [];
    if (attachUploadedFiles) {
        const detectedFiles = extractUploadedFilesFromEntry(rawSubmission);
        if (detectedFiles.length > 0) {
            attachedFiles = await attachUploadedFilesToPdf(pdfDoc, detectedFiles, {
                formsUrl,
                apiKey,
                helveticaFont,
            });
        }
    }

    const filledPdfBytes = await pdfDoc.save();
    let blobUrl = "";
    try {
        if (typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
            const blob = new Blob([filledPdfBytes], { type: "application/pdf" });
            blobUrl = URL.createObjectURL(blob);
        }
    } catch {
        blobUrl = "";
    }

    return {
        pdfBytes: filledPdfBytes,
        blobUrl,
        auditLog,
        filledCount: auditLog.filter((log) => log.status === "filled").length,
        attachedFiles,
    };
}
