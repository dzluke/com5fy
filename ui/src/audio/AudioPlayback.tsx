// Frontend for the "Audio Playback" node (Python node_id "m5_AudioPlayback").
//
// The node returns ui = { playback_audio: [{ filename, subfolder, type }] } from
// its execute(): a FLAC rendering of its input audio, written to ComfyUI's temp
// directory. Player.ts does the loading, transport and canvas drawing; this
// component lays out the canvas and the controls row.
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { COLORS, type Player } from "./Player";

export const CONTROLS_HEIGHT = 30;
export const MIN_WAVEFORM_HEIGHT = 60;

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

// The canvas is absolutely positioned inside a flex wrapper so the size of its
// backing store (which we set from its CSS box) can't feed back into the flex
// layout and make it grow.
const canvasWrapStyle: CSSProperties = { flex: "1 1 0", minHeight: "0", position: "relative" };
const canvasStyle: CSSProperties = {
  position: "absolute",
  inset: "0",
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
};
const playButtonStyle: CSSProperties = {
  width: "28px",
  height: "22px",
  padding: "0",
  border: "none",
  borderRadius: "3px",
  background: "#333",
  color: "#ddd",
  cursor: "pointer",
  font: "13px sans-serif",
};
const spectrogramButtonStyle: CSSProperties = {
  flex: "0 0 auto",
  height: "22px",
  padding: "0 8px",
  border: "none",
  borderRadius: "3px",
  background: "#333",
  color: "#ddd",
  cursor: "pointer",
  font: "12px sans-serif",
};
const statusStyle: CSSProperties = {
  flex: "1",
  textAlign: "right",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function AudioPlayback({ player }: { player: Player }) {
  const state = useSyncExternalStore(player.subscribe, player.getSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Layout effect so the canvas is attached synchronously on mount (the node's
  // onConfigure may toggle the spectrogram right after onNodeCreated).
  useLayoutEffect(() => {
    player.attachCanvas(canvasRef.current);
    const ro = new ResizeObserver(() => player.onResize());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      ro.disconnect();
      player.attachCanvas(null);
    };
  }, [player]);

  // Keep pointer interaction inside the widget from also dragging the node or
  // panning the canvas. Native listener, so it stops the event at this element.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const stop = (e: PointerEvent) => e.stopPropagation();
    root.addEventListener("pointerdown", stop);
    return () => root.removeEventListener("pointerdown", stop);
  }, []);

  return (
    <div ref={rootRef} style={rootStyle}>
      <div ref={wrapRef} style={canvasWrapStyle}>
        <canvas
          ref={canvasRef}
          style={canvasStyle}
          onPointerDown={(e) => player.onPointerDown(e)}
          onPointerMove={(e) => player.onPointerMove(e)}
          onPointerUp={(e) => player.onPointerUp(e)}
          onPointerCancel={(e) => player.onPointerUp(e)}
          onPointerLeave={() => player.onPointerLeave()}
        />
      </div>
      <div style={controlsStyle}>
        <button
          style={{ ...playButtonStyle, opacity: state.hasBuffer ? "1" : "0.4" }}
          disabled={!state.hasBuffer}
          title={state.playing ? "Pause" : "Play"}
          onClick={() => player.toggle()}
        >
          {state.playing ? "❚❚" : "▶"}
        </button>
        <span>{state.time}</span>
        <span style={statusStyle}>{state.status}</span>
        <button
          style={spectrogramButtonStyle}
          onClick={() => player.setSpectrogramVisible(!state.showSpectrogram)}
        >
          {state.showSpectrogram ? "hide spectrogram" : "show spectrogram"}
        </button>
      </div>
    </div>
  );
}
