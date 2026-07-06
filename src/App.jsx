import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import './App.css'

function App() {
  const stageRef = useRef(null)
  const sceneRef = useRef(null)
  const rendererRef = useRef(null)
  const sparkRef = useRef(null)
  const splatRef = useRef(null)
  const frameRef = useRef(0)
  const [selectedFile, setSelectedFile] = useState(null)
  const [status, setStatus] = useState('Upload a .ply or .splat file to preview it.')
  const [error, setError] = useState('')

  useEffect(() => {
    const stage = stageRef.current

    if (!stage) {
      return undefined
    }

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x07111f)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(0, 0.35, 3.2)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    stage.appendChild(renderer.domElement)

    const spark = new SparkRenderer({ renderer })
    scene.add(spark)

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.25)
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.6)
    keyLight.position.set(2.5, 2.5, 4)
    const rimLight = new THREE.PointLight(0xff8f42, 18, 14)
    rimLight.position.set(-2.8, -1.4, 3.2)

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

    const render = () => {
      if (splatRef.current) {
        splatRef.current.rotation.y += 0.004
      }
      renderer.render(scene, camera)
      frameRef.current = window.requestAnimationFrame(render)
    }

    render()

    sceneRef.current = scene
    rendererRef.current = renderer
    sparkRef.current = spark

    return () => {
      window.cancelAnimationFrame(frameRef.current)
      resizeObserver.disconnect()
      if (splatRef.current) {
        scene.remove(splatRef.current)
        splatRef.current.dispose()
        splatRef.current = null
      }
      spark.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === stage) {
        stage.removeChild(renderer.domElement)
      }
    }
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    const renderer = rendererRef.current

    if (!selectedFile || !scene || !renderer) {
      return undefined
    }

    let active = true

    const disposeCurrentSplat = () => {
      if (splatRef.current) {
        scene.remove(splatRef.current)
        splatRef.current.dispose()
        splatRef.current = null
      }
    }

    const loadSplat = async () => {
      disposeCurrentSplat()
      setError('')
      setStatus(`Loading ${selectedFile.name}...`)

      const extension = selectedFile.name.split('.').pop()?.toLowerCase()

      if (extension !== 'ply' && extension !== 'splat') {
        if (!active) {
          return
        }
        setError('Please choose a .ply or .splat file.')
        setStatus('Upload a .ply or .splat file to preview it.')
        return
      }

      try {
        const arrayBuffer = await selectedFile.arrayBuffer()
        const bytes = new Uint8Array(arrayBuffer)
        const fileType = extension === 'ply' ? 'ply' : 'splat'

        const splat = new SplatMesh({
          fileBytes: bytes,
          fileType,
          fileName: selectedFile.name,
          onProgress: (event) => {
            if (!active) {
              return
            }
            setStatus(`Loading ${selectedFile.name} (${Math.round((event.loaded / Math.max(event.total, 1)) * 100)}%)`)
          },
        })

        await splat.initialized

        if (!active) {
          splat.dispose()
          return
        }

        splat.position.set(0, -0.08, -1.3)
        splat.scale.setScalar(0.9)
        splat.rotation.y = 0.25
        scene.add(splat)
        splatRef.current = splat
        setStatus(`Rendered ${selectedFile.name}`)
      } catch (loadError) {
        if (!active) {
          return
        }
        const message = loadError instanceof Error ? loadError.message : 'Unable to read that file.'
        setError(message)
        setStatus('Upload a .ply or .splat file to preview it.')
      }
    }

    loadSplat()

    return () => {
      active = false
      disposeCurrentSplat()
    }
  }, [selectedFile])

  const handleFileChange = (event) => {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    setSelectedFile(file)
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="copy">
          <p className="eyebrow">React + Three.js + Spark</p>
          <h1>Gaussian splat viewer</h1>
          <p className="description">
            Upload a local .ply or .splat file to render it with Spark inside this Vite app.
          </p>
          <label className="upload-card">
            <span className="upload-label">Choose splat file</span>
            <input type="file" accept=".ply,.splat" onChange={handleFileChange} />
          </label>
          <p className="pill">{status}</p>
          {error ? <p className="status-error">{error}</p> : null}
        </div>

        <div className="stage" ref={stageRef} aria-label="Spark splat preview" />
      </section>
    </main>
  )
}

export default App
