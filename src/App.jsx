import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom'
import './App.css'
import SplatViewer from './components/SplatViewer.jsx'
import Home from './components/Home.jsx'
import Upload from './components/Upload.jsx'
import Nodes from './components/Nodes.jsx'
import { SplatLibraryProvider } from './hooks/SplatLibraryProvider.jsx'
import { useSplatLibrary } from './hooks/useSplatLibrary.js'
import { AuthProvider } from './hooks/AuthProvider.jsx'
import { GisLibraryProvider } from './hooks/GisLibraryProvider.jsx'
import { useGisLibrary } from './hooks/useGisLibrary.js'
import AuthCorner from './components/auth/AuthCorner.jsx'
import { IconLogo, IconRows, IconSearch, IconVisualizer, IconNode, IconRegion, IconUpload, IconLayers } from './components/icons.jsx'
import { HeaderSearchProvider } from './hooks/HeaderSearchProvider.jsx'
import { useHeaderSearch } from './hooks/useHeaderSearch.js'
import { Analytics } from '@vercel/analytics/react'
import Regions from './components/Regions.jsx'

// Lazy so Leaflet and the GIS page stay out of the Home/Viewer chunk.
const GisPage = lazy(() => import('./components/gis/GisPage.jsx'))

/**
 * The one list the rail and the header both read: the rail draws a button per
 * entry, the header takes its title and count from whichever entry matches the
 * current path.
 *
 * `count` is a function of the two library contexts rather than a number, so
 * the entry stays a plain constant and the live value is read at render.
 */
const SECTIONS = [
    {
        path: '/',
        end: true,
        label: 'Library',
        Icon: IconRows,
        count: ({ nodes, regions }) => nodes.length + regions.length,
        badge: (value) => `${value} splats active`,
        search: 'Search scenes, regions, or nodes…',
    },
    {
        path: '/viewer',
        label: 'Visualizer',
        Icon: IconVisualizer,
    },
    {
        path: '/upload',
        label: 'Upload',
        Icon: IconUpload,
    },
    {
        path: '/gis',
        label: 'GIS layers',
        Icon: IconLayers,
        count: ({ layers }) => layers.length,
        badge: (value) => `${value} layers`,
    },
    {
        path: '/nodes',
        label: 'Nodes',
        Icon: IconNode,
        count: ({ allNodes }) => allNodes.length,
        badge: (value) => `${value} nodes`,
        search: 'Search nodes…',
    },
    {
        path: '/regions',
        label: 'Regions',
        Icon: IconRegion,
        count: ({ allRegions }) => allRegions.length,
        badge: (value) => `${value} regions`,
        search: 'Search regions…',
    },
]

const railLinkClass = ({ isActive }) => `gv-rail-link${isActive ? ' gv-rail-link--active' : ''}`

/** Everything the section `count`/`badge` callbacks can read. */
function useLibraryCounts() {
    const { nodes, regions, allNodes, allRegions } = useSplatLibrary()
    const { layers } = useGisLibrary()

    return { nodes, regions, allNodes, allRegions, layers }
}

function Rail() {
    const counts = useLibraryCounts()

    return (
        <nav className="gv-rail" aria-label="Sections">
            <NavLink to="/" end className="gv-rail-brand" aria-label="GISViz" data-label="GISViz">
                <IconLogo size={19} />
            </NavLink>

            <div className="gv-rail-items">
                {SECTIONS.map(({ path, end, label, Icon, count }) => {
                    const value = count ? count(counts) : null

                    return (
                        <NavLink
                            key={path}
                            to={path}
                            end={end}
                            className={railLinkClass}
                            aria-label={label}
                            title={label}
                            data-label={label}
                        >
                            <Icon />
                            {value ? <span className="gv-rail-count">{value}</span> : null}
                        </NavLink>
                    )
                })}
            </div>
        </nav>
    )
}

function Header() {
    const counts = useLibraryCounts()
    const { pathname } = useLocation()
    const { query, setQuery } = useHeaderSearch()

    // Longest match, so /gis wins over / — the list is short enough that a
    // router-shaped lookup would be more machinery than it is worth.
    const section = SECTIONS
        .filter((entry) => (entry.end ? pathname === entry.path : pathname.startsWith(entry.path)))
        .sort((a, b) => b.path.length - a.path.length)[0] ?? SECTIONS[0]

    const total = counts.nodes.length + counts.regions.length
    const badge = section.badge
        ? section.badge(section.count(counts))
        : `${total} splats active`

    return (
        <header className="gv-header">
            <span className="gv-header-title">GISViz {section.label}</span>
            <span className="gv-header-badge">{badge}</span>

            {/* The search box belongs to the header but filters a list only the
                page can see, so the text travels by context — see
                HeaderSearchProvider. Sections with nothing to search leave the
                slot empty. */}
            <div className="gv-header-slot">
                {section.search ? (
                    <div className="gv-search-wrap">
                        <span className="gv-search-icon">
                            <IconSearch />
                        </span>
                        <input
                            className="input gv-search-input"
                            placeholder={section.search}
                            aria-label={section.search}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </div>
                ) : null}
            </div>
        </header>
    )
}

function App() {
    return (
        <BrowserRouter>
            <SplatLibraryProvider>
                {/* Inside the splat provider because apiBaseUrl only comes from
                    there; outside the GIS one because the GIS API needs the
                    token. The splat provider itself issues public GETs only. */}
                <AuthProvider>
                    {/* Nests inside: the GIS provider reads apiBaseUrl from the splat
                        context, and the rail needs its layer count. */}
                    <GisLibraryProvider>
                        {/* Inside the router: the query is scoped to the path
                            it was typed on. */}
                        <HeaderSearchProvider>
                            <div className="gv-shell">
                                {/* The rail runs the full height, left of the header. */}
                                <Rail />
                                <div className="gv-body">
                                    <Header />
                                    <main className="gv-main">
                                        <Routes>
                                            <Route path="/" element={<Home />} />
                                            <Route path="/viewer" element={<SplatViewer />} />
                                            <Route path="/upload" element={<Upload />} />
                                            <Route
                                                path="/gis"
                                                element={(
                                                    <Suspense fallback={<div className="gv-library"><p className="text-muted">Loading map…</p></div>}>
                                                        <GisPage />
                                                    </Suspense>
                                                )}
                                            />
                                            <Route path="/nodes" element={<Nodes />} />
                                            <Route path="/regions" element={<Regions />} />
                                        </Routes>
                                    </main>
                                </div>
                            </div>
                            {/* Outside .gv-shell: it is overflow:hidden and would clip a
                                fixed child. Sits at the foot of the rail. */}
                            <AuthCorner />
                        </HeaderSearchProvider>
                        <Analytics />
                    </GisLibraryProvider>
                </AuthProvider>
            </SplatLibraryProvider>
        </BrowserRouter>
    )
}

export default App
