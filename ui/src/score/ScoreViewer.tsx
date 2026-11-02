// Frontend for the "Score Viewer" node (Python node_id "m5_ScoreViewer").
//
// The node returns ui = { musicxml: [<MusicXML string>] } from its execute().
// Here we render that MusicXML as engraved notation inside the node using
// OpenSheetMusicDisplay (OSMD), loaded lazily on first render.
//
// Layout model: the whole piece is engraved as ONE continuous horizontal
// staffline (OSMD's RenderSingleHorizontalStaffline), so the user scrolls
// sideways through the measures instead of OSMD wrapping them into stacked
// systems or breaking them across pages. Because that layout's size depends
// only on the music (not on the container width), resizing the node never
// needs a re-render: the scroll pane just clips and scrolls. On each render we
// size the node's HEIGHT to fit the engraved score (width is left under the
// user's control); shrinking the node past that just reveals a vertical
// scrollbar.
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { useEffect, useRef } from "react";

import { type M5Node, fitNodeHeight } from "../common/node";
import { ScrollPane } from "../common/ScrollPane";

let osmdModule: Promise<typeof import("opensheetmusicdisplay")> | null = null;
function loadOSMD() {
  osmdModule ??= import("opensheetmusicdisplay");
  return osmdModule;
}

async function renderScore(
  node: M5Node,
  el: HTMLDivElement,
  osmdRef: { current: OpenSheetMusicDisplay | null },
  xml: string,
) {
  try {
    const OSMD = await loadOSMD();
    if (!osmdRef.current) {
      // autoResize is off: the single-horizontal-staffline layout doesn't
      // reflow with container width, so a window/node resize would only
      // re-render the same picture.
      osmdRef.current = new OSMD.OpenSheetMusicDisplay(el, {
        autoResize: false,
        backend: "svg",
        drawTitle: true,
      });
      osmdRef.current.EngravingRules.RenderSingleHorizontalStaffline = true;
    }
    await osmdRef.current.load(xml);
    osmdRef.current.render();
    // Wait a frame so the SVG is laid out before we measure its height.
    requestAnimationFrame(() => fitNodeHeight(node, el));
  } catch (err) {
    console.error("[m5.ScoreViewer] failed to render score:", err);
    el.textContent = "Failed to render score: " + ((err as Error)?.message ?? err);
  }
}

export interface ScoreViewerProps {
  node: M5Node;
  xml: string | null;
  /** Bumped on every execution, so re-running re-renders even the same XML. */
  run: number;
}

export function ScoreViewer({ node, xml, run }: ScoreViewerProps) {
  // OSMD draws straight into the pane, which React renders without children,
  // so React never touches the engraved SVG.
  const pane = useRef<HTMLDivElement>(null);
  const osmd = useRef<OpenSheetMusicDisplay | null>(null);

  useEffect(() => {
    if (xml && pane.current) void renderScore(node, pane.current, osmd, xml);
  }, [node, xml, run]);

  return <ScrollPane ref={pane} />;
}
