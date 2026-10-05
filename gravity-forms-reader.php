<?php
/**
 * Plugin Name: PDF Generator - Gravity Forms Reader
 * Description: Read-only Gravity Forms schema reader and automated PDF submission/notification dispatcher for the PDF Generator system.
 * Version: 1.3.0
 * Author: Nurul Islam
 */

defined('ABSPATH') || exit;


/**
 * ============================================================
 * CONFIGURATION
 * ============================================================
 *
 * For production, define the API key and Webhook URL in wp-config.php:
 *
 * define('PDF_GENERATOR_API_KEY', 'your-long-random-key');
 * define('PDF_GENERATOR_WEBHOOK_URL', 'http://127.0.0.1:4000/api/generate-pdf');
 */


/**
 * Get the configured API key.
 */
function pfgf_get_api_key() {

    if (defined('PDF_GENERATOR_API_KEY') && PDF_GENERATOR_API_KEY) {
        return (string) PDF_GENERATOR_API_KEY;
    }

    return (string) get_option('pfgf_api_key', '');
}


/**
 * Get the configured Webhook URL for PDF generation.
 */
function pfgf_get_webhook_url() {

    if (defined('PDF_GENERATOR_WEBHOOK_URL') && PDF_GENERATOR_WEBHOOK_URL) {
        return (string) PDF_GENERATOR_WEBHOOK_URL;
    }

    return (string) get_option('pfgf_webhook_url', '');
}


/**
 * ============================================================
 * ADMIN PAGE & WEBHOOK DIAGNOSTICS
 * ============================================================
 */

add_action('admin_menu', 'pfgf_register_admin_page');

function pfgf_register_admin_page() {

    add_management_page(
        'Gravity Forms Reader',
        'Gravity Forms Reader',
        'manage_options',
        'gravity-forms-reader',
        'pfgf_render_admin_page'
    );
}


/**
 * Render the admin page.
 */
function pfgf_render_admin_page() {

    if (!current_user_can('manage_options')) {
        wp_die(
            esc_html__('You are not allowed to access this page.', 'pdf-generator')
        );
    }

    // Handle settings update
    $message = '';
    $test_result = null;

    if (isset($_POST['pfgf_save_settings']) && check_admin_referer('pfgf_admin_action')) {
        if (isset($_POST['pfgf_webhook_url'])) {
            update_option('pfgf_webhook_url', esc_url_raw(trim($_POST['pfgf_webhook_url'])));
            $message = 'Settings saved successfully.';
        }
    }

    // Handle Manual PDF Generation for an entry
    if (isset($_POST['pfgf_generate_single_entry']) && check_admin_referer('pfgf_admin_action')) {
        $target_entry_id = absint($_POST['target_entry_id']);
        if ($target_entry_id > 0) {
            $entry = class_exists('GFAPI') ? GFAPI::get_entry($target_entry_id) : null;
            if (!$entry || is_wp_error($entry)) {
                $sub_file = WP_CONTENT_DIR . "/pdf-generator/submissions/entry-{$target_entry_id}.json";
                if (file_exists($sub_file)) {
                    $sub_data = json_decode(file_get_contents($sub_file), true);
                    if (!empty($sub_data['entry'])) {
                        $entry = $sub_data['entry'];
                    }
                }
            }
            if ($entry && !is_wp_error($entry)) {
                $form_id = isset($entry['form_id']) ? $entry['form_id'] : 1;
                $generated_dir = WP_CONTENT_DIR . '/pdf-generator/generated/';
                if (!file_exists($generated_dir)) wp_mkdir_p($generated_dir);
                $pdf_dest = $generated_dir . "form-{$form_id}-entry-{$target_entry_id}.pdf";

                pfgf_dispatch_pdf_generation_webhook($target_entry_id, $form_id, $pdf_dest, $entry);

                if (file_exists($pdf_dest) && filesize($pdf_dest) > 0) {
                    $message = "Success! PDF successfully generated for Entry #{$target_entry_id} (" . round(filesize($pdf_dest) / 1024, 1) . " KB).";
                } else {
                    $message = "Dispatched generation for Entry #{$target_entry_id}, but PDF was not generated. Check 'Last Webhook Dispatch' status below for error details.";
                }
            } else {
                $message = "Error: Entry #{$target_entry_id} not found.";
            }
        }
    }

    // Handle Test Webhook
    if (isset($_POST['pfgf_test_webhook']) && check_admin_referer('pfgf_admin_action')) {
        $target_url = pfgf_get_webhook_url();
        if (empty($target_url)) {
            $test_result = array(
                'status'  => 'error',
                'message' => 'No Webhook URL configured. Please configure a URL below or in wp-config.php.',
            );
        } else {
            $test_payload = array(
                'form_id'  => '1',
                'entry_id' => 'test-ping',
                'is_test'  => true,
                'entry'    => array(
                    '1' => 'Test First Name',
                    '2' => 'Test Last Name',
                    '3' => current_time('Y-m-d'),
                ),
            );

            $response = wp_remote_post($target_url, array(
                'timeout'   => 15,
                'sslverify' => false,
                'headers'   => array(
                    'Content-Type' => 'application/json',
                    'Accept'       => 'application/json',
                ),
                'body'      => wp_json_encode($test_payload),
            ));

            if (is_wp_error($response)) {
                $test_result = array(
                    'status'  => 'error',
                    'message' => 'Connection failed: ' . $response->get_error_message(),
                );
            } else {
                $code = wp_remote_retrieve_response_code($response);
                $body = wp_remote_retrieve_body($response);
                $headers = wp_remote_retrieve_headers($response);
                $location = isset($headers['location']) ? $headers['location'] : '';

                if ($code === 200) {
                    $test_result = array(
                        'status'  => 'success',
                        'message' => 'HTTP 200 OK! Webhook endpoint reached and returned successful response.',
                        'body'    => substr($body, 0, 400),
                    );
                } elseif ($code === 400 && strpos($body, 'Bad Request') !== false && strpos($target_url, 'ais-dev-') !== false) {
                    $test_result = array(
                        'status'  => 'error',
                        'message' => 'HTTP 400 Bad Request: Google AI Studio dev URL detected. Google blocks external server-to-server webhook requests to development containers. For your local WordPress site, run "node local-pdf-server.js" in the project folder and use "http://127.0.0.1:4000/api/generate-pdf", or use the Live Browser Auto-Dispatcher.',
                    );
                } elseif ($code === 404) {
                    $test_result = array(
                        'status'  => 'error',
                        'message' => "HTTP 404 Not Found: {$body}. The host is reachable, but /api/generate-pdf was not handled. Make sure you run 'node local-pdf-server.js' or 'npm run dev' on that host/port.",
                    );
                } elseif ($code === 302 || $code === 301) {
                    $test_result = array(
                        'status'  => 'warning',
                        'message' => "HTTP {$code} Redirect to: " . esc_html($location) . ". If this is a Google dev URL (ais-dev-*.run.app), external server-to-server requests are blocked by Google authentication proxy.",
                    );
                } else {
                    $test_result = array(
                        'status'  => 'error',
                        'message' => "HTTP {$code} Error: " . substr(strip_tags($body), 0, 300),
                    );
                }
            }
        }
    }

    $result = pfgf_build_forms_data();

    $submissions_dir = WP_CONTENT_DIR . '/pdf-generator/submissions/';
    $generated_dir   = WP_CONTENT_DIR . '/pdf-generator/generated/';

    $sub_count = file_exists($submissions_dir) ? count(glob($submissions_dir . '*.json')) : 0;
    $gen_count = file_exists($generated_dir) ? count(glob($generated_dir . '*.pdf')) : 0;
    $last_log  = get_option('pfgf_last_webhook_log', array());

    ?>

    <div class="wrap">

        <h1>Gravity Forms Reader &amp; PDF Automation</h1>

        <p>
            Gravity Forms schema reader and automated PDF submission/notification dispatcher for the PDF Generator system.
        </p>

        <?php if ($message): ?>
            <div class="notice notice-success is-dismissible"><p><?php echo esc_html($message); ?></p></div>
        <?php endif; ?>

        <?php if ($test_result): ?>
            <div class="notice notice-<?php echo esc_attr($test_result['status']); ?> is-dismissible">
                <p><strong>Webhook Test:</strong> <?php echo esc_html($test_result['message']); ?></p>
                <?php if (!empty($test_result['body'])): ?>
                    <pre style="background:#f4f4f4; padding:8px;"><?php echo esc_html($test_result['body']); ?></pre>
                <?php endif; ?>
            </div>
        <?php endif; ?>

        <table class="widefat fixed" style="margin-bottom: 24px; max-width: 800px;">
            <thead>
                <tr>
                    <th colspan="2"><strong>System Status &amp; Configuration</strong></th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>Forms Detected</strong></td>
                    <td><?php echo is_wp_error($result) ? '<span style="color:red;">Error</span>' : esc_html(count($result['forms'])) . ' forms found'; ?></td>
                </tr>
                <tr>
                    <td><strong>API Authentication</strong></td>
                    <td><?php echo pfgf_get_api_key() ? '<span style="color:green;">✓ Configured</span>' : '<span style="color:orange;">⚠ Not configured (optional for admin testing)</span>'; ?></td>
                </tr>
                <tr>
                    <td><strong>PDF Webhook URL</strong></td>
                    <td>
                        <?php 
                        $wh = pfgf_get_webhook_url();
                        if ($wh) {
                            echo '<code>' . esc_html($wh) . '</code>';
                            if (defined('PDF_GENERATOR_WEBHOOK_URL')) {
                                echo ' <small style="color:#777;">(defined in wp-config.php)</small>';
                            }
                        } else {
                            echo '<span style="color:#e67e22;">⚠ Not configured</span>';
                        }
                        ?>
                    </td>
                </tr>
                <tr>
                    <td><strong>Saved Submissions JSON</strong></td>
                    <td><?php echo esc_html($sub_count); ?> file(s) in <code>wp-content/pdf-generator/submissions/</code></td>
                </tr>
                <tr>
                    <td><strong>Generated PDFs on Disk</strong></td>
                    <td><?php echo esc_html($gen_count); ?> file(s) in <code>wp-content/pdf-generator/generated/</code></td>
                </tr>
                <?php if (!empty($last_log)): ?>
                <tr>
                    <td><strong>Last Webhook Dispatch</strong></td>
                    <td>
                        <strong>Time:</strong> <?php echo esc_html($last_log['timestamp'] ?? ''); ?><br>
                        <strong>Entry:</strong> #<?php echo esc_html($last_log['entry_id'] ?? ''); ?> (Form #<?php echo esc_html($last_log['form_id'] ?? ''); ?>)<br>
                        <strong>HTTP Code:</strong> 
                        <?php 
                        $sc = $last_log['status_code'] ?? 0;
                        if ($sc === 200) {
                            echo '<span style="color:green; font-weight:bold;">200 OK (PDF Generated & Attached!)</span>';
                        } elseif ($sc === 302 || $sc === 301) {
                            echo '<span style="color:red; font-weight:bold;">' . esc_html($sc) . ' Redirect</span> - Google Cloud Run dev auth blocked request. Target must be publicly accessible or local.';
                        } else {
                            echo '<span style="color:red; font-weight:bold;">' . esc_html($sc) . '</span> ' . esc_html($last_log['error_msg'] ?? '');
                        }
                        ?><br>
                        <?php if (!empty($last_log['body_preview'])): ?>
                            <details style="margin-top:4px;"><summary>View Response Preview</summary>
                                <pre style="font-size:11px; white-space:pre-wrap;"><?php echo esc_html($last_log['body_preview']); ?></pre>
                            </details>
                        <?php endif; ?>
                    </td>
                </tr>
                <?php endif; ?>
            </tbody>
        </table>

        <!-- Webhook Configuration & Testing -->
        <div style="background:#fff; border:1px solid #ccd0d4; padding:16px 20px; max-width:800px; margin-bottom:24px; border-radius:4px;">
            <h3 style="margin-top:0;">PDF Generation Webhook Endpoint</h3>
            <p style="color:#555;">
                When a user submits a Gravity Form, WordPress calls this webhook to synchronously generate the PDF and attach it to the email notification.
            </p>

            <?php 
            $current_wh = pfgf_get_webhook_url();
            if (strpos($current_wh, 'ais-dev-') !== false): 
            ?>
                <div style="background:#fff3cd; border-left:4px solid #ffba00; padding:12px 16px; margin-bottom:16px;">
                    <strong style="color:#856404; font-size:14px;">⚠️ Google AI Studio Dev URL Detected:</strong>
                    <p style="margin:6px 0; color:#856404; line-height:1.5;">
                        Google AI Studio development containers (<code>ais-dev-*.run.app</code>) block external server-to-server webhook requests with <strong>HTTP 400 (Bad Request)</strong> due to Google authentication proxies.
                    </p>
                    <div style="background:#fff; border:1px solid #ffeeba; padding:10px 14px; border-radius:3px; margin-top:8px;">
                        <strong>Quick Fix for LocalWP / Local WordPress:</strong>
                        <ol style="margin:4px 0 0 18px; padding:0; color:#333;">
                            <li>In your project terminal, run: <code style="background:#f4f4f4; padding:2px 6px;">node local-pdf-server.js</code></li>
                            <li>Change the Webhook URL below to: <code style="background:#f4f4f4; padding:2px 6px;">http://127.0.0.1:4000/api/generate-pdf</code> and click <em>Save Webhook URL</em>.</li>
                            <li>Or open the React App and click <strong>▶ Enable Live Browser Auto-Dispatcher</strong> to generate submissions in real time right in your browser!</li>
                        </ol>
                    </div>
                </div>
            <?php endif; ?>

            <form method="post" action="">
                <?php wp_nonce_field('pfgf_admin_action'); ?>
                <table class="form-table" style="margin-top:0;">
                    <tr>
                        <th scope="row"><label for="pfgf_webhook_url">Webhook URL</label></th>
                        <td>
                            <input 
                                type="url" 
                                id="pfgf_webhook_url" 
                                name="pfgf_webhook_url" 
                                value="<?php echo esc_attr(pfgf_get_webhook_url()); ?>" 
                                class="regular-text" 
                                style="width:100%; max-width:550px;"
                                placeholder="http://127.0.0.1:4000/api/generate-pdf"
                                <?php echo defined('PDF_GENERATOR_WEBHOOK_URL') ? 'readonly' : ''; ?>
                            >
                            <?php if (defined('PDF_GENERATOR_WEBHOOK_URL')): ?>
                                <p class="description">Defined in <code>wp-config.php</code> via <code>PDF_GENERATOR_WEBHOOK_URL</code> constant.</p>
                            <?php else: ?>
                                <p class="description">For LocalWP, use <code>http://127.0.0.1:4000/api/generate-pdf</code> with <code>node local-pdf-server.js</code>.</p>
                            <?php endif; ?>
                        </td>
                    </tr>
                </table>

                <p class="submit" style="display:flex; gap:10px; margin-bottom:0; padding-bottom:0;">
                    <?php if (!defined('PDF_GENERATOR_WEBHOOK_URL')): ?>
                        <input type="submit" name="pfgf_save_settings" class="button button-primary" value="Save Webhook URL">
                    <?php endif; ?>
                    <input type="submit" name="pfgf_test_webhook" class="button button-secondary" value="⚡ Test Webhook Connection">
                </p>
            </form>
        </div>

        <!-- Recent Submissions & On-Demand Generation -->
        <div style="background:#fff; border:1px solid #ccd0d4; padding:16px 20px; max-width:800px; margin-bottom:24px; border-radius:4px;">
            <h3 style="margin-top:0;">Gravity Forms Submissions &amp; PDF Generation</h3>
            <p style="color:#555;">
                View submissions recorded by the plugin and generate or re-generate filled PDFs on demand.
            </p>

            <?php
            $submission_files = file_exists($submissions_dir) ? glob($submissions_dir . 'entry-*.json') : array();
            // Sort newest first
            usort($submission_files, function($a, $b) {
                return filemtime($b) - filemtime($a);
            });
            $recent_subs = array_slice($submission_files, 0, 10);
            ?>

            <?php if (empty($recent_subs)): ?>
                <p style="color:#777;"><em>No submissions recorded yet in <code>wp-content/pdf-generator/submissions/</code>. Submit a Gravity Form to see it here.</em></p>
            <?php else: ?>
                <table class="widefat striped">
                    <thead>
                        <tr>
                            <th>Entry ID</th>
                            <th>Form</th>
                            <th>Submitted</th>
                            <th>PDF Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($recent_subs as $sf): 
                            $raw_sub = json_decode(file_get_contents($sf), true);
                            $eid = $raw_sub['entry_id'] ?? basename($sf, '.json');
                            $eid = str_replace('entry-', '', $eid);
                            $fid = $raw_sub['form_id'] ?? 1;
                            $ftitle = $raw_sub['form_title'] ?? "Form #{$fid}";
                            $sub_time = $raw_sub['submitted_at'] ?? date('Y-m-d H:i:s', filemtime($sf));
                            $pdf_file = $generated_dir . "form-{$fid}-entry-{$eid}.pdf";
                            $has_pdf = file_exists($pdf_file) && filesize($pdf_file) > 0;
                        ?>
                        <tr>
                            <td><strong>#<?php echo esc_html($eid); ?></strong></td>
                            <td><?php echo esc_html($ftitle); ?> (Form #<?php echo esc_html($fid); ?>)</td>
                            <td><?php echo esc_html($sub_time); ?></td>
                            <td>
                                <?php if ($has_pdf): ?>
                                    <span style="color:green; font-weight:bold;">✓ Generated</span> (<?php echo round(filesize($pdf_file) / 1024, 1); ?> KB)
                                <?php else: ?>
                                    <span style="color:#e67e22; font-weight:bold;">⚠ Not Generated</span>
                                <?php endif; ?>
                            </td>
                            <td>
                                <div style="display:flex; gap:6px; align-items:center;">
                                    <?php if ($has_pdf): ?>
                                        <a href="<?php echo esc_url(rest_url("pdf-generator/v1/entries/{$eid}/pdf")); ?>" target="_blank" class="button button-small">📥 View PDF</a>
                                    <?php endif; ?>
                                    <form method="post" action="" style="display:inline-block; margin:0;">
                                        <?php wp_nonce_field('pfgf_admin_action'); ?>
                                        <input type="hidden" name="target_entry_id" value="<?php echo esc_attr($eid); ?>">
                                        <button type="submit" name="pfgf_generate_single_entry" class="button button-small <?php echo $has_pdf ? '' : 'button-primary'; ?>">
                                            ⚡ <?php echo $has_pdf ? 'Regenerate' : 'Generate Now'; ?>
                                        </button>
                                    </form>
                                </div>
                            </td>
                        </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            <?php endif; ?>
        </div>

        <h2>Detected Forms Schema (JSON)</h2>
        <textarea
            readonly
            style="
                width:100%;
                max-width:800px;
                min-height:300px;
                font-family:monospace;
            "
        ><?php
            echo esc_textarea(
                wp_json_encode(
                    $result,
                    JSON_PRETTY_PRINT |
                    JSON_UNESCAPED_SLASHES |
                    JSON_UNESCAPED_UNICODE
                )
            );
        ?></textarea>

    </div>

    <?php
}


/**
 * ============================================================
 * REST API
 * ============================================================
 */

add_action('rest_api_init', 'pfgf_register_rest_routes');

function pfgf_register_rest_routes() {

    // 1. Get all forms and fields schema
    register_rest_route(
        'pdf-generator/v1',
        '/forms',
        array(
            'methods'             => WP_REST_Server::READABLE,
            'callback'            => 'pfgf_rest_get_forms',
            'permission_callback' => 'pfgf_rest_permission_check',
        )
    );

    // 2. Get active entries for a form
    register_rest_route(
        'pdf-generator/v1',
        '/forms/(?P<id>\d+)/entries',
        array(
            'methods'             => WP_REST_Server::READABLE,
            'callback'            => 'pfgf_rest_get_form_entries',
            'permission_callback' => 'pfgf_rest_permission_check',
            'args'                => array(
                'id' => array(
                    'validate_callback' => function($param) {
                        return is_numeric($param);
                    }
                ),
            ),
        )
    );

    // 3. Download uploaded form attachment through WordPress
    register_rest_route(
        'pdf-generator/v1',
        '/files/download',
        array(
            'methods'             => WP_REST_Server::READABLE,
            'callback'            => 'pfgf_rest_download_file',
            'permission_callback' => 'pfgf_rest_permission_check',
            'args'                => array(
                'file_url' => array(
                    'required'          => true,
                    'sanitize_callback' => 'esc_url_raw',
                ),
            ),
        )
    );

    // 4. Download generated PDF for an entry
    register_rest_route(
        'pdf-generator/v1',
        '/entries/(?P<id>\d+)/pdf',
        array(
            'methods'             => WP_REST_Server::READABLE,
            'callback'            => 'pfgf_rest_download_entry_pdf',
            'permission_callback' => 'pfgf_rest_permission_check',
            'args'                => array(
                'id' => array(
                    'validate_callback' => function($param) {
                        return is_numeric($param);
                    }
                ),
            ),
        )
    );

    // 5. Upload generated PDF directly to WordPress & optionally trigger email
    register_rest_route(
        'pdf-generator/v1',
        '/entries/(?P<id>\d+)/pdf',
        array(
            'methods'             => WP_REST_Server::CREATABLE,
            'callback'            => 'pfgf_rest_upload_entry_pdf',
            'permission_callback' => 'pfgf_rest_permission_check',
            'args'                => array(
                'id' => array(
                    'validate_callback' => function($param) {
                        return is_numeric($param);
                    }
                ),
            ),
        )
    );

    add_filter('rest_pre_dispatch', 'pfgf_handle_cors_preflight', 10, 3);
    add_filter('rest_pre_serve_request', 'pfgf_send_cors_headers', 9, 4);
}


/**
 * Handle browser preflight request.
 */
function pfgf_handle_cors_preflight($result, WP_REST_Server $server, WP_REST_Request $request) {

    $route = (string) $request->get_route();
    if (
        $request->get_method() === 'OPTIONS' &&
        (strpos($route, '/pdf-generator/v1/') === 0)
    ) {
        return new WP_REST_Response(null, 200);
    }

    return $result;
}


/**
 * Send CORS headers for PDF generator REST endpoints.
 */
function pfgf_send_cors_headers($served, $result, WP_REST_Request $request, WP_REST_Server $server) {

    $route = (string) $request->get_route();
    if (strpos($route, '/pdf-generator/v1/') !== 0) {
        return $served;
    }

    remove_action('rest_pre_serve_request', 'rest_send_cors_headers');

    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Accept, X-PDF-API-Key, Content-Type, Authorization, ngrok-skip-browser-warning');

    return $served;
}


/**
 * Authenticate REST requests.
 */
function pfgf_rest_permission_check(WP_REST_Request $request) {

    // Allow logged-in administrators
    if (is_user_logged_in() && current_user_can('manage_options')) {
        return true;
    }

    $configured_key = pfgf_get_api_key();

    if ($configured_key === '') {
        return new WP_Error(
            'pdf_generator_api_not_configured',
            'PDF Generator API authentication is not configured.',
            array('status' => 503)
        );
    }

    $provided_key = $request->get_header('X-PDF-API-Key');

    if (!is_string($provided_key) || $provided_key === '') {
        return new WP_Error(
            'pdf_generator_missing_api_key',
            'Authentication required.',
            array('status' => 401)
        );
    }

    if (!hash_equals($configured_key, $provided_key)) {
        return new WP_Error(
            'pdf_generator_invalid_api_key',
            'Authentication failed.',
            array('status' => 401)
        );
    }

    return true;
}


/**
 * REST callback for forms schema.
 */
function pfgf_rest_get_forms(WP_REST_Request $request) {

    $result = pfgf_build_forms_data();

    if (is_wp_error($result)) {
        return $result;
    }

    return rest_ensure_response($result);
}


/**
 * REST callback for form entries.
 */
function pfgf_rest_get_form_entries(WP_REST_Request $request) {

    if (!class_exists('GFAPI')) {
        return new WP_Error(
            'gravity_forms_unavailable',
            'Gravity Forms is not available.',
            array('status' => 503)
        );
    }

    $form_id = absint($request->get_param('id'));
    if (!$form_id) {
        return new WP_Error(
            'invalid_form_id',
            'A valid form ID is required.',
            array('status' => 400)
        );
    }

    $search_criteria = array(
        'status' => 'active',
    );
    $entries = GFAPI::get_entries($form_id, $search_criteria);
    if (is_wp_error($entries)) {
        return $entries;
    }

    // Auto-detect and index uploaded file attachments in each entry
    foreach ($entries as &$entry) {
        $files = array();
        foreach ($entry as $key => $val) {
            if (!is_string($val) || empty($val)) continue;
            // Check for JSON array of file URLs (multi-file upload)
            if (strpos($val, '[') === 0 && (strpos($val, 'http') !== false || strpos($val, 'uploads') !== false)) {
                $decoded = json_decode($val, true);
                if (is_array($decoded)) {
                    foreach ($decoded as $url) {
                        if (is_string($url) && filter_var($url, FILTER_VALIDATE_URL)) {
                            $files[] = array(
                                'field_id' => (string) $key,
                                'url'      => $url,
                                'filename' => basename(wp_parse_url($url, PHP_URL_PATH)),
                            );
                        }
                    }
                }
            } elseif (filter_var($val, FILTER_VALIDATE_URL) && (strpos($val, '/uploads/') !== false || strpos($val, '/gravity_forms/') !== false)) {
                $files[] = array(
                    'field_id' => (string) $key,
                    'url'      => $val,
                    'filename' => basename(wp_parse_url($val, PHP_URL_PATH)),
                );
            }
        }
        $entry['_uploaded_files'] = $files;
    }
    unset($entry);

    return rest_ensure_response(array(
        'formId'  => (string) $form_id,
        'count'   => count($entries),
        'entries' => $entries,
    ));
}


/**
 * REST callback for streaming an uploaded form file.
 */
function pfgf_rest_download_file(WP_REST_Request $request) {

    $file_url = $request->get_param('file_url');
    if (empty($file_url)) {
        return new WP_Error('missing_file_url', 'file_url parameter is required.', array('status' => 400));
    }

    $upload_dir = wp_upload_dir();
    $base_dir = !empty($upload_dir['basedir']) ? realpath($upload_dir['basedir']) : '';

    $parsed_url = wp_parse_url($file_url, PHP_URL_PATH);
    $parsed_base = !empty($upload_dir['baseurl']) ? wp_parse_url($upload_dir['baseurl'], PHP_URL_PATH) : '';

    $local_path = '';
    if ($parsed_base && strpos($parsed_url, $parsed_base) === 0) {
        $rel_path = substr($parsed_url, strlen($parsed_base));
        $candidate = $upload_dir['basedir'] . $rel_path;
        if (file_exists($candidate)) {
            $local_path = realpath($candidate);
        }
    } elseif (strpos($parsed_url, '/wp-content/uploads/') !== false) {
        $idx = strpos($parsed_url, '/wp-content/uploads/');
        $rel_path = substr($parsed_url, $idx + strlen('/wp-content/uploads/'));
        $candidate = $upload_dir['basedir'] . '/' . ltrim($rel_path, '/');
        if (file_exists($candidate)) {
            $local_path = realpath($candidate);
        }
    }

    if ($local_path && $base_dir && strpos($local_path, $base_dir) === 0 && file_exists($local_path)) {
        $file_info = wp_check_filetype($local_path);
        $mime_type = !empty($file_info['type']) ? $file_info['type'] : 'application/octet-stream';
        $filename = basename($local_path);

        header('Content-Type: ' . $mime_type);
        header('Content-Disposition: inline; filename="' . $filename . '"');
        header('Content-Length: ' . (string) filesize($local_path));
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Expose-Headers: Content-Disposition, Content-Length, Content-Type');
        readfile($local_path);
        exit;
    }

    // Fallback: fetch via WordPress HTTP API if remote
    $response = wp_remote_get($file_url, array('timeout' => 20, 'sslverify' => false));
    if (!is_wp_error($response) && wp_remote_retrieve_response_code($response) === 200) {
        $body = wp_remote_retrieve_body($response);
        $content_type = wp_remote_retrieve_header($response, 'content-type') ?: 'application/octet-stream';
        $filename = basename(wp_parse_url($file_url, PHP_URL_PATH) ?: 'attachment');

        header('Content-Type: ' . $content_type);
        header('Content-Disposition: inline; filename="' . $filename . '"');
        header('Content-Length: ' . (string) strlen($body));
        header('Access-Control-Allow-Origin: *');
        echo $body;
        exit;
    }

    return new WP_Error('file_not_found', 'Requested file could not be found or verified.', array('status' => 404));
}


/**
 * REST callback for downloading a generated entry PDF.
 */
function pfgf_rest_download_entry_pdf(WP_REST_Request $request) {

    $entry_id = absint($request->get_param('id'));
    if (!$entry_id) {
        return new WP_Error('invalid_entry_id', 'A valid entry ID is required.', array('status' => 400));
    }

    $generated_dir = WP_CONTENT_DIR . '/pdf-generator/generated/';
    $files = glob($generated_dir . "form-*-entry-{$entry_id}.pdf");

    if (empty($files) || !file_exists($files[0])) {
        return new WP_Error('pdf_not_found', "No generated PDF found for entry #{$entry_id}.", array('status' => 404));
    }

    $pdf_file = $files[0];
    $filename = basename($pdf_file);

    header('Content-Type: application/pdf');
    header('Content-Disposition: inline; filename="' . $filename . '"');
    header('Content-Length: ' . (string) filesize($pdf_file));
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Expose-Headers: Content-Disposition, Content-Length, Content-Type');
    readfile($pdf_file);
    exit;
}


/**
 * REST callback for uploading a generated entry PDF from frontend or worker.
 */
function pfgf_rest_upload_entry_pdf(WP_REST_Request $request) {

    if (!class_exists('GFAPI')) {
        return new WP_Error('gravity_forms_unavailable', 'Gravity Forms is not available.', array('status' => 503));
    }

    $entry_id = absint($request->get_param('id'));
    if (!$entry_id) {
        return new WP_Error('invalid_entry_id', 'A valid entry ID is required.', array('status' => 400));
    }

    $entry = GFAPI::get_entry($entry_id);
    if (is_wp_error($entry) || empty($entry)) {
        return new WP_Error('entry_not_found', "Entry #{$entry_id} not found.", array('status' => 404));
    }

    $form_id = isset($entry['form_id']) ? $entry['form_id'] : 1;
    $raw_body = $request->get_body();
    $pdf_binary = '';

    if (substr($raw_body, 0, 4) === '%PDF') {
        $pdf_binary = $raw_body;
    } else {
        $json = json_decode($raw_body, true);
        if (!empty($json['pdfBytesBase64'])) {
            $pdf_binary = base64_decode($json['pdfBytesBase64']);
        }
    }

    if (empty($pdf_binary) || substr($pdf_binary, 0, 4) !== '%PDF') {
        return new WP_Error('invalid_pdf_data', 'Expected valid PDF binary data.', array('status' => 400));
    }

    $generated_dir = WP_CONTENT_DIR . '/pdf-generator/generated/';
    if (!file_exists($generated_dir)) {
        wp_mkdir_p($generated_dir);
    }

    $pdf_file = $generated_dir . "form-{$form_id}-entry-{$entry_id}.pdf";
    file_put_contents($pdf_file, $pdf_binary);

    $notification_sent = false;
    if ($request->get_param('send_notification')) {
        $form = GFAPI::get_form($form_id);
        if ($form && !is_wp_error($form)) {
            GFAPI::send_notifications($form, $entry);
            $notification_sent = true;
        }
    }

    return rest_ensure_response(array(
        'success'           => true,
        'entry_id'          => $entry_id,
        'form_id'           => $form_id,
        'filename'          => basename($pdf_file),
        'file_size'         => filesize($pdf_file),
        'notification_sent' => $notification_sent,
    ));
}


/**
 * ============================================================
 * GRAVITY FORMS DATA EXTRACTION
 * ============================================================
 */

function pfgf_build_forms_data() {

    if (!class_exists('GFAPI')) {
        return new WP_Error(
            'gravity_forms_unavailable',
            'Gravity Forms is not available.',
            array('status' => 503)
        );
    }

    $forms = GFAPI::get_forms();

    if (!is_array($forms)) {
        return new WP_Error(
            'gravity_forms_read_failed',
            'Unable to read Gravity Forms.',
            array('status' => 500)
        );
    }

    $output = array(
        'source'  => 'gravity_forms',
        'version' => '1.3.0',
        'forms'   => array(),
    );

    foreach ($forms as $form) {
        if (!is_array($form)) continue;

        $form_id    = isset($form['id']) ? (string) $form['id'] : '';
        $form_title = isset($form['title']) ? (string) $form['title'] : '';

        $form_data = array(
            'id'     => $form_id,
            'title'  => $form_title,
            'fields' => array(),
        );

        $fields = isset($form['fields']) && is_array($form['fields']) ? $form['fields'] : array();

        foreach ($fields as $field) {
            if (!is_object($field)) continue;

            $field_type = isset($field->type) ? (string) $field->type : '';
            $visibility = isset($field->visibility) ? (string) $field->visibility : '';

            // Do not pass hidden or administrative fields
            if ($field_type === 'hidden' || $visibility === 'hidden' || $visibility === 'administrative') {
                continue;
            }

            $field_id          = isset($field->id) ? (string) $field->id : '';
            $field_label       = isset($field->label) ? (string) $field->label : '';
            $field_admin_label = isset($field->adminLabel) ? (string) $field->adminLabel : '';

            $field_data = array(
                'id'         => $field_id,
                'label'      => $field_label,
                'adminLabel' => $field_admin_label,
                'type'       => $field_type,
                'required'   => !empty($field->isRequired),
            );

            if (isset($field->choices) && is_array($field->choices)) {
                $field_data['choices'] = array();
                foreach ($field->choices as $choice) {
                    if (!is_array($choice)) continue;
                    $field_data['choices'][] = array(
                        'text'  => isset($choice['text']) ? (string) $choice['text'] : '',
                        'value' => isset($choice['value']) ? (string) $choice['value'] : '',
                    );
                }
            }

            if (isset($field->inputs) && is_array($field->inputs)) {
                $field_data['inputs'] = array();
                foreach ($field->inputs as $input) {
                    if (!is_array($input)) continue;
                    $field_data['inputs'][] = array(
                        'id'    => isset($input['id']) ? (string) $input['id'] : '',
                        'label' => isset($input['label']) ? (string) $input['label'] : '',
                    );
                }
            }

            $form_data['fields'][] = $field_data;
        }

        $output['forms'][] = $form_data;
    }

    return $output;
}


/**
 * ============================================================
 * AUTOMATED SUBMISSION RECORDING & EMAIL DISPATCH
 * ============================================================
 */

/**
 * Save entry payload as JSON in wp-content/pdf-generator/submissions/
 */
function pfgf_save_submission_json($entry, $form) {

    $submissions_dir = WP_CONTENT_DIR . '/pdf-generator/submissions/';
    if (!file_exists($submissions_dir)) {
        wp_mkdir_p($submissions_dir);
    }

    $entry_id   = isset($entry['id']) ? $entry['id'] : 'unknown';
    $form_id    = isset($form['id']) ? $form['id'] : 'unknown';
    $form_title = isset($form['title']) ? $form['title'] : '';

    $json_file = $submissions_dir . "entry-{$entry_id}.json";
    $payload = array(
        'entry_id'     => $entry_id,
        'form_id'      => $form_id,
        'form_title'   => $form_title,
        'submitted_at' => current_time('mysql'),
        'entry'        => $entry,
    );

    file_put_contents(
        $json_file,
        wp_json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
    );

    return $json_file;
}


/**
 * Ensure destination directory exists and trigger PDF generation.
 * Returns the destination path if the generated PDF exists on disk.
 */
function pfgf_get_or_create_pdf_for_entry($entry, $form) {

    $entry_id = isset($entry['id']) ? $entry['id'] : 0;
    $form_id  = isset($form['id']) ? $form['id'] : 0;

    if (!$entry_id || !$form_id) {
        return false;
    }

    $generated_dir = WP_CONTENT_DIR . '/pdf-generator/generated/';
    if (!file_exists($generated_dir)) {
        wp_mkdir_p($generated_dir);
    }

    $pdf_destination = $generated_dir . "form-{$form_id}-entry-{$entry_id}.pdf";

    // If PDF is already on disk, return it immediately
    if (file_exists($pdf_destination) && filesize($pdf_destination) > 0) {
        return $pdf_destination;
    }

    // Trigger action hook so custom listeners or node engines can generate the PDF
    do_action('pfgf_generate_pdf_for_entry', $entry_id, $form_id, $pdf_destination, $entry, $form);

    // If a webhook URL is configured, dispatch request
    $webhook_url = pfgf_get_webhook_url();
    if (!file_exists($pdf_destination) && !empty($webhook_url)) {
        pfgf_dispatch_pdf_generation_webhook($entry_id, $form_id, $pdf_destination, $entry);
    }

    // Return destination path if generated successfully
    if (file_exists($pdf_destination) && filesize($pdf_destination) > 0) {
        return $pdf_destination;
    }

    return false;
}


/**
 * Dispatch entry to external PDF generator webhook
 */
function pfgf_dispatch_pdf_generation_webhook($entry_id, $form_id, $pdf_destination, $entry) {

    $webhook_url = pfgf_get_webhook_url();
    if (empty($webhook_url)) {
        return;
    }

    $headers = array(
        'Content-Type' => 'application/json',
        'Accept'       => 'application/pdf, application/json',
    );
    $api_key = pfgf_get_api_key();
    if ($api_key) {
        $headers['X-PDF-API-Key'] = $api_key;
    }

    $response = wp_remote_post($webhook_url, array(
        'timeout'     => 30,
        'sslverify'   => false,
        'headers'     => $headers,
        'body'        => wp_json_encode(array(
            'entry_id'        => $entry_id,
            'form_id'         => $form_id,
            'pdf_destination' => $pdf_destination,
            'entry'           => $entry,
        )),
    ));

    $status_code = is_wp_error($response) ? 0 : wp_remote_retrieve_response_code($response);
    $error_msg   = is_wp_error($response) ? $response->get_error_message() : '';
    $body        = is_wp_error($response) ? '' : wp_remote_retrieve_body($response);

    // Save log for diagnosis in Admin screen
    update_option('pfgf_last_webhook_log', array(
        'timestamp'    => current_time('mysql'),
        'entry_id'     => $entry_id,
        'form_id'      => $form_id,
        'webhook_url'  => $webhook_url,
        'status_code'  => $status_code,
        'error_msg'    => $error_msg,
        'body_preview' => substr($body, 0, 300),
    ));

    if (!is_wp_error($response) && $status_code === 200) {
        if (substr($body, 0, 4) === '%PDF') {
            file_put_contents($pdf_destination, $body);
        } else {
            $json = json_decode($body, true);
            if (!empty($json['pdfBytesBase64'])) {
                file_put_contents($pdf_destination, base64_decode($json['pdfBytesBase64']));
            }
        }
    }
}


/**
 * 1. Notification Hook: Run generation FIRST so PDF exists before email is dispatched.
 */
add_filter('gform_notification', 'pfgf_handle_gform_notification', 10, 3);

function pfgf_handle_gform_notification($notification, $form, $entry) {

    if (empty($entry) || empty($form)) {
        return $notification;
    }

    // 1. Ensure submission JSON is recorded
    pfgf_save_submission_json($entry, $form);

    // 2. Ensure PDF is generated before email is formatted
    $pdf_path = pfgf_get_or_create_pdf_for_entry($entry, $form);

    // 3. Attach generated PDF to notification email
    if ($pdf_path && file_exists($pdf_path)) {
        if (!isset($notification['attachments']) || !is_array($notification['attachments'])) {
            $notification['attachments'] = array();
        }
        if (!in_array($pdf_path, $notification['attachments'], true)) {
            $notification['attachments'][] = $pdf_path;
        }
    }

    return $notification;
}


/**
 * 2. Submission Hook: Run after submission to guarantee JSON recording & generation
 *    even when no email notifications are configured for the form.
 */
add_action('gform_after_submission', 'pfgf_handle_gform_after_submission', 10, 2);

function pfgf_handle_gform_after_submission($entry, $form) {

    if (empty($entry) || empty($form)) {
        return;
    }

    // Ensure submission JSON is saved
    pfgf_save_submission_json($entry, $form);

    // Ensure PDF is generated
    pfgf_get_or_create_pdf_for_entry($entry, $form);
}
