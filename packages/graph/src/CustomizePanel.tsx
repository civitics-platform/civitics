"use client";

import type { VisualConfig } from "./index";

export interface CustomizePanelProps {
  config: VisualConfig;
  onChange: (config: VisualConfig) => void;
  onClose: () => void;
}

const NODE_SIZE_LABELS: Record<VisualConfig["nodeSizeEncoding"], string> = {
  connection_count: "Connection count (default)",
  donation_total:   "Total donations received",
  votes_cast:       "Votes cast",
  bills_sponsored:  "Bills sponsored",
  years_in_office:  "Years in office",
  uniform:          "Uniform (all same size)",
};

const NODE_COLOR_LABELS: Record<VisualConfig["nodeColorEncoding"], string> = {
  entity_type:       "Entity type (default)",
  party_affiliation: "Party affiliation",
  industry_sector:   "Industry / sector",
  state_region:      "State / region",
  single_color:      "Single color",
};

const EDGE_THICKNESS_LABELS: Record<VisualConfig["edgeThicknessEncoding"], string> = {
  amount_proportional:   "Proportional to amount (default)",
  strength_proportional: "Proportional to strength",
  uniform:               "Uniform",
};

export function CustomizePanel({ config, onChange, onClose }: CustomizePanelProps) {
  function update<K extends keyof VisualConfig>(key: K, value: VisualConfig[K]) {
    onChange({ ...config, [key]: value });
  }

  return (
    <div className="w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
          Customize
        </h3>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="overflow-y-auto flex-1 p-4 space-y-5">

        {/* Node Size */}
        <PanelSection label="Node size represents">
          {(Object.keys(NODE_SIZE_LABELS) as VisualConfig["nodeSizeEncoding"][]).map((v) => (
            <RadioOption
              key={v}
              name="nodeSize"
              value={v}
              current={config.nodeSizeEncoding}
              label={NODE_SIZE_LABELS[v]}
              onChange={() => update("nodeSizeEncoding", v)}
            />
          ))}
        </PanelSection>

        {/* Node Color */}
        <PanelSection label="Node color represents">
          {(Object.keys(NODE_COLOR_LABELS) as VisualConfig["nodeColorEncoding"][]).map((v) => (
            <RadioOption
              key={v}
              name="nodeColor"
              value={v}
              current={config.nodeColorEncoding}
              label={NODE_COLOR_LABELS[v]}
              onChange={() => update("nodeColorEncoding", v)}
            />
          ))}
          {config.nodeColorEncoding === "single_color" && (
            <div className="flex items-center gap-2 mt-2 pl-5">
              <input
                type="color"
                value={config.singleColor}
                onChange={(e) => update("singleColor", e.target.value)}
                className="w-8 h-8 rounded border border-gray-700 cursor-pointer bg-transparent"
              />
              <span className="text-xs text-gray-400 font-mono">{config.singleColor}</span>
            </div>
          )}
        </PanelSection>

        {/* Edge Appearance */}
        <PanelSection label="Edge thickness">
          {(Object.keys(EDGE_THICKNESS_LABELS) as VisualConfig["edgeThicknessEncoding"][]).map((v) => (
            <RadioOption
              key={v}
              name="edgeThickness"
              value={v}
              current={config.edgeThicknessEncoding}
              label={EDGE_THICKNESS_LABELS[v]}
              onChange={() => update("edgeThicknessEncoding", v)}
            />
          ))}
          <div className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Edge opacity</span>
              <span className="text-xs text-gray-500 font-mono">
                {Math.round(config.edgeOpacity * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={config.edgeOpacity}
              onChange={(e) => update("edgeOpacity", parseFloat(e.target.value))}
              className="w-full accent-indigo-500"
            />
          </div>
        </PanelSection>

        {/* Layout */}
        <PanelSection label="Graph layout">
          <div className="flex rounded-md overflow-hidden border border-gray-700 mt-1">
            {(["force", "radial", "circular"] as const).map((v) => (
              <button
                key={v}
                onClick={() => update("layout", v)}
                className={`flex-1 py-1.5 text-xs font-medium capitalize transition-colors ${
                  config.layout === v
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:text-white"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </PanelSection>

        {/* Theme */}
        <PanelSection label="Theme">
          <div className="flex rounded-md overflow-hidden border border-gray-700 mt-1">
            {(["dark", "light", "print"] as const).map((v) => (
              <button
                key={v}
                onClick={() => update("theme", v)}
                className={`flex-1 py-1.5 text-xs font-medium capitalize transition-colors ${
                  config.theme === v
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:text-white"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </PanelSection>
      </div>

      {/* Reset */}
      <div className="border-t border-gray-800 px-4 py-3 shrink-0">
        <button
          onClick={() => onChange({
            nodeSizeEncoding: "connection_count",
            nodeColorEncoding: "entity_type",
            singleColor: "#3b82f6",
            edgeThicknessEncoding: "amount_proportional",
            edgeOpacity: 0.7,
            layout: "force",
            theme: "dark",
          })}
          className="w-full py-2 text-xs font-medium rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

function PanelSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</p>
      {children}
    </div>
  );
}

function RadioOption({
  name, value, current, label, onChange,
}: {
  name: string; value: string; current: string; label: string; onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer group">
      <input
        type="radio"
        name={name}
        value={value}
        checked={current === value}
        onChange={onChange}
        className="accent-indigo-500 shrink-0"
      />
      <span className={`text-xs ${current === value ? "text-gray-200" : "text-gray-400 group-hover:text-gray-300"}`}>
        {label}
      </span>
    </label>
  );
}
