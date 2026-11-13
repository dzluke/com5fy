// Frontend for the "BPF" node (Python node_id "m5_BPF", nodes/create.py).
//
// The node's `points` STRING widget (a JSON list of [time_ms, value]) is replaced by a DOM
// widget of the same name holding the curve editor; its value is the editor's points as
// JSON, so they are saved in the workflow (widgets_values) and sent to the backend like any
// widget. The other widgets (duration_ms, min, max, interpolation, name, unit) set the box
// and are read at draw time. The editor is the first widget, so it sits above the settings
// and takes all the height they leave. When the node runs with a BPF on its `input`, the backend sends
// it back as ui.bpf and the editor shows it read-only.
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";

import { app } from "/scripts/app.js";

import { type M5Node, type NodePrototype, chainCallback, createWidgetHost } from "../common/node";
import { BPFEditor, MIN_EDITOR_HEIGHT, STATUS_HEIGHT } from "./BPFEditor";
import { type BPFPayload, type Curve, type Interpolation, type Point, parsePoints } from "./curve";
import { Editor, payloadToCurve } from "./Editor";

interface Widget {
  name: string;
  value: unknown;
  disabled?: boolean;
  callback?: (value: unknown, ...rest: unknown[]) => unknown;
  onRemove?: () => void;
}

interface BPFNode extends M5Node {
  widgets?: Widget[];
  inputs?: { name: string; link: number | null }[];
  disconnectInput?(slot: number): unknown;
  _m5Bpf?: { editor: Editor; root: Root };
  _m5PendingBpf?: BPFPayload;
}

type BPFProto = NodePrototype<BPFNode> & {
  onConnectionsChange?(this: BPFNode, type: number, index: number, connected: boolean, ...rest: unknown[]): unknown;
};

const SETTINGS = ["duration_ms", "min", "max", "interpolation", "name", "unit"];
// Default node size (the size before the editor moved on top; user, 2026-11-13).
const DEFAULT_SIZE = [520, 420];
const LG_INPUT = 1; // LiteGraph NodeSlotType.INPUT

function widget(node: BPFNode, name: string): Widget | undefined {
  return node.widgets?.find((w) => w.name === name);
}

/** The box and settings from the node's widgets. */
function settings(node: BPFNode): Omit<Curve, "points"> {
  const num = (name: string, fallback: number) => {
    const v = Number(widget(node, name)?.value);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    duration: num("duration_ms", 4000),
    lo: num("min", 0),
    hi: num("max", 1),
    interpolation: (widget(node, "interpolation")?.value as Interpolation) ?? "linear",
    name: String(widget(node, "name")?.value ?? ""),
    unit: String(widget(node, "unit")?.value ?? ""),
  };
}

/**
 * Workflows saved before the editor moved above the settings (2026-11-13) have
 * widgets_values in the old order, [...SETTINGS, points], and LiteGraph assigns them by
 * position. The new order starts with the points (a JSON string) and the old one with
 * duration_ms (a number), so a non-string first value means "old order": assign by name.
 */
function migrateWidgetOrder(node: BPFNode, info?: { widgets_values?: unknown[] }): void {
  const values = info?.widgets_values;
  if (!Array.isArray(values) || values.length < SETTINGS.length + 1 || typeof values[0] === "string") return;
  SETTINGS.forEach((name, i) => {
    const w = widget(node, name);
    if (w) w.value = values[i];
  });
  const editor = node._m5Bpf?.editor;
  if (editor) editor.points = parsePoints(values[SETTINGS.length]);
}

/** Grey out the drawing settings while a BPF on `input` is shown instead. */
function syncInputState(node: BPFNode): void {
  const linked = node.inputs?.some((i) => i.name === "input" && i.link != null) ?? false;
  for (const name of SETTINGS) {
    const w = widget(node, name);
    if (w) w.disabled = linked;
  }
  if (!linked && node._m5Bpf) {
    node._m5Bpf.editor.incoming = null;
    node._m5Bpf.editor.draw();
  }
  node.graph?.setDirtyCanvas(true, true);
}

/** Tell ComfyUI the workflow changed (for the unsaved-changes mark and undo). */
function markChanged(node: BPFNode): void {
  node.graph?.setDirtyCanvas(true, true);
  const tracker = (app as unknown as {
    extensionManager?: { workflow?: { activeWorkflow?: { changeTracker?: { checkState(): void } } } };
  }).extensionManager?.workflow?.activeWorkflow?.changeTracker;
  tracker?.checkState();
}

/** Copy the incoming curve into the widgets and editor, and disconnect the input. */
function editCopy(node: BPFNode): void {
  const editor = node._m5Bpf?.editor;
  const curve = editor?.incoming;
  if (!editor || !curve) return;
  const set = (name: string, value: unknown) => {
    const w = widget(node, name);
    if (w) w.value = value;
  };
  set("duration_ms", curve.duration);
  set("min", curve.lo);
  set("max", curve.hi);
  set("interpolation", curve.interpolation);
  set("name", curve.name);
  set("unit", curve.unit);
  editor.points = curve.points.map(([t, v]) => [t, v] as Point);
  editor.incoming = null;
  const slot = node.inputs?.findIndex((i) => i.name === "input") ?? -1;
  if (slot >= 0 && node.inputs![slot].link != null) node.disconnectInput?.(slot);
  syncInputState(node);
  editor.draw();
  markChanged(node);
}

app.registerExtension({
  name: "m5.BPF",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "m5_BPF") return;
    const proto = nodeType.prototype as unknown as BPFProto;

    chainCallback(proto, "onNodeCreated", function () {
      const node = this;
      const editor = new Editor(
        () => settings(node),
        () => markChanged(node),
      );

      // Swap the plain `points` text widget for the editor (same name, so it is saved and
      // sent to the backend under `points`). The editor is moved first (below) so it is drawn
      // above the settings; as the only DOM widget it takes all the free height.
      const widgets = node.widgets ?? [];
      const textIndex = widgets.findIndex((w) => w.name === "points");
      if (textIndex >= 0) {
        const [text] = widgets.splice(textIndex, 1);
        editor.points = parsePoints(text.value);
        text.onRemove?.();
      }
      const host = createWidgetHost();
      const root = createRoot(host);
      flushSync(() => root.render(<BPFEditor editor={editor} onEditCopy={() => editCopy(node)} />));
      node.addDOMWidget("points", "bpf", host, {
        getValue: () => JSON.stringify(editor.points),
        setValue: (value) => {
          editor.points = parsePoints(value);
          editor.draw();
        },
        getMinHeight: () => MIN_EDITOR_HEIGHT + STATUS_HEIGHT,
      });
      const editorIndex = widgets.findIndex((w) => w.name === "points");
      if (editorIndex > 0) widgets.unshift(...widgets.splice(editorIndex, 1));
      node._m5Bpf = { editor, root };

      // Redraw when a setting changes (no run needed: they only change the view until then).
      for (const name of SETTINGS) {
        const w = widget(node, name);
        if (!w) continue;
        const original = w.callback;
        w.callback = function (this: unknown, ...args: [unknown, ...unknown[]]) {
          const result = original?.apply(this, args);
          editor.draw();
          return result;
        };
      }

      node.size[0] = Math.max(node.size[0], DEFAULT_SIZE[0]);
      node.size[1] = Math.max(node.size[1], DEFAULT_SIZE[1]);

      if (node._m5PendingBpf) {
        show(node, node._m5PendingBpf);
        node._m5PendingBpf = undefined;
      }
    });

    // Loading a workflow sets the widget values (points via setValue) without callbacks.
    chainCallback(proto, "onConfigure", function (info) {
      migrateWidgetOrder(this, info as { widgets_values?: unknown[] } | undefined);
      syncInputState(this);
      this._m5Bpf?.editor.draw();
    });

    chainCallback(proto, "onExecuted", function (message) {
      const payload = message?.bpf?.[0] as BPFPayload | undefined;
      if (!payload) return;
      if (this._m5Bpf) show(this, payload);
      else this._m5PendingBpf = payload;
    });

    // Settings greyed out while an input is connected; back to editing when it is removed.
    const originalConnections = proto.onConnectionsChange;
    proto.onConnectionsChange = function (type, index, connected, ...rest) {
      const result = originalConnections?.call(this, type, index, connected, ...rest);
      if (type === LG_INPUT && this.inputs?.[index]?.name === "input") syncInputState(this);
      return result;
    };

    chainCallback(
      proto,
      "onRemoved",
      function () {
        this._m5Bpf?.editor.destroy();
        this._m5Bpf?.root.unmount();
        this._m5Bpf = undefined;
      },
      { before: true },
    );
  },
});

function show(node: BPFNode, payload: BPFPayload): void {
  const editor = node._m5Bpf!.editor;
  editor.incoming = payload.source === "input" ? payloadToCurve(payload) : null;
  editor.draw();
}
