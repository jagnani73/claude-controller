import { useEffect, useReducer, useRef } from "react";
import { ApprovalCard } from "@/components/messages/ApprovalCard";
import { AssistantMessage } from "@/components/messages/AssistantMessage";
import { ToolCallCard } from "@/components/messages/ToolCallCard";
import { UserMessage } from "@/components/messages/UserMessage";
import { useWsMessage } from "@/hooks/use-ws";

type StreamItem =
  | {
      kind: "user";
      id: string;
      sessionId: string;
      text: string;
      timestamp: string;
    }
  | {
      kind: "assistant";
      id: string;
      sessionId: string;
      text: string;
      timestamp: string;
    }
  | {
      kind: "tool";
      id: string; // toolUseId
      sessionId: string;
      toolName: string;
      input: unknown;
      result: { value: unknown; isError: boolean } | null;
    }
  | {
      kind: "approval";
      id: string; // toolUseId
      sessionId: string;
      toolName: string;
      toolInput: unknown;
      resolved?: "allow" | "deny";
    };

type Action =
  | { type: "clear" }
  | {
      type: "user_prompt";
      sessionId: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "assistant_text";
      sessionId: string;
      turnId: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "tool_call";
      sessionId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      sessionId: string;
      toolUseId: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "approval_request";
      sessionId: string;
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
    }
  | {
      type: "approval_resolved";
      toolUseId: string;
      decision: "allow" | "deny";
    };

function reducer(state: StreamItem[], action: Action): StreamItem[] {
  switch (action.type) {
    case "clear":
      return [];
    case "user_prompt":
      // Dedup on identical content within the same second
      if (
        state.some(
          (it) =>
            it.kind === "user" && it.text === action.text && it.sessionId === action.sessionId,
        )
      ) {
        return state;
      }
      return [
        ...state,
        {
          kind: "user",
          id: `u-${action.timestamp}-${state.length}`,
          sessionId: action.sessionId,
          text: action.text,
          timestamp: action.timestamp,
        },
      ];
    case "assistant_text": {
      const id = `a-${action.turnId}-${state.length}`;
      if (
        state.some(
          (it) =>
            it.kind === "assistant" && it.text === action.text && it.sessionId === action.sessionId,
        )
      ) {
        return state;
      }
      return [
        ...state,
        {
          kind: "assistant",
          id,
          sessionId: action.sessionId,
          text: action.text,
          timestamp: action.timestamp,
        },
      ];
    }
    case "tool_call":
      if (state.some((it) => it.kind === "tool" && it.id === action.toolUseId)) {
        return state;
      }
      return [
        ...state,
        {
          kind: "tool",
          id: action.toolUseId,
          sessionId: action.sessionId,
          toolName: action.toolName,
          input: action.input,
          result: null,
        },
      ];
    case "tool_result":
      return state.map((it) =>
        it.kind === "tool" && it.id === action.toolUseId
          ? {
              ...it,
              result: {
                value: action.result,
                isError: action.isError,
              },
            }
          : it,
      );
    case "approval_request":
      if (state.some((it) => it.kind === "approval" && it.id === action.toolUseId)) {
        return state;
      }
      return [
        ...state,
        {
          kind: "approval",
          id: action.toolUseId,
          sessionId: action.sessionId,
          toolName: action.toolName,
          toolInput: action.toolInput,
        },
      ];
    case "approval_resolved":
      return state.map((it) =>
        it.kind === "approval" && it.id === action.toolUseId
          ? { ...it, resolved: action.decision }
          : it,
      );
  }
}

interface MessageStreamProps {
  sessionId: string;
}

export function MessageStream({ sessionId }: MessageStreamProps) {
  const [items, dispatch] = useReducer(reducer, []);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset when switching sessions
  useEffect(() => {
    dispatch({ type: "clear" });
  }, []);

  useWsMessage("user_prompt", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "user_prompt",
      sessionId: msg.sessionId,
      text: msg.text,
      timestamp: msg.timestamp,
    });
  });

  useWsMessage("assistant_text", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "assistant_text",
      sessionId: msg.sessionId,
      turnId: msg.turnId,
      text: msg.text,
      timestamp: msg.timestamp,
    });
  });

  useWsMessage("tool_call", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "tool_call",
      sessionId: msg.sessionId,
      toolUseId: msg.toolUseId,
      toolName: msg.name,
      input: msg.input,
    });
  });

  useWsMessage("tool_result", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "tool_result",
      sessionId: msg.sessionId,
      toolUseId: msg.toolUseId,
      result: msg.result,
      isError: msg.isError,
    });
  });

  useWsMessage("approval_request", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "approval_request",
      sessionId: msg.sessionId,
      toolUseId: msg.toolUseId,
      toolName: msg.toolName,
      toolInput: msg.toolInput,
    });
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on any new item
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [items]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto bg-neutral-950">
      {items.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-neutral-600">
          Waiting for session to start…
        </div>
      ) : (
        items.map((item) => {
          switch (item.kind) {
            case "user":
              return <UserMessage key={item.id} text={item.text} timestamp={item.timestamp} />;
            case "assistant":
              return <AssistantMessage key={item.id} text={item.text} timestamp={item.timestamp} />;
            case "tool":
              return (
                <ToolCallCard
                  key={item.id}
                  toolName={item.toolName}
                  input={item.input}
                  result={item.result}
                />
              );
            case "approval":
              return (
                <ApprovalCard
                  key={item.id}
                  sessionId={item.sessionId}
                  toolUseId={item.id}
                  toolName={item.toolName}
                  toolInput={item.toolInput}
                  resolved={item.resolved}
                />
              );
            default:
              return null;
          }
        })
      )}
    </div>
  );
}
