// Frontend for the "Sequence Viewer" node (Python node_id "m5_SequenceViewer").
//
// The node returns ui = { sequence_data: [<payload>], zoom: [n] } from its
// execute(); renderSequence.ts draws it as proportional notation. The zoom
// widget also redraws it directly (register.tsx), without a new execution.
import { useEffect, useRef } from "react";

import { type M5Node } from "../common/node";
import { ScrollPane } from "../common/ScrollPane";
import { type SequenceData, renderSequence } from "./renderSequence";

export interface SequenceViewerProps {
  node: M5Node;
  data: SequenceData | null;
  /** Horizontal zoom: 1 = BASE_PIXELS_PER_SECOND. */
  zoom: number;
  /** Bumped on every execution, so re-running always re-renders. */
  run: number;
}

export function SequenceViewer({ node, data, zoom, run }: SequenceViewerProps) {
  // VexFlow draws straight into the pane, which React renders without
  // children, so React never touches the SVG.
  const pane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (data && pane.current) void renderSequence(node, pane.current, data, zoom);
  }, [node, data, zoom, run]);

  return <ScrollPane ref={pane} />;
}
