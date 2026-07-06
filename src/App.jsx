import './App.css'
import OSMViewer from './components/OSMViewer.jsx'
import SplatViewer from './components/SplatViewer.jsx'
function App() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <SplatViewer />
        <OSMViewer />
      </section>
    </main>
  )
}

export default App
