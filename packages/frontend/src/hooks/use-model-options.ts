import { latestModelByFamily } from "common/model";
import type { ClaudeModel, ModelCatalog } from "common/types";
import { useMemo, useState } from "react";
import { modelOptionsWithHints } from "@/components/sessions/model-config";
import { useSessions } from "./use-sessions";
import { useWsMessage } from "./use-ws";

const EMPTY_CATALOG: ModelCatalog = { aliases: [], modelIds: [] };

/**
 * The model picker's options: the documented aliases, every alias the backend
 * has learned at runtime (`model_catalog`), and `current` (the session's own
 * value, which may be a full model id the backend corrected to) if neither lists
 * it. Each alias is hinted with the newest model of its family observed across
 * all sessions (`currentModelId`) and by the backend; families never observed
 * get no version hint.
 */
export function useModelOptions(current?: ClaudeModel) {
  const { sessions } = useSessions();
  const [catalog, setCatalog] = useState<ModelCatalog>(EMPTY_CATALOG);
  // Sticky on the socket, so a picker opened after connect still gets it.
  useWsMessage("model_catalog", (msg) => setCatalog(msg.catalog));
  return useMemo(() => {
    const latest = latestModelByFamily([
      ...catalog.modelIds,
      ...sessions.map((s) => s.currentModelId),
    ]);
    const extra = current ? [...catalog.aliases, current] : catalog.aliases;
    return modelOptionsWithHints(latest, extra);
  }, [sessions, catalog, current]);
}
