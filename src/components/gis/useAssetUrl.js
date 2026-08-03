import { useCallback, useEffect } from 'react'
import { useGisLibrary } from '../../hooks/useGisLibrary.js'

/**
 * Signed-URL access for one asset key.
 *
 * Holds no state of its own: the provider's `urlsByKey` is the single source, so
 * a proactive re-sign reaches every component showing that key with no
 * subscription bookkeeping. Seeded from the layer object, so the common case
 * ("layer loaded a minute ago") costs no request at all.
 */
export function useAssetUrl(key, initialUrl) {
    const { getFreshAssetUrl, urlsByKey } = useGisLibrary()

    // Provider cache first — after a refresh it holds the newer signature than
    // the one baked into the layer object.
    const url = key ? (urlsByKey[key] ?? initialUrl ?? null) : null

    // Only for a key nothing has signed yet; the provider's sweep handles
    // expiry for anything already on screen.
    useEffect(() => {
        if (key && !url) {
            getFreshAssetUrl(key).catch(() => {})
        }
    }, [key, url, getFreshAssetUrl])

    /** For an <img> error or a 403 on fetch — bypasses the freshness check. */
    const refresh = useCallback(
        () => (key ? getFreshAssetUrl(key, { force: true }) : Promise.resolve(null)),
        [key, getFreshAssetUrl],
    )

    return { url, refresh }
}
