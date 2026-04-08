import { useDirBrowser } from "@/hooks/use-sessions";
import type { ClaudeModel, EffortLevel, PermissionMode } from "common/types";
import { useEffect, useState } from "react";

const MODEL_OPTIONS: { key: ClaudeModel; label: string }[] = [
    { key: "opus", label: "Opus 4.6" },
    { key: "sonnet", label: "Sonnet 4.6" },
    { key: "haiku", label: "Haiku 4.5" },
];

interface CreateSessionFormProps {
    workDir: string;
    onSubmit: (config: {
        cwd: string;
        model: ClaudeModel;
        permissionMode: PermissionMode;
        effort?: EffortLevel;
        name?: string;
    }) => void;
}

export function CreateSessionForm({
    workDir,
    onSubmit,
}: CreateSessionFormProps) {
    const [model, setModel] = useState<ClaudeModel>("sonnet");
    const [permissionMode, setPermissionMode] =
        useState<PermissionMode>("default");
    const [effort, setEffort] = useState<EffortLevel>("high");
    const [name, setName] = useState("");

    const { currentPath, dirs, browse } = useDirBrowser();

    // Load root dirs on mount
    useEffect(() => {
        if (workDir) browse(workDir);
    }, [workDir, browse]);

    const handleDirClick = (dir: string) => {
        const separator = currentPath.includes("/") ? "/" : "\\";
        browse(`${currentPath}${separator}${dir}`);
    };

    const parentPath = () => {
        const separator = currentPath.includes("/") ? "/" : "\\";
        const parts = currentPath.split(separator);
        parts.pop();
        return parts.join(separator);
    };

    const canGoUp =
        currentPath !== workDir && currentPath.length > workDir.length;

    const handleSubmit = () => {
        if (!currentPath) return;
        onSubmit({
            cwd: currentPath,
            model,
            permissionMode,
            effort,
            name: name.trim() || undefined,
        });
        setName("");
    };

    const displayPath = currentPath.startsWith(workDir)
        ? currentPath.slice(workDir.length) || "/"
        : currentPath;

    return (
        <div className="flex flex-col gap-3 p-4">
            {/* Folder browser */}
            <div className="rounded-lg bg-neutral-900 ring-1 ring-neutral-800">
                <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
                    {canGoUp && (
                        <button
                            type="button"
                            onClick={() => browse(parentPath())}
                            className="shrink-0 rounded px-2 py-0.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800"
                        >
                            ..
                        </button>
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
                        {displayPath}
                    </span>
                </div>
                <div className="max-h-40 overflow-y-auto">
                    {dirs.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-neutral-600">
                            No subfolders
                        </div>
                    ) : (
                        dirs.map((dir) => (
                            <button
                                key={dir}
                                type="button"
                                onClick={() => handleDirClick(dir)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800"
                            >
                                <span className="text-neutral-600">
                                    &#128193;
                                </span>
                                {dir}
                            </button>
                        ))
                    )}
                </div>
            </div>

            <input
                type="text"
                placeholder="Session name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded-lg bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
            />

            <div className="flex gap-3">
                <select
                    value={model}
                    onChange={(e) => setModel(e.target.value as ClaudeModel)}
                    className="flex-1 rounded-lg bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
                >
                    {MODEL_OPTIONS.map((m) => (
                        <option key={m.key} value={m.key}>
                            {m.label}
                        </option>
                    ))}
                </select>
                <select
                    value={permissionMode}
                    onChange={(e) =>
                        setPermissionMode(e.target.value as PermissionMode)
                    }
                    className="flex-1 rounded-lg bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
                >
                    <option value="default">Default</option>
                    <option value="plan">Plan</option>
                    <option value="acceptEdits">Accept Edits</option>
                    <option value="auto">Auto</option>
                    <option value="bypassPermissions">Bypass</option>
                </select>
            </div>

            <select
                value={effort}
                onChange={(e) => setEffort(e.target.value as EffortLevel)}
                className="rounded-lg bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
            >
                <option value="low">Effort: Low</option>
                <option value="medium">Effort: Medium</option>
                <option value="high">Effort: High</option>
            </select>

            <button
                type="button"
                onClick={handleSubmit}
                disabled={!currentPath}
                className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-950 transition-opacity disabled:opacity-30"
            >
                Create Session
            </button>
        </div>
    );
}
