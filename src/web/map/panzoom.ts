import { useEffect, useRef, useState } from "preact/hooks";

export interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.2;
const MAX_K = 3;
const SETTLE_MS = 160;
const clamp = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

/**
 * Trackpad-first pan and zoom for a canvas: two-finger scroll pans, pinch zooms
 * around the pointer (Chrome/Firefox send it as ctrl+wheel, Safari as gesture
 * events), and dragging empty space pans. Programmatic moves animate.
 *
 * The view lives in a ref and is written straight to the layer's CSS transform,
 * once per frame, so moving never re-renders the map. While a gesture is going,
 * the layer is promoted to its own compositor layer (will-change); when it
 * settles, that's dropped so the browser redraws it crisply at the new zoom.
 */
export function usePanZoom(ignore = ".gnode, .map-tools, button") {
  // Callback refs, so listeners attach whenever the elements appear.
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const view = useRef<View>({ x: 24, y: 24, k: 1 });
  // Only for things that show the zoom (the % label); updated when a gesture settles.
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const layerRef = useRef<HTMLElement | null>(null);
  layerRef.current = layer;

  const paint = () => {
    frame.current = 0;
    const el = layerRef.current;
    const { x, y, k } = view.current;
    if (el) el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
  };

  const set = (next: View, opts: { animate?: boolean } = {}) => {
    view.current = { ...next, k: clamp(next.k) };
    const el = layerRef.current;
    if (el) {
      el.classList.toggle("animating", !!opts.animate);
      el.classList.add("moving");
    }
    if (!frame.current) frame.current = requestAnimationFrame(paint);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      layerRef.current?.classList.remove("moving", "animating");
      setZoom(view.current.k);
    }, opts.animate ? 320 : SETTLE_MS);
  };

  // Put the layer where the view says as soon as it exists.
  useEffect(() => {
    if (layer) paint();
  }, [layer]);

  /** Zoom by `factor`, keeping the point (px, py) in element coordinates still. */
  const zoomAt = (factor: number, px: number, py: number, animate = false) => {
    const v = view.current;
    const k = clamp(v.k * factor);
    set({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }, { animate });
  };

  useEffect(() => {
    if (!node) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = node.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? node.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) {
        const [px, py] = local(e);
        // Pinch sends small deltas; a mouse notch sends ~100. Capping keeps both sane.
        const d = Math.max(-30, Math.min(30, e.deltaY * unit));
        zoomAt(2 ** (-d * 0.02), px, py);
      } else {
        const v = view.current;
        set({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit });
      }
    };

    // Safari's pinch.
    let gestureStart = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = view.current.k;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const [px, py] = local(g);
      zoomAt(clamp(gestureStart * g.scale) / view.current.k, px, py);
    };

    let drag: { id: number; x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest(ignore)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, moved: false };
      node.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) setDragging(true);
      drag.moved = true;
      set({ ...view.current, x: drag.vx + dx, y: drag.vy + dy });
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) setDragging(false);
      drag = null;
    };

    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("gesturestart", onGestureStart);
    node.addEventListener("gesturechange", onGestureChange);
    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("gesturestart", onGestureStart);
      node.removeEventListener("gesturechange", onGestureChange);
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };
  }, [node]);

  const size = () => ({ w: node?.clientWidth ?? 800, h: node?.clientHeight ?? 600 });

  return {
    ref: setNode,
    layerRef: setLayer,
    node,
    /** The current view (read it when you need it; changing it doesn't re-render). */
    get view() {
      return view.current;
    },
    zoom,
    dragging,
    /** Zoom around the middle of the canvas (buttons and keys). */
    zoomBy: (factor: number) => {
      const { w, h } = size();
      zoomAt(factor, w / 2, h / 2, true);
    },
    reset: () => {
      const { w, h } = size();
      const v = view.current;
      set({ k: 1, x: w / 2 - (w / 2 - v.x) / v.k, y: h / 2 - (h / 2 - v.y) / v.k }, { animate: true });
    },
    /** Fit a content box of `width` × `height` in the canvas. */
    fit: (width: number, height: number, maxK = 1.25) => {
      const { w, h } = size();
      const k = clamp(Math.min(maxK, (w - 48) / width, (h - 48) / height));
      set({ k, x: (w - width * k) / 2, y: (h - height * k) / 2 }, { animate: true });
    },
    /** Put content point (x, y) at the canvas position (fx, fy), as fractions of its size. */
    place: (x: number, y: number, fx = 0.5, fy = 0.5, animate = true) => {
      const { w, h } = size();
      const k = view.current.k;
      set({ k, x: w * fx - x * k, y: h * fy - y * k }, { animate });
    },
    /** Pan just enough to bring the box (x, y, width) on screen. */
    reveal: (x: number, y: number, width: number) => {
      const { w, h } = size();
      const v = view.current;
      const sx = v.x + x * v.k;
      const sy = v.y + y * v.k;
      const pad = 48;
      let nx = v.x;
      let ny = v.y;
      if (sx < pad) nx += pad - sx;
      else if (sx + width * v.k > w - pad) nx -= Math.min(sx - pad, sx + width * v.k - (w - pad));
      if (sy < pad) ny += pad - sy;
      else if (sy > h - pad) ny -= sy - (h - pad);
      if (nx !== v.x || ny !== v.y) set({ ...v, x: nx, y: ny }, { animate: true });
    },
  };
}
