// Frontend for the "Score Viewer" node (Python node_id "ScoreViewer").
//
// The node returns ui = { musicxml: [<MusicXML string>] } from its execute().
// Here we render that MusicXML as engraved notation inside the node using
// OpenSheetMusicDisplay (OSMD), which is vendored next to this file as a UMD
// bundle (lib/opensheetmusicdisplay.min.js).
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

async function renderScore(node, xml) {
  const el = node._m5ScoreEl;
  if (!el) return;
  try {
    const OSMD = await loadOSMD();
    if (!node._m5Osmd) {
      node._m5Osmd = new OSMD.OpenSheetMusicDisplay(el, {
        autoResize: true,
        backend: "svg",
        drawTitle: true,
      });
    }
    await node._m5Osmd.load(xml);
    node._m5Osmd.render();
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
      const el = document.createElement("div");
      el.style.background = "#ffffff";
      el.style.overflow = "auto";
      el.style.width = "100%";
      el.style.minHeight = "200px";
      el.style.boxSizing = "border-box";
      el.style.padding = "4px";

      this.addDOMWidget("score", "div", el, { serialize: false });
      this._m5ScoreEl = el;

      // Give the node a sensible starting size for a score.
      this.size[0] = Math.max(this.size[0], 420);
      this.size[1] = Math.max(this.size[1], 360);

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
