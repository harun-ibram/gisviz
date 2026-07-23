import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import './App.css'
import SplatViewer from './components/SplatViewer.jsx'
import Home from './components/Home.jsx'
import { SplatLibraryProvider } from './hooks/SplatLibraryProvider.jsx'
import { useSplatLibrary } from './hooks/useSplatLibrary.js'
import { IconLogo, IconLibrary, IconVisualizer, IconNode, IconRegion } from './components/icons.jsx'

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
            </nav>
            <div className="gv-header-meta">
                
                <span className="tag tag-accent">{nodes.length + regions.length} splats</span>
            </div>
        </header>
    )
}

function Sidebar() {
    const { nodes, regions, apiBaseUrl } = useSplatLibrary()

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
            </div>
            <div className="gv-side-group">
                <span className="gv-side-label">Collections</span>
                <div className="gv-side gv-side--static">
                    <IconNode />
                    <span className="gv-side-flex">Nodes</span>
                    <span className="tag tag-neutral">{nodes.length}</span>
                </div>
                <div className="gv-side gv-side--static">
                    <IconRegion />
                    <span className="gv-side-flex">Regions</span>
                    <span className="tag tag-neutral">{regions.length}</span>
                </div>
            </div>
            <div className="gv-backend">
                <div className="gv-backend-title">Backend</div>
                <div className="gv-backend-status">
                    <span className="gv-pulse-dot" />
                    Connected · {apiBaseUrl}
                </div>
            </div>
        </aside>
    )
}

function App() {
    return (
        <BrowserRouter>
            <SplatLibraryProvider>
                <div className="gv-shell">
                    <Header />
                    <div className="gv-body">
                        <Sidebar />
                        <main className="gv-main">
                            <Routes>
                                <Route path="/" element={<Home />} />
                                <Route path="/viewer" element={<SplatViewer />} />
                            </Routes>
                        </main>
                    </div>
                </div>
            </SplatLibraryProvider>
        </BrowserRouter>
    )
}

export default App
