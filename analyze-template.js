import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument } from "pdf-lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function analyzePdfBytes(bytes, filename = "template.pdf") {
    const pdfjs = await import(
        "pdfjs-dist/legacy/build/pdf.mjs"
    );

    const uint8Bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    // =========================================================
    // LAYER 1 — TECHNICAL
    // =========================================================

    const pdfDoc = await PDFDocument.load(uint8Bytes, { ignoreEncryption: true });
    const form = pdfDoc.getForm();

    const technicalFields = form.getFields().map(field => ({
        name: field.getName(),
        type: field.constructor.name
    }));

    // =========================================================
    // LAYER 2 — CONTEXT
    // =========================================================

    const loadingTask = pdfjs.getDocument({
        data: uint8Bytes
    });

    const pdf = await loadingTask.promise;

    const contextPages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {

        const page = await pdf.getPage(pageNumber);

        const viewport = page.getViewport({
            scale: 1
        });

        // -----------------------------------------------------
        // Read all printed PDF text
        // -----------------------------------------------------

        const textContent = await page.getTextContent();

        const text = textContent.items
            .filter(item =>
                item.str &&
                item.str.trim()
            )
            .map(item => ({
                text: item.str.trim(),

                x: item.transform[4],

                y:
                    viewport.height -
                    item.transform[5],

                width: item.width,

                height: item.height
            }));

        // -----------------------------------------------------
        // Read PDF form widgets
        // -----------------------------------------------------

        const annotations =
            await page.getAnnotations({
                intent: "display"
            });

        const fields = annotations
            .filter(annotation =>
                annotation.subtype === "Widget" &&
                annotation.fieldName
            )
            .map(annotation => {

                const rect = annotation.rect;

                return {
                    name: annotation.fieldName,

                    type: annotation.fieldType,

                    x: rect[0],

                    y:
                        viewport.height -
                        rect[3],

                    width:
                        rect[2] -
                        rect[0],

                    height:
                        rect[3] -
                        rect[1]
                };
            });

        // -----------------------------------------------------
        // Store complete page context
        // -----------------------------------------------------

        contextPages.push({
            page: pageNumber,

            size: {
                width: viewport.width,
                height: viewport.height
            },

            text,

            fields
        });
    }

    // =========================================================
    // FINAL TWO-LAYER RESULT
    // =========================================================

    const cleanFilename = String(filename || "template.pdf").replace(/\\/g, "/").split("/").pop();

    return {
        template: {
            filename: cleanFilename,
            path: cleanFilename
        },

        technical: {
            pdfType: "PDF",

            pages: pdfDoc.getPageCount(),

            hasAcroForm:
                technicalFields.length > 0,

            fieldCount:
                technicalFields.length,

            fields:
                technicalFields
        },

        context: {
            pages:
                contextPages
        }
    };
}

export async function analyzePdf(pdfPath) {
    const bytes = new Uint8Array(fs.readFileSync(pdfPath));
    const result = await analyzePdfBytes(bytes, path.basename(pdfPath));
    result.template.path = pdfPath;
    return result;
}

// =============================================================
// COMMAND LINE
// =============================================================

const isDirectCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectCli) {
    const pdfPath = process.argv[2];

    if (!pdfPath) {
        console.error(
            "Usage: node analyze-template.js <pdf>"
        );

        process.exit(1);
    }

    analyzePdf(pdfPath)
        .then(result => {

            const outputPath = process.argv[3] || path.join(
                __dirname,
                "template-analysis.json"
            );

            fs.writeFileSync(
                outputPath,
                JSON.stringify(
                    result,
                    null,
                    2
                )
            );

            console.log(
                "Template analysis complete."
            );

            console.log(
                `Pages: ${result.technical.pages}`
            );

            console.log(
                `AcroForm: ${
                    result.technical.hasAcroForm
                        ? "Yes"
                        : "No"
                }`
            );

            console.log(
                `Fields: ${result.technical.fieldCount}`
            );

            console.log(
                `Output: ${outputPath}`
            );
        })
        .catch(error => {

            console.error(
                "Template analysis failed:"
            );

            console.error(error);

            process.exit(1);
        });
}