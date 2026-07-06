import './App.css'
import SplatViewer from './components/SplatViewer.jsx'
function App() {
    document.title = "GIS Viz"
    return (
        <main className="app-shell">
        <section className="hero-panel">
            <SplatViewer />
        </section>
        </main>
    )
}

export default App
