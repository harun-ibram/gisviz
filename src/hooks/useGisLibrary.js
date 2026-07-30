import { useContext } from 'react'
import { GisLibraryContext } from './gisLibraryContext.js'

export function useGisLibrary() {
    const context = useContext(GisLibraryContext)

    if (!context) {
        throw new Error('useGisLibrary must be used within a GisLibraryProvider')
    }

    return context
}
