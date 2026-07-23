import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './buttons.css'
import './App.css'
import SplatViewer from './components/SplatViewer.jsx'
import Home from './components/Home.jsx'

function App() {
    return (
        <BrowserRouter>
            <main className="app-shell">
                <section className="hero-panel">
                    <Routes>
                        <Route path="/" element={<Home />} />
                        <Route path="/viewer" element={<SplatViewer />} />
                    </Routes>
                </section>
            </main>
        </BrowserRouter>
    )
}

export default App
