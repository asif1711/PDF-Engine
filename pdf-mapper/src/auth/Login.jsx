import { useState } from 'react';
import { Lock, Mail, Eye, EyeOff, ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from './useAuth.js';
import './Login.css';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage('');

    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setErrorMessage('Please enter your administrator email address.');
      return;
    }

    if (!password) {
      setErrorMessage('Please enter your administrator password.');
      return;
    }

    setIsLoading(true);
    try {
      await login(cleanEmail, password);
    } catch (err) {
      setErrorMessage(err.message || 'Invalid email or password. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-page-container">
      <div className="login-backdrop-glow" aria-hidden="true" />

      <div className="login-card" role="region" aria-label="Administrator Login">
        {/* Brand Header */}
        <div className="login-brand-header">
          <div className="login-brand-badge">
            <svg className="login-pdf-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <defs>
                <linearGradient id="loginPdfBody" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#EF4444" />
                  <stop offset="1" stopColor="#B91C1C" />
                </linearGradient>
                <linearGradient id="loginPdfFold" x1="19.5" y1="2" x2="28" y2="10.5" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#FECACA" />
                  <stop offset="1" stopColor="#F87171" />
                </linearGradient>
              </defs>
              <path d="M7 2C5.34315 2 4 3.34315 4 5V27C4 28.6569 5.34315 30 7 30H25C26.6569 30 28 28.6569 28 27V10.5L19.5 2H7Z" fill="url(#loginPdfBody)" />
              <path d="M19.5 2V8.5C19.5 9.60457 20.3954 10.5 21.5 10.5H28L19.5 2Z" fill="#7F1D1D" fillOpacity="0.35" />
              <path d="M19.5 2L28 10.5H21.5C20.3954 10.5 19.5 9.60457 19.5 8.5V2Z" fill="url(#loginPdfFold)" />
              <rect x="7.5" y="7" width="8" height="1.8" rx="0.9" fill="#FFFFFF" fillOpacity="0.5" />
              <path fillRule="evenodd" clipRule="evenodd" d="M7.5 13.5H10.7C12.1 13.5 13 14.4 13 15.8V16.1C13 17.5 12.1 18.4 10.7 18.4H9.3V22.5H7.5V13.5ZM9.3 16.9H10.6C11.1 16.9 11.3 16.6 11.3 16.1V16C11.3 15.5 11.1 15.2 10.6 15.2H9.3V16.9Z" fill="#FFFFFF" />
              <path fillRule="evenodd" clipRule="evenodd" d="M13.7 13.5H16.6C18.2 13.5 19.4 14.6 19.4 16.3V18.7C19.4 20.4 18.2 21.5 16.6 21.5H13.7V13.5ZM15.5 19.8H16.6C17.3 19.8 17.7 19.3 17.7 18.5V16.4C17.7 15.6 17.3 15.1 16.6 15.1H15.5V19.8Z" fill="#FFFFFF" />
              <path d="M20.3 13.5H24.7V15.1H22.1V17.3H24.3V18.9H22.1V22.5H20.3V13.5Z" fill="#FFFFFF" />
              <rect x="7.5" y="25" width="17" height="1.6" rx="0.8" fill="#FFFFFF" fillOpacity="0.4" />
            </svg>
            <span className="login-brand-title">PDF ENGINE</span>
          </div>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div className="login-alert-error" role="alert" aria-live="polite">
            <AlertCircle size={16} className="login-alert-icon" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Form */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="login-field-group">
            <label htmlFor="admin-email" className="login-label">
              Administrator Email
            </label>
            <div className="login-input-wrapper">
              <Mail size={16} className="login-input-icon" aria-hidden="true" />
              <input
                id="admin-email"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
                disabled={isLoading}
                className="login-input"
                aria-required="true"
              />
            </div>
          </div>

          <div className="login-field-group">
            <label htmlFor="admin-password" className="login-label">
              Password
            </label>
            <div className="login-input-wrapper">
              <Lock size={16} className="login-input-icon" aria-hidden="true" />
              <input
                id="admin-password"
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                disabled={isLoading}
                className="login-input"
                aria-required="true"
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? 'Hide password' : 'Show password'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={0}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="login-submit-btn"
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>Verifying credentials...</span>
              </>
            ) : (
              <>
                <ShieldCheck size={16} />
                <span>Login</span>
              </>
            )}
          </button>
        </form>

      </div>
    </div>
  );
}
