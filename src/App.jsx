import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
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
import { IconLogo, IconLibrary, IconVisualizer, IconNode, IconRegion, IconUpload, IconLayers } from './components/icons.jsx'
import { Analytics } from '@vercel/analytics/react'
import Regions from './components/Regions.jsx'

// Lazy so Leaflet and the GIS page stay out of the Home/Viewer chunk.
const GisPage = lazy(() => import('./components/gis/GisPage.jsx'))

const navLinkClass = ({ isActive }) => `gv-nav-link${isActive ? ' gv-nav-link--active' : ''}`
const sideLinkClass = ({ isActive }) => `gv-side${isActive ? ' gv-side--active' : ''}`

function Header() {
    const { nodes, regions } = useSplatLibrary()

    return (
        <header className="gv-header">
            <div className="gv-brand">
                <span className="gv-brand-icon">
                    <IconLogo />
                </span>
                <span className="gv-brand-name">GISViz</span>
            </div>
            <nav className="gv-nav">
                <NavLink to="/" end className={navLinkClass}>Library</NavLink>
                <NavLink to="/viewer" className={navLinkClass}>Visualizer</NavLink>
                <NavLink to="/upload" className={navLinkClass}>Upload</NavLink>
                <NavLink to="/gis" className={navLinkClass}>GIS</NavLink>
            </nav>
            <div className="gv-header-meta">
                
                <span className="tag tag-accent">{nodes.length + regions.length} splats</span>
            </div>
        </header>
    )
}

function Sidebar() {
    const { nodes, regions, allNodes, allRegions } = useSplatLibrary()
    const { layers } = useGisLibrary()

    return (
        <aside className="gv-sidebar">
            <div className="gv-side-group">
                <span className="gv-side-label">Navigate</span>
                <NavLink to="/" end className={sideLinkClass}>
                    <IconLibrary />
                    <span>Splat library</span>
                </NavLink>
                <NavLink to="/viewer" className={sideLinkClass}>
                    <IconVisualizer />
                    <span>Visualizer</span>
                </NavLink>
                <NavLink to="/upload" className={sideLinkClass}>
                    <IconUpload />
                    <span>Upload photos</span>
                </NavLink>
                <NavLink to="/gis" className={sideLinkClass}>
                    <IconLayers />
                    <span className="gv-side-flex">GIS layers</span>
                    <span className="tag tag-neutral">{layers.length}</span>
                </NavLink>
            </div>
            <div className="gv-side-group">
                <span className="gv-side-label">Collections</span>
                <NavLink to="/nodes" className={sideLinkClass}>
                    <IconNode />
                    <span className="gv-side-flex">Nodes</span>
                    <span className="tag tag-neutral">{allNodes.length}</span>
                </NavLink>
                <NavLink to="/regions" className={sideLinkClass}>
                    <IconRegion />
                    <span className="gv-side-flex">Regions</span>
                    <span className="tag tag-neutral">{allRegions.length}</span>
                </NavLink>
            </div>
        </aside>
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
                        context, and Sidebar needs its layer count. */}
                    <GisLibraryProvider>
                        <div className="gv-shell">
                            <Header />
                            <div className="gv-body">
                                <Sidebar />
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
                            fixed child. */}
                        <AuthCorner />
                        <Analytics />
                    </GisLibraryProvider>
                </AuthProvider>
            </SplatLibraryProvider>
        </BrowserRouter>
    )
}

export default App
