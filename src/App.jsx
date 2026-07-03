import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import './App.css'

function App() {
  const stageRef = useRef(null)

  useEffect(() => {
    const stage = stageRef.current

    if (!stage) {
      return undefined
    }

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x07111f)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(0, 0.6, 4.1)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    stage.appendChild(renderer.domElement)

    const geometry = new THREE.TorusKnotGeometry(0.9, 0.28, 180, 24)
    const material = new THREE.MeshStandardMaterial({
      color: 0x8ad9ff,
      metalness: 0.55,
      roughness: 0.2,
    })
    const knot = new THREE.Mesh(geometry, material)
    scene.add(knot)

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.4)
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2)
    keyLight.position.set(3, 3, 4)
    const rimLight = new THREE.PointLight(0xff8f42, 20, 20)
    rimLight.position.set(-3, -1.5, 3)

    scene.add(ambientLight, keyLight, rimLight)

    const resizeRenderer = () => {
      const { clientWidth, clientHeight } = stage
      camera.aspect = clientWidth / clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(clientWidth, clientHeight, false)
    }

    resizeRenderer()

    const resizeObserver = new ResizeObserver(resizeRenderer)
    resizeObserver.observe(stage)

    let frameId = 0

    const render = () => {
      knot.rotation.x += 0.0035
      knot.rotation.y += 0.0075
      renderer.render(scene, camera)
      frameId = window.requestAnimationFrame(render)
    }

    render()

    return () => {
      window.cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === stage) {
        stage.removeChild(renderer.domElement)
      }
    }
  }, [])

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="copy">
          <p className="eyebrow">React + three.js</p>
          <h1>Minimal starter</h1>
          <p className="description">
            A blank React app with a small three.js scene ready for whatever you want to build next.
          </p>
        </div>

        <div className="stage" ref={stageRef} aria-label="Three.js preview" />
      </section>
    </main>
  )
}

export default App
