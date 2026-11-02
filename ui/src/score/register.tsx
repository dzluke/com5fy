import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";

import { app } from "/scripts/app.js";

import {
  type M5Node,
  type NodePrototype,
  chainCallback,
  createWidgetHost,
} from "../common/node";
import { ScoreViewer } from "./ScoreViewer";

interface ScoreNode extends M5Node {
  _m5Score?: { root: Root; run: number };
  _m5PendingXml?: string | null;
}

function show(node: ScoreNode, xml: string) {
  const s = node._m5Score!;
  s.run += 1;
  s.root.render(<ScoreViewer node={node} xml={xml} run={s.run} />);
}

app.registerExtension({
  name: "m5.ScoreViewer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "m5_ScoreViewer") return;
    const proto = nodeType.prototype as unknown as NodePrototype<ScoreNode>;

    chainCallback(proto, "onNodeCreated", function () {
      const host = createWidgetHost();
      const root = createRoot(host);
      flushSync(() => root.render(<ScoreViewer node={this} xml={null} run={0} />));

      // getMinHeight lets the user drag the node shorter than the score (the
      // overflow scrollbars then reveal the rest); without it ComfyUI's default
      // DOM-widget minimum would keep the node tall.
      this.addDOMWidget("score", "div", host, {
        serialize: false,
        getMinHeight: () => 48,
      });
      this._m5Score = { root, run: 0 };

      // Starting width; the height is taken over by fitNodeHeight() once a
      // score is rendered.
      this.size[0] = Math.max(this.size[0], 420);
      this.size[1] = Math.max(this.size[1], 240);

      // If we already received a score before the widget existed, render it now.
      if (this._m5PendingXml) {
        show(this, this._m5PendingXml);
        this._m5PendingXml = null;
      }
    });

    chainCallback(proto, "onExecuted", function (message) {
      const xml = message?.musicxml?.[0] as string | undefined;
      if (!xml) return;
      if (this._m5Score) show(this, xml);
      else this._m5PendingXml = xml; // onNodeCreated will pick it up
    });

    chainCallback(proto, "onRemoved", function () {
      this._m5Score?.root.unmount();
      this._m5Score = undefined;
    });
  },
});
