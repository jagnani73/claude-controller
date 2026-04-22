import type { ConnectionState } from "@/services/ws.service";

interface HeaderProps {
  title: string;
  connectionState: ConnectionState;
  showBack?: boolean;
  onBack?: () => void;
}

const stateColors: Record<ConnectionState, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  disconnected: "bg-red-500",
};

export function Header({ title, connectionState, showBack, onBack }: HeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-800 bg-neutral-950 px-4">
      {showBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors active:bg-neutral-800"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            role="img"
          >
            <title>Back</title>
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100">{title}</h1>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${stateColors[connectionState]}`}
        title={connectionState}
      />
    </header>
  );
}
