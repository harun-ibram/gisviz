import { useCallback, useEffect, useRef, useState } from 'react'

/** Arrow keys nudge; Shift makes it a coarse jump. Both in CSS pixels. */
const STEP = 16
const COARSE_STEP = 64

/** `min`/`max` may be a number or a zero-arg function, so a bound can depend on
 *  a container that only exists at drag time. */
function resolve(bound) {
  return typeof bound === 'function' ? bound() : bound
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Drives a drag handle that resizes a neighbouring element along one axis.
 *
 * Pointer-capture based, so the drag survives the pointer leaving the handle —
 * and, on the visualizer, keeps the move events off the splat canvas, which
 * runs its own pointer-lock camera controls.
 *
 * @param {object}   opts
 * @param {'x'|'y'}  opts.axis     Which coordinate delta counts.
 * @param {number}   opts.initial  Starting size, and what a double-click restores.
 * @param {number|() => number} opts.min
 * @param {number|() => number} opts.max
 * @param {boolean}  opts.invert   Set when the resized element sits *before* the
 *                                 handle, so dragging towards it shrinks it.
 */
export default function useDragSize({ axis, initial, min, max, invert = false }) {
  const [size, setSize] = useState(initial)
  const [isDragging, setDragging] = useState(false)

  // The bounds may be functions the caller re-creates every render. Holding the
  // latest pair in a ref keeps them out of the callbacks' dependency lists, so
  // the handlers stay stable without lying to exhaustive-deps. Written in an
  // effect, not during render — a function bound may read layout.
  const boundsRef = useRef({ min, max })
  useEffect(() => {
    boundsRef.current = { min, max }
  })

  // Resolved copies, only so the ARIA attributes can report real numbers. A
  // bound that measures a container cannot be called during render, and it can
  // change when the window does.
  const [bounds, setBounds] = useState(() => ({ min: resolve(min), max: resolve(max) }))
  const measure = useCallback(() => {
    const next = {
      min: resolve(boundsRef.current.min),
      max: resolve(boundsRef.current.max),
    }
    setBounds((prev) => (prev.min === next.min && prev.max === next.max ? prev : next))
    return next
  }, [])

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  // Written on pointerdown, read on every move. A ref rather than state: it
  // changes once per drag and must not re-render.
  const dragRef = useRef(null)

  const bodyClass = axis === 'x' ? 'gv-resizing--x' : 'gv-resizing--y'

  // A drag that is still live when the component unmounts would otherwise
  // leave the whole document unselectable.
  useEffect(() => () => {
    document.body.classList.remove('gv-resizing', bodyClass)
  }, [bodyClass])

  const handlePointerDown = useCallback((event) => {
    // Primary button only — a right-click should open the context menu.
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)

    const { min: lo, max: hi } = measure()
    dragRef.current = {
      origin: axis === 'x' ? event.clientX : event.clientY,
      start: size,
      min: lo,
      max: hi,
    }

    setDragging(true)
    document.body.classList.add('gv-resizing', bodyClass)
  }, [axis, bodyClass, measure, size])

  const handlePointerMove = useCallback((event) => {
    const drag = dragRef.current
    if (!drag) return

    const current = axis === 'x' ? event.clientX : event.clientY
    const delta = current - drag.origin
    setSize(clamp(drag.start + (invert ? -delta : delta), drag.min, drag.max))
  }, [axis, invert])

  const endDrag = useCallback((event) => {
    if (!dragRef.current) return
    dragRef.current = null

    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    setDragging(false)
    document.body.classList.remove('gv-resizing', bodyClass)
  }, [bodyClass])

  const handleKeyDown = useCallback((event) => {
    const { min: lo, max: hi } = measure()

    // "Grow" is down for a horizontal handle, right for a vertical one — and
    // flips again when the resized element sits before the handle.
    const grow = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
    const shrink = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
    const step = event.shiftKey ? COARSE_STEP : STEP
    const sign = invert ? -1 : 1

    let next = null
    if (event.key === grow) next = size + sign * step
    else if (event.key === shrink) next = size - sign * step
    else if (event.key === 'Home') next = lo
    else if (event.key === 'End') next = hi

    if (next === null) return
    event.preventDefault()
    setSize(clamp(next, lo, hi))
  }, [axis, invert, measure, size])

  const reset = useCallback(() => setSize(initial), [initial])

  const handleProps = {
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
    'aria-valuenow': Math.round(size),
    'aria-valuemin': Math.round(bounds.min),
    'aria-valuemax': Math.round(bounds.max),
    'data-dragging': isDragging ? '1' : '0',
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    // Belt and braces: if capture is lost without a pointerup, this is what
    // stops the body class from sticking. endDrag is a no-op the second time.
    onLostPointerCapture: endDrag,
    onKeyDown: handleKeyDown,
    onDoubleClick: reset,
  }

  return { size, setSize, isDragging, handleProps }
}
