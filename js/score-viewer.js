// Frontend for the "Score Viewer" node (Python node_id "ScoreViewer").
//
// The node returns ui = { musicxml: [<MusicXML string>] } from its execute().
// Here we render that MusicXML as engraved notation inside the node using
// OpenSheetMusicDisplay (OSMD), which is vendored next to this file as a UMD
// bundle (lib/opensheetmusicdisplay.min.js).
//
// Layout model: the whole piece is engraved as ONE continuous horizontal
// staffline (OSMD's RenderSingleHorizontalStaffline), so the user scrolls
// sideways through the measures instead of OSMD wrapping them into stacked
// systems or breaking them across pages. Because that layout's size depends
// only on the music (not on the container width), resizing the node never
// needs a re-render — the scroll container just clips and scrolls. On each
// render we size the node's HEIGHT to fit the engraved score (width is left
// under the user's control); shrinking the node past that just reveals a
// vertical scrollbar.
//
// Absolute import of the app API ("/scripts/app.js") is used instead of a
// relative path: single-file custom-node modules can be served from a
// multi-segment /extensions/... route, which would break "../../" guesses.
// The OSMD bundle is loaded relative to *this* file via import.meta.url, so it
// resolves correctly whatever the route turns out to be.

import { app } from "/scripts/app.js";

// Load the vendored OSMD UMD bundle once. It is not an ES module, so inject it
// as a <script> and resolve when window.opensheetmusicdisplay is available.
let osmdLibPromise = null;
function loadOSMD() {
  if (window.opensheetmusicdisplay) return Promise.resolve(window.opensheetmusicdisplay);
  if (!osmdLibPromise) {
    const url = new URL("lib/opensheetmusicdisplay.min.js", import.meta.url).href;
    osmdLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => resolve(window.opensheetmusicdisplay);
      script.onerror = () => reject(new Error("Failed to load OSMD bundle from " + url));
      document.head.appendChild(script);
    });
  }
  return osmdLibPromise;
}

// Smallest height (graph units) we'll shrink the node to, and the largest we'll
// auto-grow it to. The cap keeps a tall full-orchestra score from producing an
// absurdly long node — the rest stays reachable via the vertical scrollbar.
const MIN_NODE_HEIGHT = 160;
const MAX_AUTO_HEIGHT = 1400;

// Size the node's height to fit the rendered score. The DOM-widget layer is laid
// out in graph units (the canvas applies its own zoom transform on top), so
// scrollHeight/clientHeight are already in the same units as node.size and this
// works regardless of how far the user has zoomed the ComfyUI canvas.
function fitNodeHeightToScore(node) {
  const el = node._m5ScoreEl;
  if (!el) return;
  // Full height of the engraved content, including the bits scrolled out of view.
  const contentHeight = el.scrollHeight;
  // Vertical space the node spends outside this widget (title bar, padding,
  // scrollbar), measured from the current layout so we don't hardcode it.
  const chrome = Math.max(0, node.size[1] - el.clientHeight);
  let target = contentHeight + chrome;
  target = Math.max(MIN_NODE_HEIGHT, Math.min(target, MAX_AUTO_HEIGHT));
  node.size[1] = target;
  node.graph?.setDirtyCanvas(true, true);
}

async function renderScore(node, xml) {
  const el = node._m5ScoreEl;
  if (!el) return;
  try {
    const OSMD = await loadOSMD();
    if (!node._m5Osmd) {
      // autoResize is off: the single-horizontal-staffline layout doesn't reflow
      // with container width, so a window/node resize would only re-render the
      // same picture.
      node._m5Osmd = new OSMD.OpenSheetMusicDisplay(el, {
        autoResize: false,
        backend: "svg",
        drawTitle: true,
      });
      node._m5Osmd.EngravingRules.RenderSingleHorizontalStaffline = true;
    }
    await node._m5Osmd.load(xml);
    node._m5Osmd.render();
    // Wait a frame so the SVG is laid out before we measure its height.
    requestAnimationFrame(() => fitNodeHeightToScore(node));
  } catch (err) {
    console.error("[m5.ScoreViewer] failed to render score:", err);
    el.textContent = "Failed to render score: " + (err?.message ?? err);
  }
}

app.registerExtension({
  name: "m5.ScoreViewer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "m5_ScoreViewer") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);

      // White canvas: OSMD draws black glyphs, which would vanish on ComfyUI's
      // dark node background.
      // overflow:auto gives a horizontal scrollbar to travel through the
      // measures, and a vertical one when the node is shorter than the score.
      const el = document.createElement("div");
      el.style.background = "#ffffff";
      el.style.overflow = "auto";
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.boxSizing = "border-box";
      el.style.padding = "4px";
      el.style.outline = "none";

      // Scroll the score with the mouse wheel instead of zooming the ComfyUI
      // canvas. ComfyUI only forwards a wheel event to the canvas (zoom) when
      // the pointer is NOT inside a focused element marked
      // data-capture-wheel="true", so we mark the container, make it focusable,
      // and focus it on hover. The wheel listener is a backstop that stops the
      // event from bubbling to any other canvas zoom handler; it stays passive
      // so the browser still performs the native scroll (incl. shift+wheel and
      // trackpad horizontal swipes through the measures).
      el.setAttribute("data-capture-wheel", "true");
      el.tabIndex = -1;
      el.addEventListener("pointerenter", () => el.focus({ preventScroll: true }));
      el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

      // getMinHeight lets the user drag the node shorter than the score (the
      // overflow scrollbars then reveal the rest); without it ComfyUI's default
      // DOM-widget minimum would keep the node tall.
      this.addDOMWidget("score", "div", el, {
        serialize: false,
        getMinHeight: () => 48,
      });
      this._m5ScoreEl = el;

      // Starting width; the height is taken over by fitNodeHeightToScore() once
      // a score is rendered.
      this.size[0] = Math.max(this.size[0], 420);
      this.size[1] = Math.max(this.size[1], 240);

      // If we already received a score before the widget existed, render it now.
      if (this._m5PendingXml) {
        renderScore(this, this._m5PendingXml);
        this._m5PendingXml = null;
      }
      return result;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const xml = message?.musicxml?.[0];
      if (!xml) return;
      if (this._m5ScoreEl) {
        renderScore(this, xml);
      } else {
        this._m5PendingXml = xml; // onNodeCreated will pick it up
      }
    };
  },
});
