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

interface SequenceNode extends M5Node {
  _m5Seq?: { root: Root; run: number };
  _m5PendingSeq?: { data: SequenceData; pps: number } | null;
}

function show(node: SequenceNode, data: SequenceData, pps: number) {
  const s = node._m5Seq!;
  s.run += 1;
  s.root.render(<SequenceViewer node={node} data={data} pixelsPerSecond={pps} run={s.run} />);
}

app.registerExtension({
  name: "m5.SequenceViewer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "m5_SequenceViewer") return;
    const proto = nodeType.prototype as unknown as NodePrototype<SequenceNode>;

    chainCallback(proto, "onNodeCreated", function () {
      const host = createWidgetHost();
      const root = createRoot(host);
      flushSync(() =>
        root.render(<SequenceViewer node={this} data={null} pixelsPerSecond={120} run={0} />),
      );

      this.addDOMWidget("sequence", "div", host, {
        serialize: false,
        getMinHeight: () => 48,
      });
      this._m5Seq = { root, run: 0 };

      this.size[0] = Math.max(this.size[0], 480);
      this.size[1] = Math.max(this.size[1], 240);

      // If a payload arrived before the widget existed, render it now.
      if (this._m5PendingSeq) {
        show(this, this._m5PendingSeq.data, this._m5PendingSeq.pps);
        this._m5PendingSeq = null;
      }
    });

    chainCallback(proto, "onExecuted", function (message) {
      const data = message?.sequence_data?.[0] as SequenceData | undefined;
      if (!data) return;
      const pps = (message?.pixels_per_second?.[0] as number | undefined) ?? 120;
      if (this._m5Seq) show(this, data, pps);
      else this._m5PendingSeq = { data, pps }; // onNodeCreated will pick it up
    });

    chainCallback(proto, "onRemoved", function () {
      this._m5Seq?.root.unmount();
      this._m5Seq = undefined;
    });
  },
});
