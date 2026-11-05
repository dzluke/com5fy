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

// Diatonic step names, and each clef sign's reference pitch (the pitch on its
// <line>) as a diatonic index (octave * 7 + step).
const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const CLEF_REFERENCE: Record<string, number> = { G: 4 * 7 + 4, F: 3 * 7 + 3, C: 4 * 7 + 0 };

/**
 * Give every rest without one an explicit position on its staff's middle
 * line (<display-step>/<display-octave>), where OSMD would put it anyway.
 *
 * Works around an OSMD 1.9.0 bug: a rest in a second voice next to a
 * quarter-tone note (e.g. <alter>-0.5</alter>) gets a position derived from
 * that note's fractional pitch, and rendering throws ("reading
 * 'toLowerCase'"). Used only to retry after such a failure.
 */
export function pinRests(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return xml;
  for (const part of Array.from(doc.getElementsByTagName("part"))) {
    let middle = CLEF_REFERENCE.G; // treble until a clef says otherwise
    for (const el of Array.from(part.getElementsByTagName("*"))) {
      if (el.tagName === "clef") {
        const sign = el.getElementsByTagName("sign")[0]?.textContent?.trim() ?? "G";
        const line = Number(el.getElementsByTagName("line")[0]?.textContent ?? 2);
        const reference = CLEF_REFERENCE[sign];
        middle = reference === undefined ? CLEF_REFERENCE.G : reference + (3 - line) * 2;
      } else if (el.tagName === "rest" && !el.getElementsByTagName("display-step").length) {
        const step = doc.createElement("display-step");
        step.textContent = STEPS[((middle % 7) + 7) % 7];
        const octave = doc.createElement("display-octave");
        octave.textContent = String(Math.floor(middle / 7));
        el.append(step, octave);
      }
    }
  }
  return new XMLSerializer().serializeToString(doc);
}

async function renderScore(
  node: M5Node,
  el: HTMLDivElement,
  osmdRef: { current: OpenSheetMusicDisplay | null },
  xml: string,
) {
  const OSMD = await loadOSMD().catch((err) => {
    console.error("[m5.ScoreViewer] failed to load OSMD:", err);
    el.textContent = "Failed to render score: " + ((err as Error)?.message ?? err);
    return null;
  });
  if (!OSMD) return;

  const draw = async (musicxml: string) => {
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
    await osmdRef.current.load(musicxml);
    osmdRef.current.render();
  };

  try {
    try {
      await draw(xml);
    } catch (err) {
      // Retry once on a fresh OSMD with the rests pinned (see pinRests).
      console.warn("[m5.ScoreViewer] render failed, retrying with pinned rests:", err);
      osmdRef.current = null;
      el.innerHTML = "";
      await draw(pinRests(xml));
    }
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
