import { useCallback, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { HeaderSearchContext } from './headerSearchContext.js'

/**
 * Holds the header search box's text for whichever page is open.
 *
 * The query is stored with the path it was typed on, and read back as empty
 * anywhere else: leaving the library and coming back to a list still filtered
 * by a search you cannot see is the failure mode this avoids, and doing it by
 * comparison rather than by clearing on navigation keeps it out of an effect.
 */
export function HeaderSearchProvider({ children }) {
    const { pathname } = useLocation()
    const [entry, setEntry] = useState({ path: null, query: '' })

    const query = entry.path === pathname ? entry.query : ''

    const setQuery = useCallback(
        (next) => setEntry({ path: pathname, query: next }),
        [pathname],
    )

    const value = useMemo(() => ({ query, setQuery }), [query, setQuery])

    return (
        <HeaderSearchContext.Provider value={value}>
            {children}
        </HeaderSearchContext.Provider>
    )
}
