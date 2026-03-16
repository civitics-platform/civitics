"use client";

import { useState } from "react";

interface GraphStateSnapshot {
  preset: string;
  edgeTypes: string[] | null;
  minStrength?: number;
  nodeCount: number;
  edgeCount: number;
  // Extended state for new components
  centerEntityId?: string;
  centerEntityType?: string;
  depth?: number;
  activeFilters?: string[] | null;
  visualConfig?: Record<string, unknown>;
}

interface SharePanelProps {
  graphState: GraphStateSnapshot;
  onCodeGenerated: (code: string) => void;
  onClose: () => void;
}

type PanelState = "idle" | "loading" | "done" | "error";

export function SharePanel({ graphState, onCodeGenerated, onClose }: SharePanelProps) {
  const [state, setState] = useState<PanelState>("idle");
  const [code, setCode] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    setState("loading");
    try {
      const res = await fetch("/api/graph/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: graphState,
          preset: graphState.preset,
          title: `${graphState.preset.replace(/_/g, " ")} — ${graphState.nodeCount} entities`,
        }),
      });
      const data = await res.json() as { code?: string; url?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Unknown error");
      setCode(data.code ?? null);
      setUrl(data.url ?? null);
      setState("done");
      if (data.code) onCodeGenerated(data.code);
    } catch {
      setState("error");
    }
  }

  async function handleCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback for browsers that block clipboard
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="w-80 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-white">Share this graph</h3>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="p-4">
        {state !== "done" && (
          <>
            <p className="text-xs text-gray-400 leading-relaxed mb-4">
              Generate a permanent code for this graph view. Anyone with the code
              can restore it exactly — preset, filters, and all.
            </p>

            {/* Current state summary */}
            <div className="rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-2.5 mb-4 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Preset</span>
                <span className="text-gray-300 capitalize">
                  {graphState.preset.replace(/_/g, " ")}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Entities</span>
                <span className="text-gray-300">{graphState.nodeCount}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Connections</span>
                <span className="text-gray-300">{graphState.edgeCount}</span>
              </div>
            </div>

            {state === "error" && (
              <p className="text-xs text-red-400 mb-3">
                Something went wrong. Try again.
              </p>
            )}

            <button
              onClick={handleGenerate}
              disabled={state === "loading"}
              className="w-full py-2.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors flex items-center justify-center gap-2"
            >
              {state === "loading" ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border border-white border-t-transparent animate-spin" />
                  Generating…
                </>
              ) : (
                "Generate Share Code"
              )}
            </button>
          </>
        )}

        {state === "done" && code && url && (
          <div className="space-y-4">
            {/* Code display */}
            <div className="text-center">
              <p className="text-xs text-gray-500 mb-2">Your share code</p>
              <div className="inline-block px-5 py-2.5 rounded-lg bg-gray-800 border border-gray-700">
                <span className="text-lg font-mono font-bold text-indigo-300 tracking-widest">
                  {code}
                </span>
              </div>
            </div>

            {/* Copy URL */}
            <div className="rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-2">
              <p className="text-xs text-gray-500 font-mono truncate">{url}</p>
            </div>

            <button
              onClick={handleCopy}
              className={`w-full py-2.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-2 ${
                copied
                  ? "bg-green-700 text-white"
                  : "bg-gray-700 hover:bg-gray-600 text-gray-200 hover:text-white"
              }`}
            >
              {copied ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy Link
                </>
              )}
            </button>

            <p className="text-xs text-gray-600 text-center leading-relaxed">
              This link is permanent. The graph state is stored on our servers
              and will load exactly as it appears now.
            </p>
          </div>
        )}
      </div>

      {/* Embed code section — shown after code generated */}
      {state === "done" && code && (
        <div className="border-t border-gray-800 px-4 py-3">
          <p className="text-xs text-gray-600 mb-2">Embed code</p>
          <div className="rounded bg-gray-800/60 border border-gray-700/30 px-2.5 py-2">
            <code className="text-xs text-gray-500 font-mono break-all">
              {`<iframe src="${url}" width="800" height="500" frameborder="0" />`}
            </code>
          </div>
        </div>
      )}
    </div>
  );
}
