"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setAgentEnabledAction, type TeamActionState } from "@/modules/agents/actions/team";

export function AgentSwitch({ agentKey, enabled }: { agentKey: string; enabled: boolean }) {
  const [state, run, pending] = useActionState<TeamActionState, FormData>(
    setAgentEnabledAction,
    {},
  );
  return (
    <form action={run} className="flex items-center gap-2">
      <input type="hidden" name="agentKey" value={agentKey} />
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {enabled ? "Switch off" : "Switch on"}
      </Button>
      {state.error ? (
        <span role="alert" className="text-destructive text-xs">
          {state.error}
        </span>
      ) : state.ok ? (
        <span role="status" className="text-muted-foreground text-xs">
          {state.ok}
        </span>
      ) : null}
    </form>
  );
}
