/**
 * Compact indeterminate progress bar bound to a real asynchronous operation.
 * It is rendered only while that operation is actually running, so it never
 * appears for plain navigation, dropdown changes, or tab switches.
 */
export default function AsyncProgressBar({ label }) {
    if (!label) return null;

    return (
        <div className="async-progress" role="status" aria-live="polite">
            <span className="async-progress-label">{label}</span>
            <span className="async-progress-track">
                <span className="async-progress-bar" />
            </span>
        </div>
    );
}