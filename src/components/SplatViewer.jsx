import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import OSMViewer from './OSMViewer.jsx'
import { getFileExtension, getFileName } from '../utils.jsx'
import { IconClose, IconMap, IconMinus, IconPlus, IconUpload } from './icons.jsx'

// Where the splat is parked and where the camera starts. Zoom is measured
// between the two, so both live here rather than as literals at the call sites.
const SPLAT_POSITION = new THREE.Vector3(0, -0.08, -1.3)
const CAMERA_START = new THREE.Vector3(0, 0.35, 3.2)
const INITIAL_DISTANCE = CAMERA_START.distanceTo(SPLAT_POSITION)

// Zoom is reported as a multiplier on the starting framing: 1x = as loaded,
// higher = closer. The camera's *distance* runs the other way, which is what
// made the old readout look inverted — 0.1 was as close as it could get.
const MIN_DISTANCE = 0.15 // ~30x, and still clear of the camera's 0.1 near plane
const MAX_DISTANCE = 24
const ZOOM_STEP = 1.18 // per wheel notch; multiplicative so every notch feels equal
const BUTTON_STEPS = 3 // one +/- press is worth this many notches

// Free-fly movement. WASD walks the view plane, E/Q lift and drop along world Y
// (not camera Y, so a tilted view still rises straight up).
const MOVE_SPEED = 2.2 // world units per second
const SPRINT_MULTIPLIER = 3
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ'])
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight'])

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

// Don't steal keystrokes from a form control the user is actually typing in.
const isTypingTarget = (target) =>
  Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'))

  function SplatViewer() {
    const location = useLocation()
    const stageRef = useRef(null)
    const sceneRef = useRef(null)
    const rendererRef = useRef(null)
    const sparkRef = useRef(null)
    const splatRef = useRef(null)
    const frameRef = useRef(0)
    const dragStateRef = useRef({ isDragging: false, lastX: 0, lastY: 0 })
    const cameraRef = useRef(null)
    const keysRef = useRef(new Set())
    const [selectedFile, setSelectedFile] = useState(null)
    const [remoteSource, setRemoteSource] = useState(null) // { url, name }
    const [status, setStatus] = useState('Waiting for file upload')
    const [error, setError] = useState('')
    // A multiplier on the loaded framing, not the camera's z position — 1x is
    // where the scene opens, and the number grows as you get closer.
    const [zoom, setZoom] = useState(1)
    const [mapOpen, setMapOpen] = useState(true)
    const routeSplatName = location.state?.name ?? getFileName(location.state?.modelPath)
    const selectedSplatName = selectedFile?.name ?? remoteSource?.name ?? routeSplatName
    const viewerTitle = selectedSplatName ?? 'No splat loaded'

    useEffect(() => {
      document.title = 'Visualizer'
    }, [])

    // Pick up a model path passed via navigation state (e.g. from Home)
    const API_URL = import.meta.env.VITE_API_URL

  useEffect(() => {
    const modelPath = location.state?.modelPath

    if (!modelPath) {
      return undefined
    }

    let active = true

    const fetchSplatUrl = async () => {
      setError('')
      setStatus('Loading...')

      try {
        const res = await fetch(`${API_URL}/splat-url?path=${encodeURIComponent(modelPath)}`)

        if (!res.ok) {
          throw new Error(`Unable to fetch splat URL (${res.status})`)
        }

        const data = await res.json()

        if (!active) {
          return
        }

        setRemoteSource({ url: data.url, name: data.filename })
      } catch (fetchError) {
        if (!active) {
          return
        }

        const message = fetchError instanceof Error ? fetchError.message : 'Unable to load that file.'
        console.error('[SplatViewer] load error:', message)
        setError(message)
        setStatus('Upload a file')
      }
    }

    fetchSplatUrl()

    return () => {
      active = false
    }
  }, [location.state])

    useEffect(() => {
      const stage = stageRef.current

      if (!stage) {
        return undefined
      }

      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x07111f)

      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
      camera.position.copy(CAMERA_START)
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

      const keys = keysRef.current

      const handleKeyDown = (event) => {
        // Let browser/OS shortcuts through untouched.
        if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) {
          return
        }

        if (MOVE_KEYS.has(event.code)) {
          keys.add(event.code)
          event.preventDefault()
        } else if (SPRINT_KEYS.has(event.code)) {
          keys.add(event.code)
        }
      }

      const handleKeyUp = (event) => {
        keys.delete(event.code)
      }

      // Alt-tabbing away mid-stride never delivers the keyup, so the camera
      // would drift forever. Drop everything held when focus leaves.
      const handleBlur = () => keys.clear()

      // Reused every frame — allocating vectors in the render loop is how you
      // hand the GC a job 60 times a second.
      const forward = new THREE.Vector3()
      const right = new THREE.Vector3()
      const move = new THREE.Vector3()

      const publishZoom = () => {
        // Floored: flying through the splat would otherwise divide by ~0.
        const distance = Math.max(camera.position.distanceTo(SPLAT_POSITION), 1e-3)
        const next = INITIAL_DISTANCE / distance
        // Same rounding the label uses: bail out unless the display would
        // actually change, otherwise flying re-renders React on every frame.
        setZoom((current) => (Math.abs(current - next) < 0.05 ? current : next))
      }

      const applyMovement = (delta) => {
        if (keys.size === 0) {
          return
        }

        camera.getWorldDirection(forward)
        right.crossVectors(forward, camera.up).normalize()
        move.set(0, 0, 0)

        if (keys.has('KeyW')) move.add(forward)
        if (keys.has('KeyS')) move.sub(forward)
        if (keys.has('KeyD')) move.add(right)
        if (keys.has('KeyA')) move.sub(right)
        if (keys.has('KeyE')) move.y += 1
        if (keys.has('KeyQ')) move.y -= 1

        if (move.lengthSq() === 0) {
          return
        }

        const sprinting = keys.has('ShiftLeft') || keys.has('ShiftRight')
        camera.position.addScaledVector(
          move.normalize(),
          MOVE_SPEED * (sprinting ? SPRINT_MULTIPLIER : 1) * delta,
        )
        publishZoom()
      }

      resizeRenderer()

      const resizeObserver = new ResizeObserver(resizeRenderer)
      resizeObserver.observe(stage)

      renderer.domElement.addEventListener('pointerdown', handlePointerDown)
      renderer.domElement.addEventListener('pointermove', handlePointerMove)
      renderer.domElement.addEventListener('pointerup', handlePointerUp)
      renderer.domElement.addEventListener('pointercancel', handlePointerUp)
      window.addEventListener('keydown', handleKeyDown)
      window.addEventListener('keyup', handleKeyUp)
      window.addEventListener('blur', handleBlur)

      const clock = new THREE.Clock()

      const render = () => {
        // Clamped so a backgrounded tab doesn't resume with one giant step.
        applyMovement(Math.min(clock.getDelta(), 0.1))
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
        window.removeEventListener('keydown', handleKeyDown)
        window.removeEventListener('keyup', handleKeyUp)
        window.removeEventListener('blur', handleBlur)
        keys.clear()

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

      // Local file takes precedence if both are somehow set
      const source = selectedFile
        ? { kind: 'file', file: selectedFile }
        : remoteSource
          ? { kind: 'url', url: remoteSource.url, name: remoteSource.name }
          : null

      if (!source || !scene || !renderer) {
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

        const fileName = source.kind === 'file' ? source.file.name : source.name
        const extension = getFileExtension(fileName)

        if (extension !== 'ply' && extension !== 'splat') {
          if (!active) {
            return
          }

          setError('Please choose a .ply or .splat file.')
          setStatus('Upload a file')
          return
        }

        try {
          let bytes

          if (source.kind === 'file') {
            const arrayBuffer = await source.file.arrayBuffer()
            bytes = new Uint8Array(arrayBuffer)
          } else {
            const response = await fetch(source.url, { cache: "no-store" })

            if (!response.ok) {
              throw new Error(`Unable to fetch ${fileName} (${response.status})`)
            }

            const arrayBuffer = await response.arrayBuffer()
            bytes = new Uint8Array(arrayBuffer)
          }

          const fileType = extension === 'ply' ? 'ply' : 'splat'

          const splat = new SplatMesh({
            fileBytes: bytes,
            fileType,
            fileName,
            onProgress: (event) => {
              if (!active) {
                return
              }

              setStatus(`Loading ${fileName} (${Math.round((event.loaded / Math.max(event.total, 1)) * 100)}%)`)
            },
          })

          await splat.initialized

          if (!active) {
            splat.dispose()
            return
          }

          splat.position.set(0, -0.08, -1.3)
          splat.scale.setScalar(0.9)
          splat.rotation.set(Math.PI, 0.25, 0)
          scene.add(splat)
          splatRef.current = splat
          setStatus('Rendered')
        } catch (loadError) {
          if (!active) {
            return
          }

          const message = loadError instanceof Error ? loadError.message : 'Unable to load that file.'
          setError(message)
          setStatus('Upload a file')
        }
      }

      loadSplat()

      return () => {
        active = false
        disposeCurrentSplat()
      }
    }, [selectedFile, remoteSource])

    const handleFileChange = (event) => {
      const file = event.target.files?.[0]

      if (!file) {
        return
      }

      setRemoteSource(null) // clear any route-provided source
      setSelectedFile(file)
    }

    // Dolly along the camera-to-splat line. Positive `steps` moves closer.
    // Multiplicative rather than additive so a notch covers the same visual
    // ground whether you are 20 units out or half a unit in — the old additive
    // 0.2 crawled when far away and jumped when close.
    const dolly = (steps) => {
      const camera = cameraRef.current

      if (!camera) {
        return
      }

      const offset = new THREE.Vector3().subVectors(camera.position, SPLAT_POSITION)
      const distance = offset.length()

      // WASD can park the camera dead on the splat, leaving no direction to
      // dolly along. Back out the way we're facing instead.
      if (distance < 1e-4) {
        camera.getWorldDirection(offset).negate()
      }

      const nextDistance = clamp(distance / ZOOM_STEP ** steps, MIN_DISTANCE, MAX_DISTANCE)

      camera.position.copy(SPLAT_POSITION).add(offset.setLength(nextDistance))
      setZoom(INITIAL_DISTANCE / nextDistance)
    }

    const handleScroll = (event) => {
      event.preventDefault()
      dolly(event.deltaY > 0 ? -1 : 1)
    }

    return (
      <section className="gv-viewer">
        <div className="gv-viewer-toolbar">
          <div className="gv-viewer-title-block">
            <div className="card-kicker">Visualizer</div>
            <div className="gv-viewer-title">{viewerTitle}</div>
          </div>

          <label className="btn btn-secondary gv-upload-btn">
            <IconUpload />
            Upload .ply / .splat
            <input type="file" accept=".ply,.splat" onChange={handleFileChange} />
          </label>

          <div className="gv-zoom-group" aria-label="Zoom controls">
            <button type="button" className="gv-tool gv-tool--sm" onClick={() => dolly(-BUTTON_STEPS)} aria-label="Zoom out">
              <IconMinus />
            </button>
            <span className="gv-zoom-value">{zoom.toFixed(1)}x</span>
            <button type="button" className="gv-tool gv-tool--sm" onClick={() => dolly(BUTTON_STEPS)} aria-label="Zoom in">
              <IconPlus />
            </button>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            style={{ borderColor: mapOpen ? 'var(--color-accent)' : 'var(--color-divider)' }}
            onClick={() => setMapOpen((open) => !open)}
          >
            <IconMap />
            {mapOpen ? 'Hide map' : 'Show map'}
          </button>

          <div className="gv-status-group">
            <span className="text-muted gv-status-label">Status</span>
            <span className="tag tag-accent">{status}</span>
          </div>
        </div>

        <div
          className="gv-stage-grid"
          style={{ gridTemplateColumns: mapOpen ? 'minmax(0,1fr) 320px' : 'minmax(0,1fr)' }}
        >
          <div className="gv-stage-panel" aria-label="Spark splat preview" onWheel={handleScroll}>
            <div className="gv-stage" ref={stageRef} />
            {error ? <div className="gv-stage-alert">{error}</div> : null}
            <div className="gv-stage-hint">
              <span className="gv-stage-hint-dot" />
              Drag to orbit · scroll to zoom · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to move
              · <kbd>E</kbd>/<kbd>Q</kbd> up and down · <kbd>Shift</kbd> to sprint
            </div>
          </div>

          {mapOpen ? (
            <div className="gv-map-panel">
              <div className="gv-map-panel-head">
                <span className="gv-map-panel-title">Location · map.osm</span>
                <button type="button" className="gv-tool gv-tool--sm" onClick={() => setMapOpen(false)} aria-label="Hide map">
                  <IconClose />
                </button>
              </div>
              <div className="gv-map-panel-body">
                <OSMViewer className="gv-map-canvas" />
              </div>
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  export default SplatViewer