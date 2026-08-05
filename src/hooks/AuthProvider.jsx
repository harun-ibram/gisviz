import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthContext } from './authContext.js'
import { useSplatLibrary } from './useSplatLibrary.js'
import { makeAuthApi } from '../auth/authApi.js'

// localStorage rather than sessionStorage: the backend's token lives 8h, and a
// login is expected to survive a browser restart until then. Key naming follows
// gisviz:<feature>:v<n>, as in GisLibraryProvider.
const STORAGE_KEY = 'gisviz:auth:v1'

function readStoredSession() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)

        if (!raw) {
            return null
        }

        const { token, user } = JSON.parse(raw)

        return token && user?.email ? { token, user } : null
    } catch {
        // Unavailable or corrupt storage just means "signed out".
        return null
    }
}

function writeStoredSession(session) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    } catch {
        // A full or unavailable storage is not worth surfacing.
    }
}

function clearStoredSession() {
    try {
        localStorage.removeItem(STORAGE_KEY)
    } catch {
        // Same.
    }
}

export function AuthProvider({ children }) {
    // The one permitted source of the base URL — this file never reads
    // import.meta.env.
    const { apiBaseUrl } = useSplatLibrary()
    const api = useMemo(() => makeAuthApi(apiBaseUrl), [apiBaseUrl])

    // Read once at mount. State rather than a ref so nothing touches a ref
    // during render.
    const [stored] = useState(readStoredSession)

    // The token lives in a ref, not in state: makeGisApi reads it through
    // getToken(), and a token in state would re-memoize the whole GIS API
    // every time it changed.
    const tokenRef = useRef(stored?.token ?? null)

    // Restored optimistically so a reload does not flash the signed-out UI;
    // the /auth/me check below confirms or drops it.
    const [user, setUser] = useState(stored?.user ?? null)
    const [ready, setReady] = useState(!stored)
    const [dialogOpen, setDialogOpen] = useState(false)

    useEffect(() => {
        if (!stored) {
            return undefined
        }

        const controller = new AbortController()

        api.me(stored.token, controller.signal)
            .then((fresh) => {
                tokenRef.current = stored.token
                setUser(fresh)
                setReady(true)
            })
            .catch((error) => {
                if (error?.name === 'AbortError') {
                    return
                }

                // Only the backend saying "no" drops the session. A network
                // blip must not sign someone out of a still-valid token.
                if (error?.status === 401 || error?.status === 403) {
                    tokenRef.current = null
                    clearStoredSession()
                    setUser(null)
                }

                setReady(true)
            })

        return () => controller.abort()
    }, [api, stored])

    const getToken = useCallback(() => tokenRef.current, [])

    const login = useCallback(async (email, password) => {
        const response = await api.login({ email, password })
        const session = { token: response.access_token, user: response.user }

        tokenRef.current = session.token
        writeStoredSession(session)
        setUser(session.user)
        setReady(true)

        return session.user
    }, [api])

    const logout = useCallback(() => {
        tokenRef.current = null
        clearStoredSession()
        setUser(null)
    }, [])

    const requireLogin = useCallback(() => setDialogOpen(true), [])
    const closeDialog = useCallback(() => setDialogOpen(false), [])

    /**
     * A token that expired mid-session should read as "sign in again", not as a
     * red error string. Passed to makeGisApi so every GIS mutation funnels
     * through it; the splat upload calls it directly.
     */
    const handleUnauthorized = useCallback(() => {
        tokenRef.current = null
        clearStoredSession()
        setUser(null)
        setDialogOpen(true)
    }, [])

    const value = useMemo(() => ({
        user,
        isAuthed: Boolean(user),
        ready,
        getToken,
        login,
        logout,
        requireLogin,
        handleUnauthorized,
        dialogOpen,
        closeDialog,
    }), [user, ready, getToken, login, logout, requireLogin, handleUnauthorized, dialogOpen, closeDialog])

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    )
}
