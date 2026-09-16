import java.io.File;
import java.io.IOException;
import java.util.List;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;

public class AnalyzeTemplate {

    public static void main(String[] args) throws Exception {

        if (args.length != 1) {
            System.out.println(
                "Usage: java AnalyzeTemplate <pdf>"
            );
            System.exit(1);
        }

        File pdfFile = new File(args[0]);

        try (PDDocument document = Loader.loadPDF(pdfFile)) {

            System.out.println("=================================");
            System.out.println("PDF TEMPLATE ANALYSIS");
            System.out.println("=================================");

            // =================================================
            // LAYER 1 — TECHNICAL
            // =================================================

            System.out.println();
            System.out.println("=== LAYER 1: TECHNICAL ===");

            System.out.println("PDF Type: PDF");

            int pageCount =
                document.getNumberOfPages();

            System.out.println(
                "Pages: " + pageCount
            );

            PDAcroForm acroForm =
                document.getDocumentCatalog().getAcroForm();

            boolean hasAcroForm =
                acroForm != null;

            System.out.println(
                "AcroForm: " +
                (hasAcroForm ? "Yes" : "No")
            );

            if (hasAcroForm) {

                int fieldCount = 0;

                for (PDField field :
                     acroForm.getFieldTree()) {

                    fieldCount++;

                    System.out.println();
                    System.out.println(
                        "Field: " +
                        field.getFullyQualifiedName()
                    );

                    System.out.println(
                        "Type: " +
                        field.getFieldType()
                    );

                    List<PDAnnotationWidget> widgets =
                        field.getWidgets();

                    if (widgets != null) {

                        for (PDAnnotationWidget widget :
                             widgets) {

                            PDRectangle rect =
                                widget.getRectangle();

                            if (rect != null) {

                                System.out.println(
                                    "Position: " +
                                    "x=" +
                                    rect.getLowerLeftX() +
                                    ", y=" +
                                    rect.getLowerLeftY() +
                                    ", width=" +
                                    rect.getWidth() +
                                    ", height=" +
                                    rect.getHeight()
                                );
                            }
                        }
                    }
                }

                System.out.println();
                System.out.println(
                    "Field Count: " + fieldCount
                );
            }

            // =================================================
            // LAYER 2 — CONTEXT
            // =================================================

            System.out.println();
            System.out.println("=== LAYER 2: CONTEXT ===");

            for (
                int pageNumber = 1;
                pageNumber <= pageCount;
                pageNumber++
            ) {

                PDPage page =
                    document.getPage(pageNumber - 1);

                PDRectangle pageSize =
                    page.getMediaBox();

                System.out.println();
                System.out.println(
                    "--- PAGE " +
                    pageNumber +
                    " ---"
                );

                System.out.println(
                    "Width: " +
                    pageSize.getWidth()
                );

                System.out.println(
                    "Height: " +
                    pageSize.getHeight()
                );

                // ---------------------------------------------
                // Printed text + positions
                // ---------------------------------------------

                PDFTextStripper stripper =
                    new PDFTextStripper() {

                        @Override
                        protected void writeString(
                            String text,
                            List<TextPosition> positions
                        ) throws IOException {

                            for (TextPosition position :
                                 positions) {

                                String value =
                                    position.getUnicode();

                                if (
                                    value != null &&
                                    !value.trim().isEmpty()
                                ) {

                                    System.out.println(
                                        "Text: " +
                                        value +
                                        " | x=" +
                                        position.getXDirAdj() +
                                        " | y=" +
                                        position.getYDirAdj() +
                                        " | width=" +
                                        position.getWidthDirAdj() +
                                        " | height=" +
                                        position.getHeightDir()
                                    );
                                }
                            }
                        }
                    };

                stripper.setStartPage(pageNumber);
                stripper.setEndPage(pageNumber);

                stripper.getText(document);

                // ---------------------------------------------
                // Form widgets
                // ---------------------------------------------

                System.out.println(
                    "--- FORM WIDGETS ---"
                );

                List<PDAnnotation> annotations =
                    page.getAnnotations();

                for (PDAnnotation annotation :
                     annotations) {

                    if (
                        annotation instanceof
                        PDAnnotationWidget
                    ) {

                        PDAnnotationWidget widget =
                            (PDAnnotationWidget)
                            annotation;

                        PDRectangle rect =
                            widget.getRectangle();

                        if (rect == null) {
                            continue;
                        }

                        System.out.println(
                            "Widget: " +
                            "x=" +
                            rect.getLowerLeftX() +
                            " | y=" +
                            rect.getLowerLeftY() +
                            " | width=" +
                            rect.getWidth() +
                            " | height=" +
                            rect.getHeight()
                        );
                    }
                }
            }

            System.out.println();
            System.out.println(
                "================================="
            );
            System.out.println(
                "ANALYSIS COMPLETE"
            );
            System.out.println(
                "================================="
            );
        }
    }
}