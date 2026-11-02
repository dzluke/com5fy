// Frontend for the "Sequence Viewer" node (Python node_id "m5_SequenceViewer").
//
// The node returns ui = { sequence_data: [<payload>], pixels_per_second: [n] }
// from its execute(); renderSequence.ts draws it as proportional notation.
import { useEffect, useRef } from "react";

import { type M5Node } from "../common/node";
import { ScrollPane } from "../common/ScrollPane";
import { type SequenceData, renderSequence } from "./renderSequence";

export interface SequenceViewerProps {
  node: M5Node;
  data: SequenceData | null;
  pixelsPerSecond: number;
  /** Bumped on every execution, so re-running always re-renders. */
  run: number;
}

export function SequenceViewer({ node, data, pixelsPerSecond, run }: SequenceViewerProps) {
  // VexFlow draws straight into the pane, which React renders without
  // children, so React never touches the SVG.
  const pane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (data && pane.current) void renderSequence(node, pane.current, data, pixelsPerSecond);
  }, [node, data, pixelsPerSecond, run]);

  return <ScrollPane ref={pane} />;
}
