// The parts of a ComfyUI/LiteGraph node that the m5 viewers use.
//
// @comfyorg/comfyui-frontend-types doesn't export LGraphNode (nor declare the
// addDOMWidget augmentation), so we describe the subset we touch here and cast
// nodeType.prototype to it in each extension.
import type { DOMWidgetOptions } from "@comfyorg/comfyui-frontend-types";

export type Size = [number, number];

export interface M5Node {
  size: Size;
  graph?: { setDirtyCanvas(fg: boolean, bg?: boolean): void } | null;
  properties?: Record<string, unknown>;
  addDOMWidget(
    name: string,
    type: string,
    element: HTMLElement,
    options?: DOMWidgetOptions<object | string>,
  ): unknown;
  setSize(size: Size): void;
  setDirtyCanvas?(fg: boolean, bg?: boolean): void;
}

/** The node message passed to onExecuted: the `ui` dict returned by execute(). */
export type ExecutedMessage = Record<string, unknown[] | undefined> | undefined;

/** LiteGraph node callbacks we wrap on nodeType.prototype. */
export interface NodePrototype<N extends M5Node> {
  onNodeCreated?(this: N, ...args: unknown[]): unknown;
  onExecuted?(this: N, message: ExecutedMessage, ...args: unknown[]): unknown;
  onConfigure?(this: N, ...args: unknown[]): unknown;
  onRemoved?(this: N, ...args: unknown[]): unknown;
}

/**
 * Wrap `proto[key]` so `fn` runs after (or, with `before`, ahead of) any
 * existing handler, the usual ComfyUI extension chaining pattern.
 */
export function chainCallback<N extends M5Node, K extends keyof NodePrototype<N>>(
  proto: NodePrototype<N>,
  key: K,
  fn: (this: N, ...args: Parameters<NonNullable<NodePrototype<N>[K]>>) => void,
  { before = false } = {},
): void {
  const original = proto[key] as ((this: N, ...args: unknown[]) => unknown) | undefined;
  proto[key] = function (this: N, ...args: unknown[]) {
    if (before) {
      (fn as (this: N, ...a: unknown[]) => void).apply(this, args);
      return original?.apply(this, args);
    }
    const result = original?.apply(this, args);
    (fn as (this: N, ...a: unknown[]) => void).apply(this, args);
    return result;
  } as NodePrototype<N>[K];
}

// Smallest height (graph units) we'll shrink a viewer node to, and the largest
// we'll auto-grow it to. The cap keeps a tall full-orchestra score from
// producing an absurdly long node; the rest stays reachable via the vertical
// scrollbar.
const MIN_NODE_HEIGHT = 160;
const MAX_AUTO_HEIGHT = 1400;

/**
 * Size the node's height to fit `el`'s content. The DOM-widget layer is laid
 * out in graph units (the canvas applies its own zoom transform on top), so
 * scrollHeight/clientHeight are already in the same units as node.size and
 * this works regardless of how far the user has zoomed the ComfyUI canvas.
 */
export function fitNodeHeight(node: M5Node, el: HTMLElement | null): void {
  if (!el) return;
  // Full height of the content, including the bits scrolled out of view.
  const contentHeight = el.scrollHeight;
  // Vertical space the node spends outside this widget (title bar, padding,
  // scrollbar), measured from the current layout so we don't hardcode it.
  const chrome = Math.max(0, node.size[1] - el.clientHeight);
  let target = contentHeight + chrome;
  target = Math.max(MIN_NODE_HEIGHT, Math.min(target, MAX_AUTO_HEIGHT));
  node.size[1] = target;
  node.graph?.setDirtyCanvas(true, true);
}

/** A full-size host element to hand to addDOMWidget and mount React into. */
export function createWidgetHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  return host;
}
