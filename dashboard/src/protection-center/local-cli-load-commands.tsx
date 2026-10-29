import { useCallback, useEffect, useId, useRef, useState } from "react";

import { DiscoveryFailure } from "../discovery-failure";
import { LocalCliApiError, loadLocalCliCommands, type LocalCliItem } from "../local-cli-api";

/** Job failures whose shared wording names connectors; a command-line tool gets its own. */
const CLI_FAILURE_COPY: Record<string, string> = {
  catalog_limit_reached: "This tool lists more commands than Guard can keep. Commands and choices already saved were kept.",
  discovery_failed: "Loading stopped on an unexpected error. Commands and choices already saved were kept. Try again; if it keeps failing, restart Guard.",
};

export function loadCommandsFailureMessage(caught: unknown): string {
  if (caught instanceof DiscoveryFailure) return CLI_FAILURE_COPY[caught.code] ?? caught.message;
  if (caught instanceof LocalCliApiError) return caught.message;
  return "Guard could not load this tool's commands. Try again.";
}

/** Failures a full path can get past, both from the daemon's own PATH lookup. */
export const PATH_ENTRY_CODES = new Set(["cli_not_on_guard_path", "cli_identity_changed", "cli_reload_needs_path"]);

const BARE_PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SCRIPT_SUFFIXES = new Set([
  ".bash", ".bat", ".cmd", ".fish", ".js", ".mjs", ".cjs", ".ts", ".pl", ".ps1", ".py", ".rb", ".sh", ".zsh",
]);

/**
 * Whether the daemon needs the tool's full path to read its help. It looks
 * up only a program named on PATH by itself; a script, or a file named like
 * one, is never looked up, since Guard records no location for it.
 */
export function loadCommandsNeedsPath(item: Pick<LocalCliItem, "kind" | "name">): boolean {
  const dot = item.name.lastIndexOf(".");
  const suffix = dot > 0 ? item.name.slice(dot).toLowerCase() : "";
  return item.kind !== "executable" || !BARE_PROGRAM_NAME.test(item.name) || SCRIPT_SUFFIXES.has(suffix);
}

const ABSOLUTE_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/])/;

/**
 * The path to start from. A tool added from its file keeps that file's full
 * path; one first seen in an agent's command keeps only a class such as
 * "user-tool", which names no file, so the field starts empty.
 */
export function recordedToolPath(item: Pick<LocalCliItem, "source_path">): string {
  const recorded = item.source_path ?? "";
  return ABSOLUTE_PATH.test(recorded) ? recorded : "";
}

/** A path copied from a shell often keeps its quotes; Guard wants the path alone. */
export function enteredToolPath(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return (quoted ? quoted[2] : trimmed).trim();
}

/**
 * Reads a recorded tool's --help on request, so its commands can be set to
 * Allow or Block one by one. A program on PATH is found by name. A script is
 * found by the full path the operator enters here; either way the daemon runs
 * only the file it recorded.
 */
export function LocalCliLoadCommands(props: {
  item: LocalCliItem;
  disabled: boolean;
  /** Reloads the listing; resolves false when the reload failed. */
  onLoaded: () => Promise<boolean>;
}) {
  const { item, onLoaded } = props;
  const pathId = useId();
  const pathHintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [askPath, setAskPath] = useState(() => loadCommandsNeedsPath(item));
  const [path, setPath] = useState(() => recordedToolPath(item));
  const [pathMissing, setPathMissing] = useState(false);
  const pathRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // The panel remounts this control for another tool or a changed program,
  // so unmounting aborts a load that belongs to the previous one.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const load = useCallback(async () => {
    const entered = enteredToolPath(path);
    // A disabled button reads as Guard still working, so the action stays
    // available and says what it needs instead.
    if (askPath && entered === "") {
      setPathMissing(true);
      setLoaded(false);
      setError(`Enter the full path to ${item.name} first.`);
      pathRef.current?.focus();
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setPathMissing(false);
    setLoaded(false);
    try {
      await loadLocalCliCommands(item.cli_id, controller.signal, askPath ? entered : undefined);
      if (controller.signal.aborted) return;
      const refreshed = await onLoaded();
      if (controller.signal.aborted) return;
      // The commands were saved, but the listing on screen is the old one, so
      // its count would be wrong. The catalog shows its own reload failure.
      setLoaded(refreshed);
    } catch (caught) {
      if (controller.signal.aborted) return;
      // Guard's PATH can differ from the agent's, so the name it looks up can
      // miss the tool or find another program of that name; the full path
      // still works, and the daemon re-checks the identity before any probe.
      if (caught instanceof LocalCliApiError && PATH_ENTRY_CODES.has(caught.code)) setAskPath(true);
      setError(loadCommandsFailureMessage(caught));
    } finally {
      setBusy(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [askPath, item.cli_id, item.name, onLoaded, path]);

  // Root and other are Guard's own entries for every tool, not listed commands.
  const listedCount = item.commands.filter((command) => command.command_id !== "root" && command.command_id !== "other").length;
  const hasCommands = listedCount > 0;
  return (
    <div className="mt-3 max-w-2xl" aria-busy={busy}>
      <p className="text-sm leading-6 text-brand-dark/75">
        {askPath ? (
          <>
            Guard does not record where {item.name} is saved. Enter its full path, and Guard runs it with{" "}
            <code className="whitespace-nowrap rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-brand-dark">--help</code>{" "}
            from an empty temporary folder, then the same for each command it lists. It runs the file only if it is
            the one Guard recorded. A script that ignores --help may do its normal work instead, so load commands
            only for scripts you trust.
          </>
        ) : (
          <>
            Guard runs <code className="whitespace-nowrap rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-brand-dark">{item.name} --help</code> from an empty temporary
            folder, then the same for each command it lists. A program that ignores --help may do its normal work
            instead, so load commands only for tools you trust.
          </>
        )}{" "}
        Loading adds commands and never changes a choice you already made.
      </p>
      {askPath ? (
        <>
          <label htmlFor={pathId} className="mt-3 block text-sm font-semibold text-brand-dark">
            Full path to {item.name}
          </label>
          <input
            id={pathId}
            ref={pathRef}
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              if (pathMissing) {
                setPathMissing(false);
                setError(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy && !props.disabled) void load();
            }}
            aria-invalid={pathMissing || undefined}
            aria-describedby={pathMissing ? pathHintId : undefined}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            maxLength={4096}
            placeholder={`/path/to/${item.name}`}
            className="mt-2 min-h-11 w-full max-w-xl rounded-xl border border-slate-300 aria-[invalid=true]:border-red-600 bg-white px-3 font-mono text-sm text-brand-dark placeholder:text-brand-dark/70 focus:border-brand-blue focus:outline-none focus:ring-2 focus:ring-brand-blue/30"
          />
        </>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void load()}
          disabled={props.disabled || busy}
          className={`inline-flex min-h-11 items-center rounded-xl border border-slate-300 px-4 text-sm font-semibold text-brand-dark disabled:opacity-50 ${busy ? "cursor-wait" : "disabled:cursor-not-allowed"}`}
        >
          {busy ? "Loading commands…" : hasCommands ? "Check for new commands" : "Load commands"}
        </button>
        {busy ? (
          <button
            type="button"
            onClick={() => controllerRef.current?.abort()}
            className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-brand-dark"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {error ? <p id={pathMissing ? pathHintId : undefined} role="alert" className="mt-3 text-sm leading-6 text-red-700">{error}</p> : null}
      {loaded ? (
        <p role="status" className="mt-3 text-sm leading-6 text-brand-dark/75">
          {hasCommands
            ? `${item.name} lists ${listedCount} ${listedCount === 1 ? "command" : "commands"}. Choose Allow or Block for each below.`
            : `${item.name} --help did not list any commands, so Guard treats it as one tool. Choose Allow or Block for it below.`}
        </p>
      ) : null}
    </div>
  );
}
