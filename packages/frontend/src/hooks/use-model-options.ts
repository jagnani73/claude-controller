import { latestModelByFamily } from "common/model";
import { useMemo } from "react";
import { modelOptionsWithHints } from "@/components/sessions/model-config";
import { useSessions } from "./use-sessions";

/**
 * The model picker's options, each alias hinted with the newest model of its
 * family observed across all sessions (`currentModelId`). Families never
 * observed get no version hint.
 */
export function useModelOptions() {
  const { sessions } = useSessions();
  return useMemo(
    () => modelOptionsWithHints(latestModelByFamily(sessions.map((s) => s.currentModelId))),
    [sessions],
  );
}
