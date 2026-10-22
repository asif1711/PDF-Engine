import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * Ingest and analyze a PDF binary buffer directly in the browser using pdf-lib + PDF.js.
 * Produces the two-layer template-analysis.json structure.
 * 
 * Layer 1 (Technical): AcroForm field definitions and types via pdf-lib.
 * Layer 2 (Context): Page geometry, printed text tokens, and widget annotations via PDF.js.
 */
export async function analyzePdfBytes(bytes, filename = "template.pdf") {
    if (!bytes || !(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) {
        throw new Error("Invalid PDF bytes provided for analysis.");
    }

    const uint8Bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    // =========================================================
    // LAYER 1 — TECHNICAL (pdf-lib)
    // =========================================================
    let pdfDoc;
    try {
        pdfDoc = await PDFDocument.load(uint8Bytes, { ignoreEncryption: true });
    } catch (err) {
        throw new Error(`Failed to load PDF document: ${err.message}`, { cause: err });
    }

    let technicalFields = [];
    try {
        const form = pdfDoc.getForm();
        technicalFields = form.getFields().map((field) => ({
            name: field.getName(),
            type: field.constructor.name,
        }));
    } catch (err) {
        console.warn("Could not extract AcroForm from PDF:", err);
    }

    // =========================================================
    // LAYER 2 — CONTEXT (PDF.js)
    // =========================================================
    // Clone buffer for PDF.js to avoid detached ArrayBuffer issues
    const pdfjsData = new Uint8Array(uint8Bytes.slice());
    const loadingTask = pdfjsLib.getDocument({
        data: pdfjsData,
        disableFontFace: true,
    });

    const pdf = await loadingTask.promise;
    const contextPages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });

        // 1. Read all printed text tokens
        const textContent = await page.getTextContent();
        const text = (textContent.items || [])
            .filter((item) => item.str && item.str.trim())
            .map((item) => ({
                text: item.str.trim(),
                x: item.transform[4],
                y: viewport.height - item.transform[5],
                width: item.width,
                height: item.height,
            }));

        // 2. Read PDF form widget annotations
        const annotations = await page.getAnnotations({ intent: "display" });
        const fields = (annotations || [])
            .filter((annotation) => annotation.subtype === "Widget" && annotation.fieldName)
            .map((annotation) => {
                const rect = annotation.rect || [0, 0, 0, 0];
                return {
                    name: annotation.fieldName,
                    type: annotation.fieldType || "Tx",
                    x: rect[0],
                    y: viewport.height - rect[3],
                    width: rect[2] - rect[0],
                    height: rect[3] - rect[1],
                };
            });

        contextPages.push({
            page: pageNumber,
            size: {
                width: viewport.width,
                height: viewport.height,
            },
            text,
            fields,
        });
    }

    const cleanFilename = String(filename || "template.pdf").replace(/\\/g, "/").split("/").pop();

    return {
        template: {
            filename: cleanFilename,
            path: cleanFilename,
        },
        technical: {
            pdfType: "PDF",
            pages: pdfDoc.getPageCount(),
            hasAcroForm: technicalFields.length > 0,
            fieldCount: technicalFields.length,
            fields: technicalFields,
        },
        context: {
            pages: contextPages,
        },
    };
}
