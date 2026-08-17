import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import * as THREE from 'three'
import { NO_DATA_COLOUR, VOLUME_CLASS_LABELS, VOLUME_RAMP_DARK_BG } from '../gis/gisGeo.js'
import { heightSourceOf, outerRings, volumeBreaks, volumeClass, volumeOf } from '../gis/buildings.js'
import { fillHeightsFromGeotiff } from '../gis/geotiffHeights.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import SplatMap from './SplatMap.jsx'
import { getFileExtension, getFileName } from '../utils.jsx'
import { IconClose, IconDownload, IconMap, IconMinus, IconPlus, IconUpload } from './icons.jsx'

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

// Free-fly movement. WASD walks the ground plane in the direction you are
// facing, E/Q lift and drop along world Y (not camera Y, so looking down and
// pressing E still takes you straight up).
const MOVE_SPEED = 2.2 // world units per second
const SPRINT_MULTIPLIER = 3
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ'])
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight'])

// Mouse look. Yaw is unbounded; pitch stops just short of straight up/down so
// the view can never flip past vertical and invert the controls.
const LOOK_SENSITIVITY = 0.0022 // radians per pixel
const MAX_PITCH = Math.PI / 2 - 0.01
// A press that travels less than this is a click (engage pointer lock), more is
// a drag (look around). Without it, every drag would also grab the pointer.
const CLICK_SLOP_PX = 4

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

// How the splat is oriented when it loads. Degrees rather than radians because
// that is what the sliders show; nerfstudio exports Y-down, hence the 180° roll
// about X that used to be hardcoded as `rotation.set(Math.PI, 0.25, 0)`.
const DEFAULT_ROTATION = { x: 180, y: 14.3, z: 0 }
const ROTATION_AXES = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'z', label: 'Z' },
]
const toRadians = (degrees) => (degrees * Math.PI) / 180

// The mesh sits beside the splat in R2 under the same name: models/<job>/x.ply
// becomes models/<job>/x.glb. Nothing records it, so it is derived rather than
// looked up — which is also why a missing .glb is a normal outcome, not a bug.
const meshPathFor = (modelPath) => {
  if (!modelPath) return null
  return /\.[^./]+$/.test(modelPath)
    ? modelPath.replace(/\.[^./]+$/, '.glb')
    : `${modelPath}.glb`
}

/**
 * Undo the glTF default material on a loaded mesh.
 *
 * GS2Mesh's TSDF stage produces a vertex-coloured PLY, and the worker exports
 * it with trimesh — which, for a mesh whose colour lives in COLOR_0, writes a
 * primitive with no `material` at all. A primitive without one takes the glTF
 * *default* material, and that default is `metallicFactor: 1`: a fully metallic
 * surface, which by definition has no diffuse response and shows only what it
 * reflects. This scene has no environment map, so there was nothing to reflect
 * but the lamps, and the mesh rendered as a dark tinted shell instead of the
 * photographed colour it carries. Other viewers do not show this because they
 * ship a default studio IBL for a metal to reflect; we do not, and adding one
 * to light a mesh whose colour is already baked would be the wrong fix.
 *
 * SuGaR's meshes land in the same place by a different route: they go out as
 * .obj/.mtl, so they do carry a material, but an .mtl cannot express metalness
 * and the converted material omits the factor — which glTF resolves to the same
 * 1.0. Both workers now write it explicitly, so this is belt-and-braces for
 * meshes produced before that; it is cheap and it costs nothing to keep.
 *
 * Force the one thing these files failed to say: this is a diffuse surface.
 * Roughness is left alone — that one they do get right.
 */
const relightAsDiffuse = (root) => {
  root.traverse((child) => {
    const material = child.material
    if (!material) return
    const materials = Array.isArray(material) ? material : [material]
    materials.forEach((entry) => {
      if (!('metalness' in entry)) return // not a PBR material; nothing to undo
      entry.metalness = 0
      entry.needsUpdate = true
    })
  })
}

// ---------------------------------------------------------------------------
// Buildings (Phase 4a)
//
// Measured footprints, extruded into a metrically correct mesh: the scene
// is a local ENU frame where 1 three.js unit = 1 metre, east is +X, north is
// -Z and up is +Y. Distances in here are real, so the FPS camera's 2.2 units/s
// is a walking pace and a 12 m building is 12 units tall.
//
// The splat is NOT in this frame. COLMAP output has arbitrary scale and
// orientation, so until a georeferenced splat carries the Sim3 that Phase 4b
// solves, the two are simply different spaces that happen to share an origin.
// ---------------------------------------------------------------------------
const apiBaseUrl = import.meta.env.VITE_API_URL ?? '/api'

const METRES_PER_DEGREE_LAT = 111320

// The dark-surface variant, not the map's: against this stage (#07111f) the
// light ramp's darkest step measures 1.58:1 and simply disappears. Both ramps
// index the same class list, so a building keeps its class across views.
const BUILDING_COLOURS = VOLUME_RAMP_DARK_BG

// Footprints no elevation source usably covered — neither the LiDAR the
// backend measured against nor a GeoTIFF surface sampled in the browser — have
// no height to extrude. They are still drawn, as a thin slab, so "we have this
// building but not its height" is visible rather than silently absent.
const UNMEASURED_HEIGHT_M = 0.4

/**
 * Build the building scene: one merged mesh per volume class, plus the flat
 * patches for any area the user drew that nothing ever measured.
 *
 * Returns { group, origin, radius, measured, total, drawn } or null.
 *
 * `origin` is the lon/lat the frame is anchored at. Every vertex is metres from
 * it, which keeps coordinates small enough for float32 to stay precise — raw
 * WGS84 scaled to metres would be ~5e6 and visibly jitter. It is *returned*
 * rather than discarded so a second source can be placed in the same frame and
 * so the group stays georeferenced in principle.
 */
const buildBuildingMesh = (features, drawnFeatures = []) => {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  // Both collections feed the bbox, so one origin serves both and the drawn
  // areas land in the right place relative to the measured buildings.
  for (const feature of [...features, ...drawnFeatures]) {
    for (const ring of outerRings(feature.geometry)) {
      for (const [lon, lat] of ring) {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
      }
    }
  }
  if (!Number.isFinite(minLon)) return null

  const originLon = (minLon + maxLon) / 2
  const originLat = (minLat + maxLat) / 2
  const metresPerLon = METRES_PER_DEGREE_LAT * Math.cos((originLat * Math.PI) / 180)

  // Drawn areas are deliberately absent here: they carry no volume, and feeding
  // them in would invite someone to "fix" the nulls with a zero and skew the
  // quartiles that every building's colour depends on.
  const breaks = volumeBreaks(features.map((f) => volumeOf(f.properties)))
  const byClass = BUILDING_COLOURS.map(() => [])
  const unmeasured = []
  let measured = 0
  let fromGeotiff = 0

  for (const feature of features) {
    const properties = feature.properties ?? {}
    const height = properties.height_m
    const hasHeight = height !== null && height !== undefined && height > 0
    if (hasHeight) {
      measured += 1
      // Counted, not coloured differently: the extrusion is the same claim
      // either way, and a second no-data hue would say the GeoTIFF ones are
      // less real than they are. The caption carries the split instead.
      if (heightSourceOf(properties) === 'geotiff') fromGeotiff += 1
    }

    for (const ring of outerRings(feature.geometry)) {
      if (ring.length < 4) continue

      const shape = new THREE.Shape()
      ring.forEach(([lon, lat], index) => {
        const east = (lon - originLon) * metresPerLon
        const north = (lat - originLat) * METRES_PER_DEGREE_LAT
        if (index === 0) shape.moveTo(east, north)
        else shape.lineTo(east, north)
      })

      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: hasHeight ? height : UNMEASURED_HEIGHT_M,
        bevelEnabled: false,
      })
      // ExtrudeGeometry pushes along +Z with the shape in XY. Rotating -90°
      // about X turns that into "footprint on the ground, height along +Y",
      // and maps the shape's north axis onto -Z — the ENU convention.
      geometry.rotateX(-Math.PI / 2)

      // volumeClass returns null when the volume is unknown. A building can
      // have a measured height but no volume, and that is not "smallest class"
      // — it joins the uncovered ones rather than skewing the bottom bucket.
      const klass = hasHeight ? volumeClass(volumeOf(properties), breaks) : null
      if (klass !== null) byClass[klass].push(geometry)
      else unmeasured.push(geometry)
    }
  }

  const group = new THREE.Group()
  const addBatch = (geometries, colour, opacity) => {
    if (geometries.length === 0) return
    // One draw call per class. Merging also disposes the need to keep
    // thousands of Mesh objects alive for the renderer to walk every frame.
    const merged = mergeGeometries(geometries, false)
    geometries.forEach((geometry) => geometry.dispose())
    if (!merged) return
    merged.computeVertexNormals()
    group.add(new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
      color: new THREE.Color(colour),
      roughness: 0.85,
      metalness: 0.0,
      transparent: opacity < 1,
      opacity,
    })))
  }

  byClass.forEach((geometries, index) => addBatch(geometries, BUILDING_COLOURS[index], 1))
  addBatch(unmeasured, NO_DATA_COLOUR, 0.55)

  // ---- areas the user drew --------------------------------------------------
  //
  // Extruded where a surface measured them, flat where nothing did. This used
  // to be unconditionally flat, on the reasoning that the ask was to mark the
  // surface rather than guess a height — but a measured outline is not a guess,
  // and a splat whose subject is a monument, a yard or a stretch of street was
  // left with no volume at all however much elevation data had been uploaded.
  // The flat patch is still what an unmeasured outline gets, for exactly the
  // original reason.
  const patches = []
  const solids = []
  let drawn = 0
  let drawnMeasured = 0

  for (const feature of drawnFeatures) {
    const height = feature.properties?.height_m
    const hasHeight = typeof height === 'number' && height > 0

    for (const ring of outerRings(feature.geometry)) {
      if (ring.length < 4) continue

      const shape = new THREE.Shape()
      ring.forEach(([lon, lat], index) => {
        const east = (lon - originLon) * metresPerLon
        const north = (lat - originLat) * METRES_PER_DEGREE_LAT
        if (index === 0) shape.moveTo(east, north)
        else shape.lineTo(east, north)
      })

      if (hasHeight) {
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
        geometry.rotateX(-Math.PI / 2)
        solids.push(geometry)
        drawnMeasured += 1
      } else {
        const geometry = new THREE.ShapeGeometry(shape)
        geometry.rotateX(-Math.PI / 2)
        // 2 cm off the ground so it does not z-fight with the base faces of any
        // extrusion sitting on the same spot.
        geometry.translate(0, 0.02, 0)
        patches.push(geometry)
      }

      drawn += 1
    }
  }

  /** Translucent volume plus a full-opacity wireframe, merged into two draws. */
  const addDrawnBatch = (geometries, opacity, doubleSided) => {
    if (geometries.length === 0) return
    const merged = mergeGeometries(geometries, false)
    geometries.forEach((geometry) => geometry.dispose())
    if (!merged) return

    // MeshBasic, not Standard: a drawn area is an annotation, not a surface
    // with relief, and shading it would make it read as measured geometry.
    group.add(new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
      color: new THREE.Color(BUILDING_COLOURS[0]),
      transparent: true,
      opacity,
      side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      // Never occludes the splat it encloses — the whole point is to look
      // through it at what was captured inside.
      depthWrite: false,
    })))
    // The outline at full opacity is what keeps it legible at grazing angles
    // on a dark stage; the translucent fill alone disappears.
    group.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(merged),
      new THREE.LineBasicMaterial({ color: new THREE.Color(BUILDING_COLOURS[0]) }),
    ))
  }

  addDrawnBatch(patches, 0.28, true)
  // Fainter than the flat patch: a box has four faces between the eye and the
  // splat inside it, and at 0.28 each they stack into an opaque block.
  addDrawnBatch(solids, 0.14, false)

  const halfWidth = ((maxLon - minLon) * metresPerLon) / 2
  const halfDepth = ((maxLat - minLat) * METRES_PER_DEGREE_LAT) / 2
  return {
    group,
    origin: { lon: originLon, lat: originLat },
    radius: Math.max(Math.hypot(halfWidth, halfDepth), 10),
    measured,
    fromGeotiff,
    total: features.length,
    drawn,
    drawnMeasured,
  }
}

// A drawn area larger than this is almost certainly an imported administrative
// boundary rather than something someone traced around a building. One county
// would push `radius` to ~50 km and park the camera in orbit.
const MAX_DRAWN_SPAN_M = 5000

/** Skip a footprint whose bbox diagonal is implausibly large. */
const withinSizeCap = (feature) => {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const ring of outerRings(feature.geometry)) {
    for (const [lon, lat] of ring) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    }
  }
  if (!Number.isFinite(minLon)) return false
  const midLat = (minLat + maxLat) / 2
  const width = (maxLon - minLon) * METRES_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180)
  const depth = (maxLat - minLat) * METRES_PER_DEGREE_LAT
  return Math.hypot(width, depth) <= MAX_DRAWN_SPAN_M
}

// Don't steal keystrokes from a form control the user is actually typing in.
const isTypingTarget = (target) =>
  Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'))

  function SplatViewer() {
    const location = useLocation()
    // Already fetched app-wide, so the drawn outline costs no extra request.
    const { allNodes, allRegions } = useSplatLibrary()
    const stageRef = useRef(null)
    const sceneRef = useRef(null)
    const rendererRef = useRef(null)
    const sparkRef = useRef(null)
    const splatRef = useRef(null)
    const frameRef = useRef(0)
    const dragStateRef = useRef({ isDragging: false, lastX: 0, lastY: 0, travel: 0 })
    const cameraRef = useRef(null)
    const keysRef = useRef(new Set())
    // Camera orientation is tracked here rather than read back off the matrix:
    // accumulating into Euler angles is what keeps pitch clampable and roll at
    // exactly zero.
    const lookRef = useRef({ yaw: 0, pitch: 0 })
    const buildingsRef = useRef(null)
    const meshRef = useRef(null)
    const [pointerLocked, setPointerLocked] = useState(false)
    // 'splat' | 'mesh'. Kept in a ref too: the splat can finish loading after a
    // switch, and it needs to know whether to show itself.
    const [viewMode, setViewMode] = useState('splat')
    const viewModeRef = useRef('splat')
    const [meshReady, setMeshReady] = useState(false)
    const [meshError, setMeshError] = useState('')
    const [buildingsOn, setBuildingsOn] = useState(false)
    const [buildingsInfo, setBuildingsInfo] = useState(null) // { measured, total } | 'empty' | error
    const [downloading, setDownloading] = useState(false)
    const [downloadError, setDownloadError] = useState('')
    const [selectedFile, setSelectedFile] = useState(null)
    const [remoteSource, setRemoteSource] = useState(null) // { url, name }
    const [status, setStatus] = useState('Waiting for file upload')
    const [error, setError] = useState('')
    // A multiplier on the loaded framing, not the camera's z position — 1x is
    // where the scene opens, and the number grows as you get closer.
    const [zoom, setZoom] = useState(1)
    const [mapOpen, setMapOpen] = useState(true)
    const [rotateOpen, setRotateOpen] = useState(false)
    const rotateOpenRef = useRef(false)
    const [rotation, setRotation] = useState(DEFAULT_ROTATION)
    // Mirrored so the splat, which finishes loading asynchronously, can adopt
    // the current angles instead of the ones captured when the effect ran.
    const rotationRef = useRef(DEFAULT_ROTATION)

    const setRotateMenuOpen = (nextOpen) => {
      rotateOpenRef.current = nextOpen
      setRotateOpen(nextOpen)
    }

    const toggleRotateMenu = () => {
      const nextOpen = !rotateOpenRef.current
      setRotateMenuOpen(nextOpen)
    }

    useEffect(() => {
      rotateOpenRef.current = rotateOpen
    }, [rotateOpen])
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
      // A download failure holds the top alert slot; left alone it would sit
      // over the next model's status. Cleared wherever the target changes.
      setDownloadError('')
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

      // Far plane in metres, because the building mesh is metric: a city block
      // is hundreds of units across and the framing camera sits hundreds back,
      // so the old 100 clipped the entire scene away.
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000)
      // YXZ = yaw about world Y, then pitch about the camera's own X. The
      // default XYZ order would let roll creep in as soon as both are non-zero.
      camera.rotation.order = 'YXZ'
      camera.position.copy(CAMERA_START)
      camera.lookAt(0, 0, 0)
      cameraRef.current = camera

      // Seed the look angles from that initial lookAt, so the first mouse
      // movement continues from where the scene opens instead of snapping.
      const look = lookRef.current
      look.yaw = camera.rotation.y
      look.pitch = camera.rotation.x

      const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setClearColor(0x000000, 0)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      stage.appendChild(renderer.domElement)

      const spark = new SparkRenderer({ renderer })
      scene.add(spark)

      // Every light in here is white on purpose. There used to be an orange
      // `PointLight(0xff8f42, 18, 14)` sitting a couple of units off the origin
      // as a rim accent, from when the stage held nothing but a splat — and
      // splats are unlit, so it was decoration that lit nothing. A
      // reconstructed mesh *does* take lights, at exactly that scale, and it
      // arrived carrying colour photographed under the real scene's lighting.
      // A coloured lamp on top of that is a second lighting pass the capture
      // never had: it is what made meshes here look brown when the same file
      // opens neutral everywhere else.
      const ambientLight = new THREE.AmbientLight(0xffffff, 1.25)
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.6)
      keyLight.position.set(2.5, 2.5, 4)

      scene.add(ambientLight, keyLight)

      const resizeRenderer = () => {
        const { clientWidth, clientHeight } = stage
        camera.aspect = clientWidth / clientHeight
        camera.updateProjectionMatrix()
        renderer.setSize(clientWidth, clientHeight, false)
      }

      // Mouse look. Moving right turns right, moving down looks down — hence the
      // subtraction on both axes.
      const applyLook = (deltaX, deltaY) => {
        look.yaw -= deltaX * LOOK_SENSITIVITY
        look.pitch = clamp(look.pitch - deltaY * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH)
        camera.rotation.set(look.pitch, look.yaw, 0)
      }

      const handlePointerDown = (event) => {
        if (event.button !== 0) {
          return
        }

        const dragState = dragStateRef.current
        dragState.isDragging = true
        dragState.lastX = event.clientX
        dragState.lastY = event.clientY
        dragState.travel = 0
        renderer.domElement.setPointerCapture?.(event.pointerId)
        event.preventDefault()
      }

      const handlePointerMove = (event) => {
        // While the pointer is locked the browser reports movement directly and
        // there is no drag to track — mousemove drives the look instead.
        if (document.pointerLockElement === renderer.domElement) {
          return
        }

        const dragState = dragStateRef.current
        if (!dragState.isDragging) {
          return
        }

        const deltaX = event.clientX - dragState.lastX
        const deltaY = event.clientY - dragState.lastY

        dragState.lastX = event.clientX
        dragState.lastY = event.clientY
        dragState.travel += Math.abs(deltaX) + Math.abs(deltaY)

        if (deltaX !== 0 || deltaY !== 0) {
          applyLook(deltaX, deltaY)
        }
      }

      const handlePointerUp = (event) => {
        if (!dragStateRef.current.isDragging) {
          return
        }

        dragStateRef.current.isDragging = false
        renderer.domElement.releasePointerCapture?.(event.pointerId)
      }

      // A genuine click (not the tail of a drag) grabs the pointer for
      // continuous FPS look; Esc hands it back, which the browser handles.
      const handleClick = () => {
        if (dragStateRef.current.travel <= CLICK_SLOP_PX) {
          renderer.domElement.requestPointerLock?.()
        }
      }

      const handleLockedMouseMove = (event) => {
        if (document.pointerLockElement === renderer.domElement) {
          applyLook(event.movementX, event.movementY)
        }
      }

      const handleLockChange = () => {
        setPointerLocked(document.pointerLockElement === renderer.domElement)
      }

      const keys = keysRef.current

      const handleKeyDown = (event) => {
        // Let browser/OS shortcuts through untouched.
        if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) {
          return
        }

        if (event.code === 'Escape') {
          if (rotateOpenRef.current) {
            setRotateMenuOpen(false)
            event.preventDefault()
          }
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

        // Forward comes from yaw alone, deliberately ignoring pitch: in an FPS
        // camera, looking at your feet and pressing W walks you along the
        // ground rather than burying you in it. E/Q own the vertical axis.
        forward.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw))
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
      renderer.domElement.addEventListener('click', handleClick)
      document.addEventListener('mousemove', handleLockedMouseMove)
      document.addEventListener('pointerlockchange', handleLockChange)
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
        renderer.domElement.removeEventListener('click', handleClick)
        document.removeEventListener('mousemove', handleLockedMouseMove)
        document.removeEventListener('pointerlockchange', handleLockChange)
        window.removeEventListener('keydown', handleKeyDown)
        window.removeEventListener('keyup', handleKeyUp)
        window.removeEventListener('blur', handleBlur)
        keys.clear()

        // Leaving the page while locked would otherwise strand the cursor.
        if (document.pointerLockElement === renderer.domElement) {
          document.exitPointerLock?.()
        }

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
          const angles = rotationRef.current
          splat.rotation.set(toRadians(angles.x), toRadians(angles.y), toRadians(angles.z))
          // The splat can finish loading after the user has already switched to
          // the mesh; without this it would pop back on top of it.
          splat.visible = viewModeRef.current === 'splat'
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

    /**
     * Point the camera at an object's bounding box.
     *
     * Framing is all this does. It used to double as the mesh's only
     * orientation handling, on the reasoning that a .glb "is usually already
     * Y-up" and would land upside down if given the splat's `rotation.x = PI` —
     * but these two files are not independent exports that happen to sit side
     * by side. Both are reconstructions of the same capture in the same COLMAP
     * frame, where +Y points down, which is the whole reason the splat needs
     * that 180° roll. The mesh needs it for identical reasons, and skipping it
     * is what put meshes on screen upside down. Orientation now comes from the
     * shared `rotation` state for both; see the effect that applies it.
     */
    const frameObject = (object) => {
      const camera = cameraRef.current
      if (!camera || !object) return

      const box = new THREE.Box3().setFromObject(object)
      if (box.isEmpty()) return

      const size = box.getSize(new THREE.Vector3())
      const centre = box.getCenter(new THREE.Vector3())
      const radius = Math.max(size.length() / 2, 0.5)
      const distance = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.3

      camera.position.set(centre.x, centre.y + radius * 0.35, centre.z + distance)

      const dx = centre.x - camera.position.x
      const dy = centre.y - camera.position.y
      const dz = centre.z - camera.position.z
      const look = lookRef.current
      look.yaw = Math.atan2(-dx, -dz)
      look.pitch = Math.atan2(dy, Math.hypot(dx, dz))
      camera.rotation.set(look.pitch, look.yaw, 0)

      setZoom(INITIAL_DISTANCE / Math.max(camera.position.distanceTo(SPLAT_POSITION), 1e-3))
    }

    // Back off far enough to see the whole extent, looking slightly down. At 1
    // unit = 1 metre the default camera sits 4.5 m from the origin, which is
    // usually *inside* a building — without this the feature looks broken.
    const frameBuildings = () => {
      const camera = cameraRef.current
      const built = buildingsRef.current
      if (!camera || !built) return

      const distance = built.radius * 1.9
      camera.position.set(0, Math.max(built.radius * 0.7, 25), distance)
      lookRef.current.yaw = 0
      lookRef.current.pitch = -Math.atan2(camera.position.y, distance)
      camera.rotation.set(lookRef.current.pitch, lookRef.current.yaw, 0)
      setZoom(INITIAL_DISTANCE / camera.position.distanceTo(SPLAT_POSITION))
    }

    const modelPath = location.state?.modelPath ?? null
    const meshPath = meshPathFor(modelPath)
    // A failed mesh keeps the splat on screen rather than leaving a black stage.
    const meshActive = viewMode === 'mesh' && !meshError
    const meshLoading = viewMode === 'mesh' && !meshReady && !meshError
    const meshAlert = viewMode !== 'mesh'
      ? null
      : meshError || (meshLoading ? `Loading ${getFileName(meshPath)}…` : null)

    // What the download button hands over: whatever is on screen right now. A
    // mesh that is still loading — or that failed — is not on screen; the splat
    // still is, and that is what the click should save. `meshReady` rather than
    // `viewMode` is therefore the test, so the button never quietly serves a
    // file other than the one being looked at.
    const showingMesh = meshActive && meshReady
    const downloadTarget = showingMesh
      ? { kind: 'remote', path: meshPath, name: getFileName(meshPath) }
      // A local upload takes precedence over the route's splat in the scene, so
      // it has to take precedence here too. It costs nothing to serve: the file
      // is already in the browser.
      : selectedFile
        ? { kind: 'local', file: selectedFile, name: selectedFile.name }
        : modelPath
          ? { kind: 'remote', path: modelPath, name: getFileName(modelPath) }
          : null

    // Mirrored into a ref in an effect, not during render: the splat load
    // resolves asynchronously and would otherwise read a stale closure.
    useEffect(() => {
      viewModeRef.current = viewMode
    }, [viewMode])

    // Drive both objects from one set of angles: the mesh is an alternative
    // rendering of the same scene, so it should sit the same way up.
    useEffect(() => {
      rotationRef.current = rotation
      const euler = [toRadians(rotation.x), toRadians(rotation.y), toRadians(rotation.z)]
      splatRef.current?.rotation.set(...euler)
      meshRef.current?.rotation.set(...euler)
    }, [rotation])

    // Load the .glb on the first switch, then just flip visibility — refetching
    // and re-parsing a mesh on every toggle would stall the render loop.
    useEffect(() => {
      const splat = splatRef.current
      const mesh = meshRef.current
      const wantMesh = viewMode === 'mesh'

      if (!wantMesh || !meshPath) {
        if (mesh) mesh.visible = false
        if (splat) splat.visible = true
        return undefined
      }

      if (mesh) {
        mesh.visible = true
        if (splat) splat.visible = false
        frameObject(mesh)
        return undefined
      }

      let active = true
      const loader = new GLTFLoader()

      fetch(`${API_URL}/splat-url?path=${encodeURIComponent(meshPath)}`)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Could not sign the mesh URL (${response.status})`)
          }
          return response.json()
        })
        .then((data) => loader.loadAsync(data.url))
        .then((gltf) => {
          const scene = sceneRef.current
          if (!active || !scene) return

          // Both before frameObject: the rotation because a Box3 is computed
          // in world space and framing the unrotated pose would aim the camera
          // at where the mesh used to be, the materials because a mesh added to
          // the scene is one frame away from being drawn.
          const angles = rotationRef.current
          gltf.scene.rotation.set(
            toRadians(angles.x), toRadians(angles.y), toRadians(angles.z),
          )
          relightAsDiffuse(gltf.scene)

          scene.add(gltf.scene)
          meshRef.current = gltf.scene
          if (splatRef.current) splatRef.current.visible = false
          setMeshReady(true)
          frameObject(gltf.scene)
        })
        .catch(() => {
          if (!active) return
          // /splat-url signs blindly, so a missing object only shows up as a
          // 404 when the signed URL is actually fetched.
          setMeshError(`No mesh found for this splat (${getFileName(meshPath)}).`)
        })

      return () => {
        active = false
      }
    }, [viewMode, meshPath, API_URL])

    // GPU resources are not garbage collected — release them explicitly.
    useEffect(() => () => {
      const mesh = meshRef.current
      if (!mesh) return
      mesh.traverse((child) => {
        child.geometry?.dispose()
        const material = child.material
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
        else material?.dispose()
      })
      sceneRef.current?.remove(mesh)
      meshRef.current = null
    }, [])

    // The outline of the splat currently open, if its target has one. No new
    // endpoint: the library context already holds every node and region, so the
    // target is found by matching model_path against the path we were navigated
    // with.
    const drawnFeatures = useMemo(() => {
      const modelPath = location.state?.modelPath
      if (!modelPath) return []

      const node = (allNodes ?? []).find(
        (entry) => entry.model_path === modelPath && entry.footprint,
      )
      if (node) {
        return [{ geometry: node.footprint }].filter(withinSizeCap)
      }

      const region = (allRegions ?? []).find(
        // source === 'drawn' keeps imported administrative boundaries out: one
        // county would blow the scene radius out to tens of kilometres and put
        // the camera in orbit, which reads as a broken feature.
        (entry) => entry.model_path === modelPath && entry.geom && entry.source === 'drawn',
      )
      return region ? [{ geometry: region.geom }].filter(withinSizeCap) : []
    }, [allNodes, allRegions, location.state])

    // Read inside the fetch callback, which would otherwise close over the
    // value from the render that started the request.
    const drawnFeaturesRef = useRef(drawnFeatures)
    useEffect(() => {
      drawnFeaturesRef.current = drawnFeatures
    }, [drawnFeatures])

    // Fetch and build the mesh the first time buildings are switched on, then
    // just toggle its visibility — re-extruding a city on every click would
    // stall the render loop for seconds.
    useEffect(() => {
      if (!buildingsOn) {
        if (buildingsRef.current) buildingsRef.current.group.visible = false
        return undefined
      }
      if (buildingsRef.current) {
        buildingsRef.current.group.visible = true
        frameBuildings()
        return undefined
      }

      let active = true

      const load = async () => {
        try {
          const response = await fetch(`${apiBaseUrl}/gis/buildings?limit=4000&measured_only=false`)
          if (!response.ok) throw new Error(`Unable to load buildings (${response.status})`)

          const collection = await response.json()
          if (!active) return

          // Everything LiDAR left unmeasured gets a second pass against an
          // uploaded GeoTIFF surface before anything is extruded. Unlike the
          // map, the mesh is built exactly once and then only toggled, so
          // there is no cheap way to add the heights afterwards — waiting for
          // the raster read here is the price of not extruding a building
          // twice.
          //
          // The drawn outline rides along in the same call. It is measured the
          // same way and against the same window, and one pass over one raster
          // read is the whole reason to send them together.
          const outlines = drawnFeaturesRef.current.map((feature, index) => ({
            type: 'Feature',
            id: `drawn-${index}`,
            geometry: feature.geometry,
            properties: { gv_drawn: true, height_m: null },
          }))

          const filled = await fillHeightsFromGeotiff(
            [...(collection.features ?? []), ...outlines],
            { apiBaseUrl },
          )
          if (!active) return

          const scene = sceneRef.current
          if (!scene) return

          // Split back apart: the two are extruded by different rules and
          // counted in different places.
          const measuredOutlines = filled.features.filter((f) => f.properties?.gv_drawn)
          const footprints = filled.features.filter((f) => !f.properties?.gv_drawn)

          const built = buildBuildingMesh(footprints, measuredOutlines)
          if (!built) {
            setBuildingsInfo({ kind: 'empty' })
            return
          }

          scene.add(built.group)
          buildingsRef.current = built
          setBuildingsInfo({
            kind: 'ready',
            measured: built.measured,
            fromGeotiff: built.fromGeotiff,
            groundFromSurface: filled.groundFromSurface,
            geotiffNote: filled.note,
            total: built.total,
            drawn: built.drawn,
            drawnMeasured: built.drawnMeasured,
          })
          frameBuildings()
        } catch (fetchError) {
          if (!active) return
          setBuildingsInfo({
            kind: 'error',
            message: fetchError instanceof Error ? fetchError.message : 'Unable to load buildings.',
          })
        }
      }

      load()

      return () => {
        active = false
      }
    }, [buildingsOn])

    // Geometry and materials are not garbage collected by three — they hold GPU
    // resources that have to be released explicitly.
    useEffect(() => () => {
      const built = buildingsRef.current
      if (!built) return
      built.group.traverse((child) => {
        child.geometry?.dispose()
        child.material?.dispose()
      })
      sceneRef.current?.remove(built.group)
      buildingsRef.current = null
    }, [])

    // A click on a detached anchor, rather than assigning to location: a
    // navigation to a URL the browser decides it *can* display would replace
    // the viewer instead of saving anything.
    const saveAs = (href, name) => {
      const anchor = document.createElement('a')
      anchor.href = href
      // Ignored for the cross-origin R2 URL — the signed Content-Disposition
      // names that one — but it is what names a local blob.
      anchor.download = name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }

    const handleDownload = async () => {
      if (!downloadTarget || downloading) {
        return
      }

      setDownloadError('')

      if (downloadTarget.kind === 'local') {
        const href = URL.createObjectURL(downloadTarget.file)
        saveAs(href, downloadTarget.name)
        // Revoking in the same tick can cancel the download that was just
        // started; the URL only holds a reference to a file already on disk.
        window.setTimeout(() => URL.revokeObjectURL(href), 60_000)
        return
      }

      setDownloading(true)

      try {
        // download=true is what makes R2 send Content-Disposition: attachment.
        // The signature covers that header, so it cannot be added client-side.
        const response = await fetch(
          `${API_URL}/splat-url?path=${encodeURIComponent(downloadTarget.path)}&download=true`,
        )

        if (!response.ok) {
          throw new Error(`Could not sign the download URL (${response.status})`)
        }

        const data = await response.json()
        saveAs(data.url, data.filename ?? downloadTarget.name)
      } catch (downloadFailure) {
        const message = downloadFailure instanceof Error
          ? downloadFailure.message
          : 'Unable to download that file.'
        setDownloadError(message)
      } finally {
        setDownloading(false)
      }
    }

    const handleFileChange = (event) => {
      const file = event.target.files?.[0]

      if (!file) {
        return
      }

      setRemoteSource(null) // clear any route-provided source
      setDownloadError('')
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
            {/* Two decimals below 0.1: framing the building mesh puts the
                camera hundreds of metres out, where one decimal renders every
                value as a broken-looking "0.0x". */}
            <span className="gv-zoom-value">{zoom < 0.1 ? zoom.toFixed(2) : zoom.toFixed(1)}x</span>
            <button type="button" className="gv-tool gv-tool--sm" onClick={() => dolly(BUTTON_STEPS)} aria-label="Zoom in">
              <IconPlus />
            </button>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            style={{ borderColor: meshActive ? 'var(--color-accent)' : 'var(--color-divider)' }}
            disabled={!meshPath}
            onClick={() => {
              // Clearing here rather than in the effect lets a failed load be
              // retried by toggling, without a setState in an effect body.
              setMeshError('')
              setDownloadError('')
              setViewMode((mode) => (mode === 'mesh' ? 'splat' : 'mesh'))
            }}
            title={meshPath
              ? `Switch between the Gaussian splat and ${getFileName(meshPath)}`
              : 'Only available for a splat opened from the library, not a local upload'}
          >
            {viewMode === 'mesh' ? 'Show splat' : 'Show mesh'}
          </button>

          {/* Next to the mesh toggle on purpose: the toggle decides what you
              are looking at, and this saves exactly that. */}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!downloadTarget || downloading}
            onClick={handleDownload}
            title={downloadTarget
              ? `Download ${downloadTarget.name}`
              : 'Nothing loaded to download yet'}
          >
            <IconDownload />
            {downloading
              ? 'Preparing…'
              : showingMesh
                ? 'Download mesh'
                : 'Download splat'}
          </button>

          <button
            type="button"
            className="btn btn-secondary"
            style={{ borderColor: rotateOpen ? 'var(--color-accent)' : 'var(--color-divider)' }}
            onClick={toggleRotateMenu}
            title="Rotate the model on X, Y and Z"
          >
            Rotate
          </button>

          <button
            type="button"
            className="btn btn-secondary"
            style={{ borderColor: buildingsOn ? 'var(--color-accent)' : 'var(--color-divider)' }}
            onClick={() => setBuildingsOn((on) => !on)}
            title="Building footprints measured against LiDAR or a GeoTIFF surface, extruded at true metric scale"
          >
            {buildingsOn ? 'Hide buildings' : 'Show buildings'}
          </button>

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
            {/* One alert slot, so the claimants are ordered explicitly. A
                download failure outranks the rest: it is the only one that
                answers a button the user just pressed. Mesh state then wins
                while the switch is on it — the splat's own error is not what
                you are looking at, and suppressing this left a mesh switch
                with no feedback at all. */}
            {downloadError ? (
              <div className="gv-stage-alert">{downloadError}</div>
            ) : null}

            {error && !meshAlert && !downloadError ? (
              <div className="gv-stage-alert">{error}</div>
            ) : null}

            {meshAlert && !downloadError ? (
              <div className="gv-stage-alert gv-stage-alert--info">{meshAlert}</div>
            ) : null}

            {buildingsOn && buildingsInfo && !error && !meshAlert && !downloadError ? (
              <div className="gv-stage-alert gv-stage-alert--info">
                {buildingsInfo.kind === 'ready'
                  ? [
                      `${buildingsInfo.measured} of ${buildingsInfo.total} buildings measured`,
                      buildingsInfo.fromGeotiff
                        ? `${buildingsInfo.fromGeotiff} from GeoTIFF${buildingsInfo.groundFromSurface ? ' (no DEM — ground from the surface)' : ''}`
                        : null,
                      buildingsInfo.geotiffNote,
                      buildingsInfo.drawn
                        ? `${buildingsInfo.drawn} drawn surface${buildingsInfo.drawn === 1 ? '' : 's'}${
                          buildingsInfo.drawnMeasured ? ` (${buildingsInfo.drawnMeasured} raised to a measured height)` : ''
                        }`
                        : null,
                      '1 unit = 1 m',
                      'not aligned to the splat',
                    ].filter(Boolean).join(' · ')
                  : buildingsInfo.kind === 'empty'
                    ? 'No measured buildings yet — upload an OSM extract, plus a LiDAR tile or a GeoTIFF surface.'
                    : buildingsInfo.message}
              </div>
            ) : null}

            {rotateOpen ? (
              <div className="gv-rotate-panel">
                <div className="gv-rotate-head">
                  <span>Rotation</span>
                  <button
                    type="button"
                    className="gv-rotate-reset"
                    onClick={() => setRotation(DEFAULT_ROTATION)}
                  >
                    Reset
                  </button>
                </div>
                {ROTATION_AXES.map(({ key, label }) => (
                  <label key={key} className="gv-rotate-row">
                    <span className="gv-rotate-axis">{label}</span>
                    <input
                      type="range"
                      min="-180"
                      max="180"
                      step="1"
                      value={rotation[key]}
                      onChange={(event) => {
                        const next = Number(event.target.value)
                        setRotation((current) => ({ ...current, [key]: next }))
                      }}
                    />
                    <span className="gv-rotate-value">{Math.round(rotation[key])}°</span>
                  </label>
                ))}
              </div>
            ) : null}

            {/* Volume legend, ported from the SVG minimap before it was
                deleted. With four blue classes plus grey plus a translucent
                patch, colour alone stops being self-explanatory. */}
            {buildingsOn && buildingsInfo?.kind === 'ready' ? (
              <div className="gv-volume-legend">
                <span className="gv-volume-legend-title">Building volume</span>
                {VOLUME_CLASS_LABELS.map((label, index) => (
                  <span key={label} className="gv-volume-legend-item">
                    <i style={{ background: BUILDING_COLOURS[index] }} aria-hidden="true" />
                    {label}
                  </span>
                ))}
                <span className="gv-volume-legend-item">
                  <i style={{ background: NO_DATA_COLOUR, opacity: 0.55 }} aria-hidden="true" />
                  no elevation cover
                </span>
                {buildingsInfo.drawn ? (
                  <span className="gv-volume-legend-item">
                    <i
                      style={{
                        background: BUILDING_COLOURS[0],
                        opacity: 0.28,
                        outline: `1px solid ${BUILDING_COLOURS[0]}`,
                      }}
                      aria-hidden="true"
                    />
                    drawn area, height unknown
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="gv-stage-hint">
              <span className="gv-stage-hint-dot" />
              {pointerLocked ? (
                <>
                  Mouse to look · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to move
                  · <kbd>E</kbd>/<kbd>Q</kbd> up and down · <kbd>Shift</kbd> to sprint
                  · <kbd>Esc</kbd> to release
                </>
              ) : (
                <>
                  Click to look around · drag to look · scroll to zoom
                  · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to move
                  · <kbd>E</kbd>/<kbd>Q</kbd> up and down
                </>
              )}
            </div>
          </div>

          {mapOpen ? (
            <div className="gv-map-panel">
              <div className="gv-map-panel-head">
                <span className="gv-map-panel-title">Location</span>
                <button type="button" className="gv-tool gv-tool--sm" onClick={() => setMapOpen(false)} aria-label="Hide map">
                  <IconClose />
                </button>
              </div>
              <div className="gv-map-panel-body">
                <SplatMap className="gv-map-canvas" />
              </div>
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  export default SplatViewer