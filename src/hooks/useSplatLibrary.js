import { useContext } from 'react'
import { SplatLibraryContext } from './splatLibraryContext.js'

export function useSplatLibrary() {
    const context = useContext(SplatLibraryContext)

    if (!context) {
        throw new Error('useSplatLibrary must be used within a SplatLibraryProvider')
    }

    return context
}
