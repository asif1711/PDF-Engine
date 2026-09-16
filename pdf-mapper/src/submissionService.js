/**
 * Service to fetch submissions from WordPress Gravity Forms or provide
 * high-fidelity test entries for PDF generation testing.
 */
import { normalizeWpFormsUrl } from "./mappingUtils";

export const SAMPLE_SUBMISSIONS = {
    "1": [
        {
            id: "4",
            form_id: "1",
            date_created: "2026-09-15 11:55:29",
            source_type: "sample",
            submitter_name: "Amelia Hartley",
            "1.2": "Ms",
            "1.3": "Amelia",
            "1.6": "Hartley",
            "3": "1998-04-22",
            "19.1": "14 Harbour Street",
            "19.3": "Sydney",
            "19.4": "NSW",
            "19.5": "2000",
            "19.6": "Australia",
            "26": "STU-4482",
            "4": "amelia.hartley@example.com",
            "5": "0412345678",
            "34": "Faculty of Business and Technology",
            "21": "2",
            "8": [
                {
                    "Unit Code": "ICTICT532",
                    "Unit Name": "Apply IP ethics and privacy",
                },
                {
                    "Unit Code": "ICTDBS507",
                    "Unit Name": "Integrate databases",
                },
            ],
            "13.1": "A certified copy of transcripts",
            "16.1": "I declare that the information and supporting documentation submitted is true and correct to the best of my knowledge",
            "28.2": "$ 102.98",
            "22": "102.98",
        },
        {
            id: "142",
            form_id: "1",
            date_created: "2026-09-15 11:24:00",
            source_type: "sample",
            submitter_name: "Jane Doe",
            "1.2": "Ms",
            "1.3": "Jane",
            "1.6": "Doe",
            "3": "1998-04-15",
            "19.1": "42 Wallaby Way",
            "19.2": "Suite 3",
            "19.3": "Sydney",
            "19.4": "NSW",
            "19.5": "2000",
            "19.6": "Australia",
            "26": "USI-89218491",
            "4": "jane.doe@example.edu.au",
            "5": "+61 412 345 678",
            "34": "Faculty of Business and Technology",
            "21": "2",
            "8": [
                {
                    "Unit Code": "BSBCMM401",
                    "Unit Name": "Make a presentation",
                },
                {
                    "Unit Code": "BSBWHS401",
                    "Unit Name": "Implement and monitor WHS policies",
                },
            ],
        },
        {
            id: "143",
            form_id: "1",
            date_created: "2026-09-14 09:15:00",
            source_type: "sample",
            submitter_name: "Michael Chang",
            "1": "Michael",
            "2": "Chang",
            "3": "1995-11-28",
            "4.1": "88 Queen Street",
            "4.2": "Level 12",
            "4.3": "Melbourne",
            "4.4": "VIC",
            "4.5": "3000",
            "5": "m.chang@student.edu.au",
            "6": "+61 498 765 432",
            "7": "USI-77192044",
            "8": "3",
            "9": [
                {
                    "Unit Code": "ICTPRG501",
                    "Unit Title": "Apply advanced programming skills in another language",
                    "Evidence Provided": "Bachelor of IT Degree Parchment",
                    "Unit Code Row 1_2": "NPA-IT501",
                    "Unit Title Row 1_2": "Advanced Programming Foundations",
                },
                {
                    "Unit Code": "ICTSAD501",
                    "Unit Title": "Model data objects",
                    "Evidence Provided": "RTO Statement of Attainment",
                    "Unit Code Row 1_2": "NPA-IT502",
                    "Unit Title Row 1_2": "Data Modeling Principles",
                },
                {
                    "Unit Code": "ICTNWK502",
                    "Unit Title": "Implement secure encryption technologies",
                    "Evidence Provided": "Cybersecurity Certificate IV Transcript",
                    "Unit Code Row 1_2": "NPA-SEC501",
                    "Unit Title Row 1_2": "Applied Cryptography Systems",
                },
            ],
            "10": "Michael Chang",
            "11": "2026-09-14",
        },
        {
            id: "144",
            form_id: "1",
            date_created: "2026-09-15 16:45:00",
            source_type: "sample",
            submitter_name: "Sarah Al-Mansoor",
            "1": "Sarah",
            "2": "Al-Mansoor",
            "3": "2001-08-04",
            "4.1": "15 Terrace Road",
            "4.2": "",
            "4.3": "Perth",
            "4.4": "WA",
            "4.5": "6000",
            "5": "sarah.am@innovate.org.au",
            "6": "+61 433 112 299",
            "7": "USI-99304182",
            "8": "1",
            "9": [
                {
                    "Unit Code": "BSBMGT401",
                    "Unit Title": "Show leadership in the workplace",
                    "Evidence Provided": "Leadership Excellence Certificate",
                    "Unit Code Row 1_2": "NPA-MGT401",
                    "Unit Title Row 1_2": "Foundations of Team Leadership",
                },
            ],
            "10": "Sarah Al-Mansoor",
            "11": "2026-09-15",
        },
    ],
};

/**
 * Fetch entries from the WordPress site connector if reachable,
 * falling back gracefully to realistic sample submissions.
 */
export async function fetchFormSubmissions(formId, formsUrl, apiKey, options = {}) {
    if (!formId) return [];

    if (!formsUrl) {
        return {
            source: "no_url",
            message: "No WordPress URL configured.",
            entries: [],
        };
    }

    // Compute entries endpoint: replace `/forms` with `/forms/{formId}/entries`
    const normalizedFormsUrl = normalizeWpFormsUrl(formsUrl);
    let entriesUrl = normalizedFormsUrl.replace(/\/forms\/?$/, `/forms/${formId}/entries`);
    if (entriesUrl.includes("ngrok")) {
        const sep = entriesUrl.includes("?") ? "&" : "?";
        if (!entriesUrl.includes("ngrok-skip-browser-warning")) {
            entriesUrl = `${entriesUrl}${sep}ngrok-skip-browser-warning=true`;
        }
    }

    const headers = {
        Accept: "application/json",
    };

    if (apiKey) {
        headers["X-PDF-API-Key"] = apiKey;
    }

    const basicUser = options.basicAuthUser || "";
    const basicPass = options.basicAuthPass || "";
    if (basicUser || basicPass) {
        try {
            headers.Authorization = `Basic ${btoa(`${basicUser}:${basicPass}`)}`;
        } catch {
            // Ignore encoding errors
        }
    }

    let response;
    // Attempt via server-side /api/wp-proxy first to bypass ngrok browser warning & CORS
    try {
        let proxyQuery = `/api/wp-proxy?url=${encodeURIComponent(entriesUrl)}`;
        if (apiKey) proxyQuery += `&apiKey=${encodeURIComponent(apiKey)}`;
        if (basicUser) proxyQuery += `&basicUser=${encodeURIComponent(basicUser)}`;
        if (basicPass) proxyQuery += `&basicPass=${encodeURIComponent(basicPass)}`;

        const proxyRes = await fetch(proxyQuery);
        if (proxyRes.ok) {
            response = proxyRes;
        }
    } catch {
        // Fall back to direct fetch
    }

    try {
        if (!response) {
            response = await fetch(entriesUrl, {
                headers,
            });
        }

        if (response.status === 401) {
            const authHeader = response.headers.get("www-authenticate") || "";
            if (authHeader.toLowerCase().includes("basic") && !basicUser) {
                return {
                    source: "auth_required",
                    message: "LocalWP Live Link requires HTTP Basic Auth. Enter the Username & Password shown in LocalWP under Tools > Live Link.",
                    entries: [],
                };
            }
            return {
                source: "auth_failed",
                message: "Authentication failed (401). Check your X-PDF-API-Key in wp-config.php or LocalWP credentials.",
                entries: [],
            };
        }

        if (response.status === 403) {
            return {
                source: "forbidden",
                message: "Access forbidden (403). Check your X-PDF-API-Key in wp-config.php.",
                entries: [],
            };
        }

        if (response.status === 404) {
            return {
                source: "not_found",
                message: `Endpoint 404 not found at ${entriesUrl}. Ensure gravity-forms-reader.php is activated on ${formsUrl}.`,
                entries: [],
            };
        }

        if (response.ok) {
            const data = await response.json();
            if (data && Array.isArray(data.entries) && data.entries.length > 0) {
                // Filter out trashed and spam entries; only keep active live submissions
                const activeEntries = data.entries.filter((entry) => {
                    if (entry.status && entry.status.toLowerCase() === "trash") return false;
                    if (entry.status && entry.status.toLowerCase() === "spam") return false;
                    return true;
                });

                return {
                    source: "wordpress_live",
                    message: `Retrieved ${activeEntries.length} active submission${activeEntries.length === 1 ? "" : "s"} from WordPress.`,
                    entries: activeEntries.map((entry) => {
                        const firstName = entry["1.3"] || entry["1"] || entry.first_name || "";
                        const lastName = entry["1.6"] || entry["2"] || entry.last_name || "";
                        const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
                        return {
                            ...entry,
                            source_type: "live_wp",
                            submitter_name: fullName || entry.submitter_name || `Entry #${entry.id || "live"}`,
                        };
                    }),
                };
            }
            return {
                source: "wordpress_live",
                message: "Connected to WordPress, but no active submissions found for Form #" + formId,
                entries: [],
            };
        }
    } catch (err) {
        return {
            source: "network_error",
            message: `Cannot connect to ${formsUrl} (${err.message}). Check your Live Link or enter your credentials.`,
            entries: [],
        };
    }

    return {
        source: "offline",
        message: "WordPress site is currently offline or unreachable.",
        entries: [],
    };
}
