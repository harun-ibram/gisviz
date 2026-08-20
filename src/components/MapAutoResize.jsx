import { useEffect } from 'react'
import { useMap } from 'react-leaflet'

/**
 * Keeps a Leaflet map in step with its container.
 *
 * Leaflet's own `trackResize` listens to `window.resize` only, so a container
 * that changes size on its own — a drag handle, a panel toggle, a flex reflow —
 * leaves the map at its mount-time pixel size: grey gutters where tiles should
 * be, and clicks landing at the wrong coordinates.
 *
 * Renders nothing; drop it inside a <MapContainer>.
 */
export default function MapAutoResize() {
  const map = useMap()

  useEffect(() => {
    const container = map.getContainer()
    if (!container) return undefined

    let frame = 0
    // invalidateSize() resizes the container's children, which the observer
    // would see as another resize. Comparing against the last size we acted on
    // stops that from looping.
    let last = { width: container.clientWidth, height: container.clientHeight }

    const observer = new ResizeObserver(() => {
      const width = container.clientWidth
      const height = container.clientHeight
      if (width === last.width && height === last.height) return
      last = { width, height }

      // Coalesce a drag's worth of events into one invalidateSize per frame.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        map.invalidateSize({ animate: false })
      })
    })

    observer.observe(container)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [map])

  return null
}
