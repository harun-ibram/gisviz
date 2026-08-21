import { useContext } from 'react'
import { HeaderSearchContext } from './headerSearchContext.js'

/**
 * The query typed into the search box in the app header.
 *
 * The box is drawn by the shell but filters a list only the page knows about,
 * so the text lives between them. Returns { query, setQuery }.
 */
export function useHeaderSearch() {
    const context = useContext(HeaderSearchContext)

    if (!context) {
        throw new Error('useHeaderSearch must be used within a HeaderSearchProvider')
    }

    return context
}
