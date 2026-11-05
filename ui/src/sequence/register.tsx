import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";

import { app } from "/scripts/app.js";

import {
  type M5Node,
  type NodePrototype,
  chainCallback,
  createWidgetHost,
} from "../common/node";
import type { SequenceData } from "./renderSequence";
import { SequenceViewer } from "./SequenceViewer";

interface ZoomWidget {
  name: string;
  value: unknown;
  callback?: (value: unknown, ...rest: unknown[]) => unknown;
}

interface SequenceNode extends M5Node {
  widgets?: ZoomWidget[];
  _m5Seq?: { root: Root; run: number; data: SequenceData | null };
  _m5PendingSeq?: SequenceData | null;
}

/** The zoom widget's current value (1 if missing or invalid). */
function currentZoom(node: SequenceNode): number {
  const value = Number(node.widgets?.find((w) => w.name === "zoom")?.value);
  return value > 0 ? value : 1;
}

function show(node: SequenceNode, data: SequenceData | null, newRun = true) {
  const s = node._m5Seq!;
  s.data = data;
  if (newRun) s.run += 1;
  s.root.render(<SequenceViewer node={node} data={data} zoom={currentZoom(node)} run={s.run} />);
}

app.registerExtension({
  name: "m5.SequenceViewer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "m5_SequenceViewer") return;
    const proto = nodeType.prototype as unknown as NodePrototype<SequenceNode>;

    chainCallback(proto, "onNodeCreated", function () {
      const host = createWidgetHost();
      const root = createRoot(host);
      flushSync(() => root.render(<SequenceViewer node={this} data={null} zoom={1} run={0} />));

      this.addDOMWidget("sequence", "div", host, {
        serialize: false,
        getMinHeight: () => 48,
      });
      this._m5Seq = { root, run: 0, data: null };

      // Redraw as soon as the zoom changes: it is only a view setting, so it
      // shouldn't need the workflow to run again.
      const zoom = this.widgets?.find((w) => w.name === "zoom");
      if (zoom) {
        const original = zoom.callback;
        zoom.callback = (...args: [unknown, ...unknown[]]) => {
          const result = original?.apply(zoom, args);
          if (this._m5Seq?.data) show(this, this._m5Seq.data, false);
          return result;
        };
      }

      this.size[0] = Math.max(this.size[0], 480);
      this.size[1] = Math.max(this.size[1], 240);

      // If a payload arrived before the widget existed, render it now.
      if (this._m5PendingSeq) {
        show(this, this._m5PendingSeq);
        this._m5PendingSeq = null;
      }
    });

    chainCallback(proto, "onExecuted", function (message) {
      const data = message?.sequence_data?.[0] as SequenceData | undefined;
      if (!data) return;
      if (this._m5Seq) show(this, data);
      else this._m5PendingSeq = data; // onNodeCreated will pick it up
    });

    chainCallback(proto, "onRemoved", function () {
      this._m5Seq?.root.unmount();
      this._m5Seq = undefined;
    });
  },
});
