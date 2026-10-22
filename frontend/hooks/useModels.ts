"use client";

import { useEffect, useState } from "react";
import { fetchModels } from "@/lib/api";
import { MODELS, mergeModelCatalog, type ModelOption } from "@/lib/models";

export function useModels() {
  const [models, setModels] = useState<ModelOption[]>(MODELS);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const entries = await fetchModels(controller.signal);
        if (!controller.signal.aborted) setModels(mergeModelCatalog(entries));
      } catch {
        if (!controller.signal.aborted) setModels(MODELS.map((model) => ({
          ...model, reason: "Cannot verify models. Check the backend connection.",
        })));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  return models;
}
