import { useEffect, useRef, useState } from "preact/hooks";

export interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.2;
const MAX_K = 3;
const clamp = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

/**
 * Trackpad-first pan and zoom for a canvas: two-finger scroll pans, pinch zooms
 * around the pointer (Chrome/Firefox send it as ctrl+wheel, Safari as gesture
 * events), and dragging empty space pans. Programmatic moves animate.
 */
export function usePanZoom(ignore = ".gnode, .map-tools, button") {
  // A callback ref, so listeners attach whenever the canvas element appears.
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [view, setView] = useState<View>({ x: 24, y: 24, k: 1 });
  const [animating, setAnimating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const current = useRef(view);
  current.current = view;

  /** Zoom by `factor`, keeping the point (px, py) in element coordinates still. */
  const zoomAt = (factor: number, px: number, py: number) =>
    setView((v) => {
      const k = clamp(v.k * factor);
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });

  const animateTo = (next: View) => {
    setAnimating(true);
    setView({ ...next, k: clamp(next.k) });
    setTimeout(() => setAnimating(false), 280);
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
        setView((v) => ({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit }));
      }
    };

    // Safari's pinch.
    let gestureStart = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = current.current.k;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const [px, py] = local(g);
      zoomAt(clamp(gestureStart * g.scale) / current.current.k, px, py);
    };

    let drag: { id: number; x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest(ignore)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: current.current.x, vy: current.current.y, moved: false };
      node.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      setDragging(true);
      setView((v) => ({ ...v, x: drag!.vx + dx, y: drag!.vy + dy }));
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      setDragging(false);
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
    node,
    view,
    animating,
    dragging,
    /** Zoom around the middle of the canvas (buttons and keys). */
    zoomBy: (factor: number) => {
      const { w, h } = size();
      setAnimating(true);
      zoomAt(factor, w / 2, h / 2);
      setTimeout(() => setAnimating(false), 280);
    },
    reset: () => {
      const { w, h } = size();
      const v = current.current;
      animateTo({ k: 1, x: w / 2 - ((w / 2 - v.x) * 1) / v.k, y: h / 2 - ((h / 2 - v.y) * 1) / v.k });
    },
    /** Fit a content box of `width` × `height` in the canvas. */
    fit: (width: number, height: number, maxK = 1.25) => {
      const { w, h } = size();
      const k = clamp(Math.min(maxK, (w - 48) / width, (h - 48) / height));
      animateTo({ k, x: (w - width * k) / 2, y: (h - height * k) / 2 });
    },
    /** Put content point (x, y) at the canvas position (fx, fy), as fractions of its size. */
    place: (x: number, y: number, fx = 0.5, fy = 0.5, animate = true) => {
      const { w, h } = size();
      const k = current.current.k;
      const next = { k, x: w * fx - x * k, y: h * fy - y * k };
      animate ? animateTo(next) : setView(next);
    },
    /** Pan just enough to bring the box (x, y, width) on screen. */
    reveal: (x: number, y: number, width: number) => {
      const { w, h } = size();
      const v = current.current;
      const sx = v.x + x * v.k;
      const sy = v.y + y * v.k;
      const pad = 48;
      let nx = v.x;
      let ny = v.y;
      if (sx < pad) nx += pad - sx;
      else if (sx + width * v.k > w - pad) nx -= Math.min(sx - pad, sx + width * v.k - (w - pad));
      if (sy < pad) ny += pad - sy;
      else if (sy > h - pad) ny -= sy - (h - pad);
      if (nx !== v.x || ny !== v.y) animateTo({ ...v, x: nx, y: ny });
    },
  };
}
