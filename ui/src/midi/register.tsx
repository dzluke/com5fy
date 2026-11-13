import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";

import { api } from "/scripts/api.js";
import { app } from "/scripts/app.js";

import {
  type M5Node,
  type NodePrototype,
  chainCallback,
  createWidgetHost,
} from "../common/node";
import { CONTROLS_HEIGHT, MIN_ROLL_HEIGHT, MidiViewer } from "./MidiViewer";
import { type MidiData, PianoRoll } from "./PianoRoll";

interface AudioRef {
  filename: string;
  subfolder?: string;
  type: string;
}

interface ZoomWidget {
  name: string;
  value: unknown;
  callback?: (value: unknown, ...rest: unknown[]) => unknown;
}

interface MidiNode extends M5Node {
  widgets?: ZoomWidget[];
  _m5Roll?: PianoRoll;
  _m5RollRoot?: Root;
}

function viewURL({ filename, subfolder = "", type }: AudioRef): string {
  const params = new URLSearchParams({ filename, subfolder, type });
  if (type === "temp") params.set("rand", String(Math.random()));
  return api.apiURL(`/view?${params}`);
}

function currentZoom(node: MidiNode): number {
  const value = Number(node.widgets?.find((w) => w.name === "zoom")?.value);
  return value > 0 ? value : 1;
}

app.registerExtension({
  name: "m5.MidiViewer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "m5_MidiViewer") return;
    const proto = nodeType.prototype as unknown as NodePrototype<MidiNode>;

    chainCallback(proto, "onNodeCreated", function () {
      const roll = new PianoRoll();
      const host = createWidgetHost();
      const root = createRoot(host);
      flushSync(() => root.render(<MidiViewer roll={roll} />));
      this._m5Roll = roll;
      this._m5RollRoot = root;
      this.addDOMWidget("piano_roll", "div", host, {
        serialize: false,
        getMinHeight: () => MIN_ROLL_HEIGHT + CONTROLS_HEIGHT,
      });

      // The zoom is a view setting: follow the widget live, no new run needed.
      const zoom = this.widgets?.find((w) => w.name === "zoom");
      if (zoom) {
        const original = zoom.callback;
        zoom.callback = (...args: [unknown, ...unknown[]]) => {
          const result = original?.apply(zoom, args);
          this._m5Roll?.setZoom(currentZoom(this));
          return result;
        };
      }

      this.size[0] = Math.max(this.size[0], 560);
      this.size[1] = Math.max(this.size[1], 320);
    });

    chainCallback(proto, "onConfigure", function () {
      this._m5Roll?.setZoom(currentZoom(this));
    });

    chainCallback(proto, "onExecuted", function (message) {
      const roll = this._m5Roll;
      const data = message?.midi_data?.[0] as MidiData | undefined;
      if (!roll || !data) return;
      roll.setZoom(currentZoom(this));
      roll.setData(data);
      const ref = message?.playback_audio?.[0] as AudioRef | undefined;
      void roll.load(ref ? viewURL(ref) : null);
    });

    chainCallback(
      proto,
      "onRemoved",
      function () {
        this._m5Roll?.destroy();
        this._m5RollRoot?.unmount();
        this._m5RollRoot = undefined;
      },
      { before: true },
    );
  },
});
