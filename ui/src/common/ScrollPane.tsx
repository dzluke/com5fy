// The white, scrollable pane shared by the Score and Sequence viewers.
import { type CSSProperties, forwardRef, useEffect, useImperativeHandle, useRef } from "react";

// White canvas: OSMD/VexFlow draw black glyphs, which would vanish on
// ComfyUI's dark node background. overflow:auto gives a horizontal scrollbar to
// travel through the music, and a vertical one when the node is shorter than
// the content.
const paneStyle: CSSProperties = {
  background: "#ffffff",
  overflow: "auto",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  padding: "4px",
  outline: "none",
};

/**
 * Scroll the pane with the mouse wheel instead of zooming the ComfyUI canvas.
 * ComfyUI only forwards a wheel event to the canvas (zoom) when the pointer is
 * NOT inside a focused element marked data-capture-wheel="true", so the pane is
 * marked, focusable, and focused on hover. The native wheel listener is a
 * backstop that stops the event from bubbling to any other canvas zoom handler;
 * it stays passive so the browser still performs the native scroll (incl.
 * shift+wheel and trackpad horizontal swipes).
 */
export const ScrollPane = forwardRef<HTMLDivElement, { children?: React.ReactNode }>(
  function ScrollPane({ children }, ref) {
    const el = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => el.current!, []);

    useEffect(() => {
      const pane = el.current;
      if (!pane) return;
      const stop = (e: WheelEvent) => e.stopPropagation();
      pane.addEventListener("wheel", stop, { passive: true });
      return () => pane.removeEventListener("wheel", stop);
    }, []);

    return (
      <div
        ref={el}
        style={paneStyle}
        data-capture-wheel="true"
        tabIndex={-1}
        onPointerEnter={() => el.current?.focus({ preventScroll: true })}
      >
        {children}
      </div>
    );
  },
);
