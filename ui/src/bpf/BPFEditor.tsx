// Layout for the BPF node's editor: the canvas (drawn by Editor.ts) and a status row with
// the hovered point / cursor value, and "Edit a copy" when showing an incoming curve.
import { type CSSProperties, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import type { Editor } from "./Editor";

export const STATUS_HEIGHT = 22;
export const MIN_EDITOR_HEIGHT = 300;

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  borderRadius: "4px",
  overflow: "hidden",
  userSelect: "none",
  background: "var(--comfy-input-bg, #222)",
};
// Absolutely positioned canvas inside a flex child, so its backing-store size can't feed
// back into the layout.
const canvasWrapStyle: CSSProperties = { flex: "1 1 0", minHeight: "0", position: "relative" };
const statusStyle: CSSProperties = {
  flex: `0 0 ${STATUS_HEIGHT}px`,
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "0 6px",
  font: "11px sans-serif",
  color: "var(--descrip-text, #999)",
};
const textStyle: CSSProperties = { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const buttonStyle: CSSProperties = {
  flex: "0 0 auto",
  height: "18px",
  padding: "0 8px",
  border: "1px solid var(--border-color, #4e4e4e)",
  borderRadius: "3px",
  background: "var(--comfy-menu-bg, #353535)",
  color: "var(--input-text, #ddd)",
  cursor: "pointer",
  font: "11px sans-serif",
};

const HELP = "click: add · drag: move (Shift snap, Alt value only) · double/right-click or Del: delete";

export function BPFEditor({ editor, onEditCopy }: { editor: Editor; onEditCopy: () => void }) {
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const wrapRef = useRef<HTMLDivElement>(null);

  // The canvas is created by Editor (it owns the event handlers); mount it here.
  useLayoutEffect(() => {
    const wrap = wrapRef.current!;
    wrap.appendChild(editor.canvas);
    editor.draw();
    return () => {
      editor.canvas.remove();
    };
  }, [editor]);

  return (
    <div style={rootStyle}>
      <div ref={wrapRef} style={canvasWrapStyle} />
      <div style={statusStyle}>
        <span style={textStyle} title={HELP}>
          {state.status || (state.readOnly ? "" : HELP)}
        </span>
        {state.readOnly && (
          <button
            style={buttonStyle}
            title="Copy the incoming curve into the editor and disconnect the input"
            onClick={onEditCopy}
          >
            Edit a copy
          </button>
        )}
      </div>
    </div>
  );
}
