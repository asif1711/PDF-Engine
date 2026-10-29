/**
 * Authentication API Client
 * Uses same-origin requests with cookie credentials.
 */

export async function loginApi(email, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ email, password }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || 'Login failed. Please check your credentials.');
  }

  return data;
}

export async function getMeApi() {
  const res = await fetch('/api/auth/me', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    return null;
  }

  const data = await res.json().catch(() => ({}));
  if (res.ok && data.authenticated && data.user) {
    return data.user;
  }

  return null;
}

export async function logoutApi() {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
      credentials: 'same-origin',
    });
  } catch (err) {
    console.warn('[Auth] Logout network warning:', err);
  }
  return true;
}
