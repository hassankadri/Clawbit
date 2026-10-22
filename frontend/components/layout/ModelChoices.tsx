"use client";

import { Check } from "lucide-react";
import { PROVIDER_LABELS, confirmModelSelection, type ModelOption } from "@/lib/models";

export default function ModelChoices({ models, selected, onSelect }: {
  models: ModelOption[]; selected: string; onSelect: (id: string) => void;
}) {
  return <div className="max-h-[min(65vh,440px)] space-y-2 overflow-y-auto">
    {Object.entries(PROVIDER_LABELS).map(([provider, label]) => <div key={provider}>
      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      {models.filter((model) => model.provider === provider).map((model) => <button
        key={model.id} type="button" disabled={!model.available}
        title={model.reason} aria-pressed={selected === model.id}
        onClick={() => { if (confirmModelSelection(model)) onSelect(model.id); }}
        className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 text-left transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/5"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{model.label}</span>
          <span className="mt-0.5 block text-[11px] text-zinc-500">{model.available ? model.description : model.reason}</span>
        </span>
        {selected === model.id && <Check size={16} className="shrink-0" />}
      </button>)}
    </div>)}
  </div>;
}
