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
import { AudioPlayback, CONTROLS_HEIGHT, MIN_WAVEFORM_HEIGHT } from "./AudioPlayback";
import { Player } from "./Player";

interface AudioRef {
  filename: string;
  subfolder?: string;
  type: string;
}

interface AudioNode extends M5Node {
  _m5Player?: Player;
  _m5PlayerRoot?: Root;
}

function viewURL({ filename, subfolder = "", type }: AudioRef): string {
  const params = new URLSearchParams({ filename, subfolder, type });
  // Temp files can be rewritten under the same name; don't let the browser
  // serve a stale copy.
  if (type === "temp") params.set("rand", String(Math.random()));
  return api.apiURL(`/view?${params}`);
}

app.registerExtension({
  name: "m5.AudioPlayback",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "m5_AudioPlayback") return;
    const proto = nodeType.prototype as unknown as NodePrototype<AudioNode>;

    chainCallback(proto, "onNodeCreated", function () {
      const player = new Player(this);
      const host = createWidgetHost();
      const root = createRoot(host);
      flushSync(() => root.render(<AudioPlayback player={player} />));
      this._m5Player = player;
      this._m5PlayerRoot = root;
      this.addDOMWidget("waveform", "div", host, {
        serialize: false,
        getMinHeight: () => MIN_WAVEFORM_HEIGHT + CONTROLS_HEIGHT,
      });
      player.clear("Run the node to play its audio.");

      this.size[0] = Math.max(this.size[0], 480);
      this.size[1] = Math.max(this.size[1], 240);
    });

    // Restore the spectrogram toggle saved with the workflow.
    chainCallback(proto, "onConfigure", function () {
      this._m5Player?.setSpectrogramVisible(this.properties?.m5ShowSpectrogram, false);
    });

    chainCallback(proto, "onExecuted", function (message) {
      const ref = message?.playback_audio?.[0] as AudioRef | undefined;
      if (ref) void this._m5Player?.load(viewURL(ref));
    });

    chainCallback(
      proto,
      "onRemoved",
      function () {
        this._m5Player?.destroy();
        this._m5PlayerRoot?.unmount();
        this._m5PlayerRoot = undefined;
      },
      { before: true },
    );
  },
});
