export function normalize(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/unique student identifier|usi number/g, "")
        .replace(/postcode/g, "zip")
        .replace(/title/g, "name")
        .replace(/[^a-z0-9]/g, "");
}

export function humanizePdfFieldName(name) {
    const technicalName = String(name || "");
    const indexed = technicalName.match(/^(.*?)Row(\d+)(?:_(\d+))?$/i);
    if (indexed) {
        return `${indexed[1].trim()} — Row ${indexed[2]}${indexed[3] ? ` — Field ${indexed[3]}` : ""}`;
    }
    if (/^\w{6}$/.test(technicalName)) return "Unlabelled PDF field";
    return technicalName.replace(/\d+_es_:signer:(signature|date)$/i, "").trim() || "Unlabelled PDF field";
}

export function indexedFamily(field) {
    const match = String(field?.name || "").match(/^(.*?)Row(\d+)(?:_(\d+))?$/i);
    if (!match) return null;
    return {
        key: `${match[1].trim()}::${match[3] || ""}`,
        label: match[1].trim(),
        pattern: `${match[1].trim()}Row{index}${match[3] ? `_${match[3]}` : ""}`,
        index: Number(match[2]),
        suffix: match[3] || "",
    };
}

export function mappingKey(fieldId, inputId = "") {
    return `${String(fieldId)}${inputId ? `:${String(inputId)}` : ""}`;
}

export function normalizeSavedMappings(saved) {
    const values = Array.isArray(saved?.mappings)
        ? saved.mappings.map((item) => ["", item])
        : Object.entries(saved?.mappings || {});
    return Object.fromEntries(values.map(([legacyKey, item]) => {
        const legacyParts = String(legacyKey).split(":");
        const sourceFieldId = String(item.sourceFieldId || item.source?.fieldId || item.gravityFieldId || legacyParts[0] || "");
        const sourceInputId = String(item.sourceInputId || item.source?.inputId || legacyParts[1] || "");
        const targetField = item.targetField || item.target?.fieldName || item.pdfField || "";
            const key = item.type === "one_to_many"
                ? `one-to-many:${item.id || `${sourceFieldId}:${targetField}`}`
                : item.type === "repeat"
                ? `repeat:${sourceFieldId}`
                : item.type === "compose"
                    ? `compose:${targetField || sourceFieldId}`
                    : item.type === "system"
                        ? `system:${targetField || sourceFieldId}`
                        : mappingKey(sourceFieldId, sourceInputId);
        const children = item.children || item.targets || item.target?.children || [];
        const targets = item.targets || (item.type === "one_to_many" ? children : undefined);
        return [key, {
            ...item,
            type: item.type || "direct",
            sourceFieldId,
            sourceInputId,
            source: item.source || (sourceFieldId ? { kind: "gravity_field", fieldId: sourceFieldId, ...(sourceInputId ? { inputId: sourceInputId } : {}) } : undefined),
            target: item.target || (targetField ? { kind: "pdf_field", fieldName: targetField } : undefined),
            pdfField: targetField,
            targetField,
            children,
            targets,
            pdfFieldData: item.pdfFieldData || (item.pdfFieldType ? { type: item.pdfFieldType } : undefined),
            id: item.id || (item.type === "one_to_many" ? key : undefined),
        }];
    }));
}

export function findMatch(label, fields, used = new Set()) {
    const wanted = normalize(label);
    if (!wanted) return null;
    return fields.find((field) => !used.has(field.name) && normalize(field.name) === wanted)
        || fields.find((field) => {
            const candidate = normalize(field.name);
            return !used.has(field.name) && wanted.length > 3 && (candidate.includes(wanted) || wanted.includes(candidate));
        })
        || null;
}

export function normalizeWpFormsUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";
    let trimmed = rawUrl.trim();
    if (!trimmed) return "";
    // remove trailing slashes
    trimmed = trimmed.replace(/\/+$/, "");
    if (!trimmed.includes("/wp-json/")) {
        trimmed = `${trimmed}/wp-json/pdf-generator/v1/forms`;
    } else if (trimmed.endsWith("/wp-json")) {
        trimmed = `${trimmed}/pdf-generator/v1/forms`;
    } else if (trimmed.endsWith("/wp-json/pdf-generator/v1")) {
        trimmed = `${trimmed}/forms`;
    }
    return trimmed;
}

export function findFamily(label, families, used = new Set()) {
    const wanted = normalize(label);
    return families.find((family) => !used.has(family.key) && normalize(family.label) === wanted)
        || families.find((family) => {
            const candidate = normalize(family.label);
            return !used.has(family.key) && wanted.length > 3 && (candidate.includes(wanted) || wanted.includes(candidate));
        })
        || null;
}