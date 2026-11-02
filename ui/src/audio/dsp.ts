// Waveform peaks and spectrogram analysis for the Audio Playback node.

// Peak buckets computed once per decoded buffer. Drawing aggregates these to
// the canvas width, so resizing never has to rescan the raw samples.
const PEAK_BUCKETS = 4096;

// Spectrogram analysis: an FFT_SIZE-point Hann-windowed STFT sampled at up to
// SPEC_COLUMNS evenly spaced times, resampled onto SPEC_ROWS log-spaced
// frequencies from SPEC_MIN_HZ to Nyquist, and shown over a SPEC_RANGE_DB range
// below the loudest bin. Like the peaks, it is computed once per buffer and
// only scaled when drawn.
const FFT_SIZE = 4096;
const SPEC_COLUMNS = 1024;
const SPEC_ROWS = 256;
const SPEC_MIN_HZ = 30;
const SPEC_RANGE_DB = 80;
const SPEC_TICKS_HZ = [100, 1000, 10000];

// Magma-like colormap stops (quiet -> loud), expanded into a 256-entry LUT.
const SPEC_COLOR_STOPS = [
  [0, 0, 4],
  [59, 15, 112],
  [140, 41, 129],
  [222, 73, 104],
  [254, 159, 109],
  [252, 253, 191],
];
const SPEC_LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  const segments = SPEC_COLOR_STOPS.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * segments;
    const s = Math.min(Math.floor(t), segments - 1);
    const f = t - s;
    for (let k = 0; k < 3; k++) {
      const a = SPEC_COLOR_STOPS[s][k];
      const b = SPEC_COLOR_STOPS[s + 1][k];
      lut[i * 3 + k] = a + (b - a) * f;
    }
  }
  return lut;
})();

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
}

export interface Spectrogram {
  canvas: HTMLCanvasElement;
  ticks: { label: string; frac: number }[];
}

// Min/max over PEAK_BUCKETS equal slices of the buffer, taken across all
// channels so multichannel audio draws as one waveform.
export function computePeaks(buffer: AudioBuffer): Peaks {
  const buckets = Math.min(PEAK_BUCKETS, buffer.length) || 1;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor((b * data.length) / buckets);
      const end = Math.max(start + 1, Math.floor(((b + 1) * data.length) / buckets));
      let lo = min[b];
      let hi = max[b];
      for (let i = start; i < end && i < data.length; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo;
      max[b] = hi;
    }
  }
  return { min, max };
}

// In-place iterative radix-2 FFT of (re, im); length must be a power of two.
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let uRe = 1;
      let uIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = re[b] * uRe - im[b] * uIm;
        const tIm = re[b] * uIm + im[b] * uRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const next = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = next;
      }
    }
  }
}

// Render the spectrogram of the buffer's mono mixdown into a small canvas
// (one pixel per analysis column x log-frequency row, high frequencies at the
// top), which the player then scales into place.
export function computeSpectrogram(buffer: AudioBuffer): Spectrogram {
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }

  const columns = Math.max(1, Math.min(SPEC_COLUMNS, Math.ceil(length / 256)));
  const bins = FFT_SIZE / 2;
  const nyquist = buffer.sampleRate / 2;
  const minHz = Math.min(SPEC_MIN_HZ, nyquist / 2);
  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  // Fractional FFT bin sampled by each output row, lowest frequency last.
  const rowBin = new Float32Array(SPEC_ROWS);
  for (let y = 0; y < SPEC_ROWS; y++) {
    const hz = minHz * Math.pow(nyquist / minHz, 1 - y / (SPEC_ROWS - 1));
    rowBin[y] = Math.min(bins - 1, (hz / nyquist) * bins);
  }

  const db = new Float32Array(columns * SPEC_ROWS);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mag = new Float32Array(bins);
  let peakDb = -Infinity;
  for (let x = 0; x < columns; x++) {
    const center = Math.floor(((x + 0.5) * length) / columns);
    const start = center - FFT_SIZE / 2;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < length ? mono[s] * hann[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let y = 0; y < SPEC_ROWS; y++) {
      const k = Math.floor(rowBin[y]);
      const f = rowBin[y] - k;
      const m = mag[k] * (1 - f) + mag[Math.min(k + 1, bins - 1)] * f;
      const v = 20 * Math.log10(m + 1e-12);
      db[y * columns + x] = v;
      if (v > peakDb) peakDb = v;
    }
  }

  const image = new ImageData(columns, SPEC_ROWS);
  for (let i = 0; i < db.length; i++) {
    const t = (db[i] - (peakDb - SPEC_RANGE_DB)) / SPEC_RANGE_DB;
    const c = Math.round(Math.max(0, Math.min(1, t)) * 255) * 3;
    image.data[i * 4] = SPEC_LUT[c];
    image.data[i * 4 + 1] = SPEC_LUT[c + 1];
    image.data[i * 4 + 2] = SPEC_LUT[c + 2];
    image.data[i * 4 + 3] = 255;
  }
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = SPEC_ROWS;
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  // Height fraction (from the top) of each labelled frequency within range.
  const ticks = SPEC_TICKS_HZ.filter((hz) => hz > minHz && hz < nyquist).map((hz) => ({
    label: hz >= 1000 ? `${hz / 1000}k` : `${hz}`,
    frac: 1 - Math.log(hz / minHz) / Math.log(nyquist / minHz),
  }));
  return { canvas, ticks };
}
