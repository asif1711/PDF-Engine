import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './auth/AuthContext.jsx'

// Ensure all /api requests automatically include credentials (session cookies)
// across cross-site iframes, embedded previews, and reverse proxies.
const originalFetch = window.fetch;
window.fetch = function (input, init = {}) {
  const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
  if (typeof url === 'string' && (url.startsWith('/api') || url.includes('/api/'))) {
    return originalFetch.call(this, input, {
      credentials: 'include',
      ...init,
    });
  }
  return originalFetch.call(this, input, init);
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
