"use client";

import { useState } from "react";
import type { RefObject } from "react";

interface ScreenshotPanelProps {
  svgRef: RefObject<SVGSVGElement> | null;
  shareCode: string | null;
  onClose: () => void;
}

type ExportScale = 1 | 2 | 4;

const DATA_SOURCES = "FEC · Congress.gov · OpenStates";

export function ScreenshotPanel({ svgRef, shareCode, onClose }: ScreenshotPanelProps) {
  const [exporting, setExporting] = useState<ExportScale | null>(null);

  async function handleDownload(scale: ExportScale) {
    const svgEl = svgRef?.current;
    if (!svgEl || exporting) return;
    setExporting(scale);
    try {
      await exportGraphPng(svgEl, scale, shareCode);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="w-80 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-white">Download Screenshot</h3>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Share code nudge */}
        {!shareCode && (
          <div className="flex items-start gap-2.5 rounded-lg bg-amber-950/40 border border-amber-800/40 px-3 py-2.5">
            <svg className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-xs text-amber-400/90 leading-relaxed">
              Generate a share code first so the watermark URL links back to this graph.
            </p>
          </div>
        )}

        {/* Watermark preview */}
        <div className="rounded-lg bg-gray-800/60 border border-gray-700/50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-700/50">
            <p className="text-xs text-gray-500">Watermark included on every export</p>
          </div>
          <div className="px-3 py-2.5 space-y-1">
            <p className="text-xs font-mono text-gray-300">
              civitics.com/graph/{shareCode ?? "—"}
            </p>
            <p className="text-xs font-mono text-gray-500">Data: {DATA_SOURCES}</p>
            <p className="text-xs font-mono text-gray-500">
              Generated: {new Date().toLocaleDateString("en-US", {
                year: "numeric", month: "short", day: "numeric",
              })}
            </p>
          </div>
        </div>

        <p className="text-xs text-gray-500 leading-relaxed">
          Every shared screenshot carries a URL back to this graph.
          That link is how new users discover the platform.
        </p>

        {/* Export buttons */}
        <div className="space-y-2">
          <button
            onClick={() => handleDownload(1)}
            disabled={exporting !== null}
            className="w-full py-2.5 text-xs font-medium rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-2"
          >
            {exporting === 1 ? <Spinner /> : <DownloadIcon />}
            Download PNG — 1× (screen)
          </button>
          <button
            onClick={() => handleDownload(2)}
            disabled={exporting !== null}
            className="w-full py-2.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-2"
          >
            {exporting === 2 ? <Spinner /> : <DownloadIcon />}
            Download PNG — 2× (retina)
          </button>
          <button
            onClick={() => handleDownload(4)}
            disabled={exporting !== null}
            className="w-full py-2.5 text-xs font-medium rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-400 hover:text-white transition-colors flex items-center justify-center gap-2"
          >
            {exporting === 4 ? <Spinner /> : <DownloadIcon />}
            Download PNG — 4× (print quality)
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Export logic ────────────────────────────────────────────────────────────

async function exportGraphPng(
  svgEl: SVGSVGElement,
  scale: ExportScale,
  shareCode: string | null
): Promise<void> {
  // Capture the physical pixel dimensions from the DOM
  const rect = svgEl.getBoundingClientRect();
  const srcW = rect.width || svgEl.clientWidth || 900;
  const srcH = rect.height || svgEl.clientHeight || 600;
  const outW = Math.round(srcW * scale);
  const outH = Math.round(srcH * scale);

  // Clone SVG and set explicit dimensions so the browser renders correctly
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(srcW));
  clone.setAttribute("height", String(srcH));
  clone.setAttribute("viewBox", `0 0 ${srcW} ${srcH}`);

  // Set background on clone (the real SVG is transparent over the dark page)
  const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bgRect.setAttribute("width", "100%");
  bgRect.setAttribute("height", "100%");
  bgRect.setAttribute("fill", "#030712");
  clone.insertBefore(bgRect, clone.firstChild);

  const svgData = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);

  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = outW;
        canvas.height = outH;

        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("No 2d context")); return; }

        // Draw dark background (belt-and-suspenders)
        ctx.fillStyle = "#030712";
        ctx.fillRect(0, 0, outW, outH);

        // Draw the graph
        ctx.drawImage(img, 0, 0, outW, outH);

        // Watermark — non-removable, bottom-right
        drawWatermark(ctx, outW, outH, shareCode, scale);

        canvas.toBlob((pngBlob) => {
          URL.revokeObjectURL(objectUrl);
          if (!pngBlob) { reject(new Error("PNG blob failed")); return; }
          const link = document.createElement("a");
          link.href = URL.createObjectURL(pngBlob);
          link.download = `civitics-graph-${shareCode ?? "export"}${scale > 1 ? `@${scale}x` : ""}.png`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 5000);
          resolve();
        }, "image/png");
      } catch (e) {
        URL.revokeObjectURL(objectUrl);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("SVG image load failed"));
    };
    img.src = objectUrl;
  });
}

function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  shareCode: string | null,
  scale: ExportScale
) {
  const s = scale;
  const pad = 16 * s;
  const lineGap = 16 * s;
  const fontSize = 11 * s;

  ctx.save();
  ctx.font = `${fontSize}px 'Courier New', monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";

  const lines = [
    `civitics.com/graph/${shareCode ?? "—"}`,
    `Data: ${DATA_SOURCES}`,
    `Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
  ];

  const lineWidths = lines.map((l) => ctx.measureText(l).width);
  const maxW = Math.max(...lineWidths);
  const boxW = maxW + 20 * s;
  const boxH = lineGap * lines.length + 14 * s;
  const boxX = width - boxW - pad;
  const boxY = height - boxH - pad;

  // Background pill
  ctx.fillStyle = "rgba(3, 7, 18, 0.82)";
  roundRect(ctx, boxX, boxY, boxW, boxH, 6 * s);
  ctx.fill();

  // Subtle border
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1 * s;
  roundRect(ctx, boxX, boxY, boxW, boxH, 6 * s);
  ctx.stroke();

  // Text
  lines.forEach((line, i) => {
    const y = height - pad - (lines.length - 1 - i) * lineGap - 7 * s;
    const x = width - pad - 10 * s;
    ctx.fillStyle = i === 0 ? "#e5e7eb" : "#6b7280";
    ctx.fillText(line, x, y);
  });

  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function Spinner() {
  return (
    <div className="w-3.5 h-3.5 rounded-full border border-current border-t-transparent animate-spin" />
  );
}

function DownloadIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}
