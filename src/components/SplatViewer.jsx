import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import OSMViewer from './OSMViewer.jsx'

function SplatViewer() {
  const stageRef = useRef(null)
  const sceneRef = useRef(null)
  const rendererRef = useRef(null)
  const sparkRef = useRef(null)
  const splatRef = useRef(null)
  const frameRef = useRef(0)
  const dragStateRef = useRef({ isDragging: false, lastX: 0, lastY: 0 })
  const cameraRef = useRef(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [status, setStatus] = useState('Waiting for file upload')
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(3.2)

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
    cameraRef.current = camera

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

    const handlePointerDown = (event) => {
      if (event.button !== 0 || !splatRef.current) {
        return
      }

      dragStateRef.current.isDragging = true
      dragStateRef.current.lastX = event.clientX
      dragStateRef.current.lastY = event.clientY
      renderer.domElement.setPointerCapture?.(event.pointerId)
      event.preventDefault()
    }

    const handlePointerMove = (event) => {
      const dragState = dragStateRef.current

      if (!dragState.isDragging || !splatRef.current) {
        return
      }

      const deltaX = event.clientX - dragState.lastX
      const deltaY = event.clientY - dragState.lastY

      dragState.lastX = event.clientX
      dragState.lastY = event.clientY

      if (deltaX !== 0 || deltaY !== 0) {
        splatRef.current.rotation.y += deltaX * 0.01
        splatRef.current.rotation.x += deltaY * 0.01
      }
    }

    const handlePointerUp = (event) => {
      if (!dragStateRef.current.isDragging) {
        return
      }

      dragStateRef.current.isDragging = false
      renderer.domElement.releasePointerCapture?.(event.pointerId)
    }

    resizeRenderer()

    const resizeObserver = new ResizeObserver(resizeRenderer)
    resizeObserver.observe(stage)

    renderer.domElement.addEventListener('pointerdown', handlePointerDown)
    renderer.domElement.addEventListener('pointermove', handlePointerMove)
    renderer.domElement.addEventListener('pointerup', handlePointerUp)
    renderer.domElement.addEventListener('pointercancel', handlePointerUp)

    const render = () => {
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
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      renderer.domElement.removeEventListener('pointermove', handlePointerMove)
      renderer.domElement.removeEventListener('pointerup', handlePointerUp)
      renderer.domElement.removeEventListener('pointercancel', handlePointerUp)

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
      setStatus('Loading...')

      const extension = selectedFile.name.split('.').pop()?.toLowerCase()

      if (extension !== 'ply' && extension !== 'splat') {
        if (!active) {
          return
        }

        setError('Please choose a .ply or .splat file.')
        setStatus('Upload a file')
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
        setStatus('Rendered')
      } catch (loadError) {
        if (!active) {
          return
        }

        const message = loadError instanceof Error ? loadError.message : 'Unable to read that file.'
        setError(message)
        setStatus('Upload a file')
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

  const handleScroll = (event) => {
    event.preventDefault()

    const camera = cameraRef.current

    if (!camera) {
      return
    }

    setZoom((currentZoom) => {
      const delta = event.deltaY > 0 ? 0.2 : -0.2
      const nextZoom = Math.max(0.1, Math.min(8, currentZoom + delta))
      camera.position.z = nextZoom
      return nextZoom
    })
  }

  const handleZoom = (direction) => {
    const camera = cameraRef.current

    if (!camera) {
      return
    }

    const nextZoom = Math.max(0.1, Math.min(8, zoom + direction * 0.4))
    camera.position.z = nextZoom
    setZoom(nextZoom)
  }

  return (
    <section className="viewer-panel viewer-panel-splat">
      <div className="copy">
        <h1>GIS Visualizer</h1>
        <p className="description">Upload a local .ply or .splat file to render it.</p>

        <div className="controls-row">
          <label className="upload-card">
            <span className="upload-label">Choose splat file</span>
            <input type="file" accept=".ply,.splat" onChange={handleFileChange} />
          </label>
          <div className="zoom-controls" aria-label="Zoom controls">
            <button type="button" className="zoom-button" onClick={() => handleZoom(-1)}>
              −
            </button>
            <span className="zoom-value">{zoom.toFixed(1)}x</span>
            <button type="button" className="zoom-button" onClick={() => handleZoom(1)}>
              +
            </button>
          </div>
        </div>

        <div className="status-row">
          <span>Status:</span>
          <span className="pill">{status}</span>
        </div>

        {error ? <p className="status-error">{error}</p> : null}
      </div>

      <div className="stage-card" aria-label="Spark splat preview" onWheel={handleScroll}>
        <div className="stage" ref={stageRef} />
        <OSMViewer className="map-card map-card-overlay" />
      </div>

    </section>
  )
}

export default SplatViewer