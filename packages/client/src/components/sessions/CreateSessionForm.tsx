import type { ClaudeModel, PermissionMode } from "common/types";
import { useState } from "react";

interface CreateSessionFormProps {
    onSubmit: (config: {
        cwd: string;
        model: ClaudeModel;
        permissionMode: PermissionMode;
        name?: string;
    }) => void;
}

export function CreateSessionForm({ onSubmit }: CreateSessionFormProps) {
    const [cwd, setCwd] = useState("");
    const [model, setModel] = useState<ClaudeModel>("sonnet");
    const [permissionMode, setPermissionMode] =
        useState<PermissionMode>("default");
    const [name, setName] = useState("");

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!cwd.trim()) return;
        onSubmit({
            cwd: cwd.trim(),
            model,
            permissionMode,
            name: name.trim() || undefined,
        });
        setCwd("");
        setName("");
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-4">
            <input
                type="text"
                placeholder="Working directory (required)"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                className="rounded-lg bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
            />
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
                    <option value="sonnet">Sonnet</option>
                    <option value="opus">Opus</option>
                    <option value="haiku">Haiku</option>
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
            <button
                type="submit"
                disabled={!cwd.trim()}
                className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-950 transition-opacity disabled:opacity-30"
            >
                Create Session
            </button>
        </form>
    );
}
