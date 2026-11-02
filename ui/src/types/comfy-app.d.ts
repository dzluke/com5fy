// Types for ComfyUI's /scripts/app.js (mapped in tsconfig "paths"). The module
// itself is external to our bundle (see vite.config.ts): the running ComfyUI
// frontend serves it. The absolute path is used, not a relative one, because
// custom-node modules are served from a multi-segment /extensions/... route.
import type { ComfyApp } from "@comfyorg/comfyui-frontend-types";

export declare const app: ComfyApp;
