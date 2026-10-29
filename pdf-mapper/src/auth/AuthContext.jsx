import { useState, useEffect, useCallback } from 'react';
import { AuthContext } from './authContextDef.js';
import { getMeApi, loginApi, logoutApi } from './authApi.js';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    getMeApi()
      .then((currentUser) => {
        if (isMounted) setUser(currentUser);
      })
      .catch((err) => {
        console.warn('[Auth] Session check failed:', err);
        if (isMounted) setUser(null);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (email, password) => {
    const res = await loginApi(email, password);
    if (res?.user) {
      setUser(res.user);
      return res.user;
    }
    throw new Error('Authentication succeeded but user profile was not returned.');
  };

  const logout = async () => {
    await logoutApi();
    setUser(null);
  };

  const handleUnauthorized = useCallback(() => {
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: Boolean(user),
        login,
        logout,
        handleUnauthorized,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export default AuthProvider;
