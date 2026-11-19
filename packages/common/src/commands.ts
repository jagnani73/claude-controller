import { isClaudeModel, isEffortLevel } from "./types/index.js";

export type CommandSupport = "native" | "forwarded" | "dialog" | "transition" | "unverified";
export interface CommandEntry {
  id: string;
  name: string;
  description: string;
  argumentHint?: string;
  support: CommandSupport;
  source: "docs" | "skill" | "legacy-command";
  scope: "builtin" | "user" | "project";
}
export type CommandCatalogRequest = {
  type: "command_catalog_request";
  sessionId: string;
  requestId: string;
};
export type CommandCatalogResponse = {
  type: "command_catalog";
  sessionId: string;
  requestId: string;
  entries: CommandEntry[];
  warnings: string[];
  truncated: boolean;
  error?: string;
};

const transitions =
  "clear reset new resume branch fork background bg cd worktree teleport tp desktop app exit quit".split(
    " ",
  );
const dialogs =
  "config settings mcp plugin plugins hooks memory rewind checkpoint copy help tasks status usage cost theme login logout add-dir chrome ide terminal-setup keybindings doctor checkup init bug share feedback export advisor autocompact fast btw agents remote-control rc sandbox output-style statusline voice vim rename tag plan permissions allowed-tools diff".split(
    " ",
  );
const seed = (names: string[], support: CommandSupport, description: string): CommandEntry[] =>
  names.map((name) => ({
    id: `docs:${name}`,
    name,
    support,
    description,
    source: "docs",
    scope: "builtin",
  }));
/** Documentation-based suggestions, not a claim these are installed or available. */
export const BUILTIN_COMMANDS: CommandEntry[] = [
  ...seed(
    transitions,
    "transition",
    "Session or cwd change: use the local CLI or app session controls",
  ),
  ...seed(dialogs, "dialog", "Unrepresented CLI dialog: use the local CLI"),
  ...seed(
    ["model", "effort"],
    "native",
    "Explicit argument handled by app; bare picker requires local CLI",
  ),
  ...seed(
    ["compact", "context"],
    "forwarded",
    "Text passthrough; availability and result unverified",
  ),
];
export function commandDecision(text: string): {
  kind: "text" | "forward" | "native" | "blocked";
  reason?: string;
} {
  const value = text.trimStart();
  if (!value.startsWith("/")) return { kind: "text" };
  if ([...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    return {
      kind: "blocked",
      reason:
        "Multiline or control-character slash commands cannot be safely dispatched. Use one command per input.",
    };
  const match = /^\/([^\s/]+)(?:\s+(.*))?$/.exec(value.trim());
  if (!match)
    return {
      kind: "blocked",
      reason: "This slash command form cannot be safely dispatched. Use a single leading slash.",
    };
  const name = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();
  if (
    (name === "model" && isClaudeModel(args.toLowerCase())) ||
    (name === "effort" && isEffortLevel(args.toLowerCase()))
  )
    return { kind: "native" };
  if (transitions.includes(name))
    return {
      kind: "blocked",
      reason:
        "This can change session identity or cwd. Use app session controls or the local CLI; Controller cannot rebind this session.",
    };
  if (dialogs.includes(name) || name === "model" || name === "effort")
    return {
      kind: "blocked",
      reason:
        "This CLI picker or action is not represented here. Use the local CLI or the corresponding app control.",
    };
  return {
    kind: "forward",
    reason:
      "Custom or forwarded command: availability and dialogs are unverified; local CLI recovery may be needed.",
  };
}
export function slashText(text: string): string {
  const value = text.trimStart();
  return value.startsWith("/") ? value : `/${value}`;
}
