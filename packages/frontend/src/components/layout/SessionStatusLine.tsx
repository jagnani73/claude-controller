import { memo, useState } from "react";
import { useWsMessage } from "@/hooks/use-ws";
import { StatusLine } from "./StatusLine";

/** Keep frequent statusline paints local, rather than rerendering the chat/composer.
 * Keyed by sessionId at the call site so a new session starts blank before replay. */
export const SessionStatusLine = memo(function SessionStatusLine({
  sessionId,
}: {
  sessionId: string;
}) {
  const [text, setText] = useState("");
  useWsMessage("status_line", (msg) => {
    if (msg.sessionId === sessionId) setText(msg.text);
  });
  return <StatusLine text={text} />;
});
