import { request } from '../gis/gisApi.js'

/**
 * The two routes of the backend's /auth surface. `apiBaseUrl` comes from
 * useSplatLibrary() — this module never reads import.meta.env — and `request()`
 * is shared with gisApi.js so the whole app has one fetch/error path.
 */
export function makeAuthApi(apiBaseUrl) {
    const base = `${apiBaseUrl}/auth`

    return {
        login: ({ email, password }) => request(`${base}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        }),

        // The only place a token is sent outside the mutating endpoints: it is
        // how a stored session is checked for expiry at startup.
        me: (token, signal) => request(`${base}/me`, {
            headers: { Authorization: `Bearer ${token}` },
            signal,
        }),
    }
}
