// Frontend for the "MIDI Viewer" node (Python node_id "m5_MidiViewer").
//
// The node returns ui = { midi_data: [<payload>], zoom: [n], playback_audio:
// [{filename, subfolder, type}] } from its execute(). PianoRoll.ts draws the
// payload and plays the audio; this component lays out the scroller, canvas,
// track legend and transport.
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { COLORS, type PianoRoll, TRACK_COLORS } from "./PianoRoll";

export const CONTROLS_HEIGHT = 30;
export const MIN_ROLL_HEIGHT = 120;

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  background: COLORS.background,
  borderRadius: "4px",
  overflow: "hidden",
  userSelect: "none",
};
const scrollerStyle: CSSProperties = {
  flex: "1 1 0",
  minHeight: "0",
  overflowX: "auto",
  overflowY: "hidden",
};
const canvasStyle: CSSProperties = {
  position: "sticky",
  left: "0",
  display: "block",
  width: "100%",
  height: "100%",
  cursor: "pointer",
  touchAction: "none",
};
const controlsStyle: CSSProperties = {
  flex: `0 0 ${CONTROLS_HEIGHT}px`,
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "0 8px",
  font: "12px monospace",
  color: COLORS.text,
  overflow: "hidden",
};
const playButtonStyle: CSSProperties = {
  flex: "0 0 28px",
  height: "22px",
  padding: "0",
  border: "none",
  borderRadius: "3px",
  background: "#333",
  color: "#ddd",
  cursor: "pointer",
  font: "13px sans-serif",
};
const legendStyle: CSSProperties = {
  flex: "1",
  display: "flex",
  gap: "10px",
  justifyContent: "flex-end",
  overflow: "hidden",
  whiteSpace: "nowrap",
  font: "11px sans-serif",
};

export function MidiViewer({ roll }: { roll: PianoRoll }) {
  const state = useSyncExternalStore(roll.subscribe, roll.getSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    roll.attach(canvasRef.current, scrollerRef.current);
    const ro = new ResizeObserver(() => roll.onResize());
    if (scrollerRef.current) ro.observe(scrollerRef.current);
    return () => {
      ro.disconnect();
      roll.attach(null, null);
    };
  }, [roll]);

  // The wheel scrolls the roll sideways instead of zooming the graph. Native
  // (non-passive) so it can preventDefault; React doesn't handle wheel here, so
  // stopping it at this div is fine. Pointer events are stopped with a React
  // handler on the div instead (see AudioPlayback.tsx for why).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const wheel = (e: WheelEvent) => {
      const scroller = scrollerRef.current;
      if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
      e.stopPropagation();
      e.preventDefault();
      scroller.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    };
    root.addEventListener("wheel", wheel, { passive: false });
    return () => root.removeEventListener("wheel", wheel);
  }, []);

  const tracks = state.data?.tracks ?? [];
  return (
    <div ref={rootRef} style={rootStyle} onPointerDown={(e) => e.stopPropagation()}>
      <div ref={scrollerRef} style={scrollerStyle} onScroll={() => roll.onScroll()}>
        <div style={{ width: `${state.contentWidth}px`, height: "100%" }}>
          <canvas
            ref={canvasRef}
            style={canvasStyle}
            onPointerDown={(e) => roll.onPointerDown(e)}
            onPointerMove={(e) => roll.onPointerMove(e)}
            onPointerUp={(e) => roll.onPointerUp(e)}
            onPointerCancel={(e) => roll.onPointerUp(e)}
            onPointerLeave={() => roll.onPointerLeave()}
          />
        </div>
      </div>
      <div style={controlsStyle}>
        <button
          style={{ ...playButtonStyle, opacity: state.hasBuffer ? "1" : "0.4" }}
          disabled={!state.hasBuffer}
          title={state.playing ? "Pause" : "Play (basic synth)"}
          onClick={() => roll.toggle()}
        >
          {state.playing ? "❚❚" : "▶"}
        </button>
        <span style={{ flex: "0 0 auto" }}>{state.time}</span>
        {state.data && (
          <span style={{ flex: "0 0 auto" }}>
            {state.data.tempo} · {state.data.meter}
          </span>
        )}
        {state.status && <span style={{ flex: "0 1 auto", overflow: "hidden" }}>{state.status}</span>}
        <span style={legendStyle}>
          {tracks.map((t, i) =>
            t.notes.length ? (
              <span key={i} title={`channel ${t.channels.join(", ") || "-"} · ${t.notes.length} notes`}>
                <span style={{ color: TRACK_COLORS[i % TRACK_COLORS.length] }}>■</span>{" "}
                {t.name || `track ${i + 1}`}
              </span>
            ) : null,
          )}
        </span>
      </div>
    </div>
  );
}
