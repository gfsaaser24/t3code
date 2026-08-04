import type {
  DesktopOfficialT3ImportAvailability,
  DesktopOfficialT3ImportCollisionChoice,
  DesktopOfficialT3ImportResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { CloudIcon, DatabaseIcon, MonitorIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { setActiveEnvironmentId } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Spinner } from "../ui/spinner";
import { useChatPaneActions } from "../../turbo/chatPanes/ChatPaneActionsContext";
import {
  applyDesktopEnvironmentSwitch,
  buildDesktopEnvironmentOptions,
  IMPORT_OFFICIAL_T3_VALUE,
} from "./DesktopEnvironmentSwitcher.logic";

function EnvironmentIcon({ kind }: { readonly kind: "turbo" | "other" }) {
  return kind === "turbo" ? (
    <MonitorIcon className="size-3 shrink-0" />
  ) : (
    <CloudIcon className="size-3 shrink-0" />
  );
}

interface DesktopEnvironmentSwitcherProps {
  readonly activeEnvironmentId: EnvironmentId;
}

const collisionLabel = (choice: DesktopOfficialT3ImportCollisionChoice): string => {
  switch (choice) {
    case "clone":
      return "Keep both (new chat ID)";
    case "replace":
      return "Replace Turbo chat";
    case "skip":
      return "Skip official chat";
  }
};

export const DesktopEnvironmentSwitcher = memo(function DesktopEnvironmentSwitcher({
  activeEnvironmentId,
}: DesktopEnvironmentSwitcherProps) {
  const bridge = window.desktopBridge;
  const discoverImport = bridge?.discoverOfficialT3Import;
  const runImport = bridge?.runOfficialT3Import;
  const { resetToHome } = useChatPaneActions();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [availability, setAvailability] = useState<DesktopOfficialT3ImportAvailability | null>(
    null,
  );
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<DesktopOfficialT3ImportResult | null>(null);
  const [collisionChoices, setCollisionChoices] = useState<
    Record<string, DesktopOfficialT3ImportCollisionChoice>
  >({});

  useEffect(() => {
    if (!discoverImport) return;
    let cancelled = false;
    void discoverImport()
      .then((discovered) => {
        if (!cancelled) setAvailability(discovered);
      })
      .catch(() => {
        if (!cancelled) setAvailability(null);
      });
    return () => {
      cancelled = true;
    };
  }, [discoverImport]);

  const options = useMemo(
    () => buildDesktopEnvironmentOptions({ environments, primaryEnvironmentId }),
    [environments, primaryEnvironmentId],
  );
  const selected = options.find((option) => option.environmentId === activeEnvironmentId) ?? null;

  const switchEnvironment = useCallback(
    (environmentId: EnvironmentId) => {
      applyDesktopEnvironmentSwitch(environmentId, {
        activate: setActiveEnvironmentId,
        resetChatWorkspace: resetToHome,
      });
    },
    [resetToHome],
  );

  const handleValueChange = useCallback(
    (value: string | null) => {
      if (value === null) return;
      if (value === IMPORT_OFFICIAL_T3_VALUE) {
        setResult(null);
        setCollisionChoices({});
        setImportOpen(true);
        return;
      }
      switchEnvironment(value as EnvironmentId);
    },
    [switchEnvironment],
  );

  const handleImport = useCallback(async () => {
    if (!runImport) return;
    setImporting(true);
    try {
      const next = await runImport({
        ...(result?.status === "needs-collision-choices" ? { collisionChoices } : {}),
      });
      setResult(next);
      if (next.status === "needs-collision-choices") {
        setCollisionChoices((current) =>
          Object.fromEntries(
            next.threadIds.map((threadId) => [threadId, current[threadId] ?? "clone"]),
          ),
        );
      }
    } catch (cause) {
      setResult({
        status: "blocked",
        reason: "import-failed",
        message: cause instanceof Error ? cause.message : "The direct importer could not run.",
        runCommand: availability?.runCommand ?? "t3 import official run",
        planCommand: availability?.planCommand ?? "t3 import official plan",
      });
    } finally {
      setImporting(false);
    }
  }, [availability, collisionChoices, result, runImport]);

  if (!bridge || selected === null) return null;

  return (
    <>
      <Select
        modal={false}
        value={activeEnvironmentId}
        onValueChange={handleValueChange}
        items={options.map((option) => ({ value: option.environmentId, label: option.label }))}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          className="max-w-36 font-medium"
          aria-label="Environment"
        >
          <EnvironmentIcon kind={selected.kind} />
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            <SelectGroupLabel>Environment</SelectGroupLabel>
            {options.map((option) => (
              <SelectItem key={option.environmentId} value={option.environmentId}>
                <span className="inline-flex items-center gap-1.5">
                  <EnvironmentIcon kind={option.kind} />
                  {option.label}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
          {availability && runImport ? (
            <>
              <SelectSeparator />
              <SelectItem value={IMPORT_OFFICIAL_T3_VALUE}>
                <span className="inline-flex items-center gap-1.5">
                  <DatabaseIcon className="size-3" />
                  Import official T3 Code…
                </span>
              </SelectItem>
            </>
          ) : null}
        </SelectPopup>
      </Select>

      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (!importing) setImportOpen(open);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Import official T3 Code</DialogTitle>
            <DialogDescription>
              Copy official projects and chats directly into the T3 Turbo database. Turbo briefly
              stops its local backend, verifies a fresh plan, creates a recovery backup, and starts
              again. It never connects to or runs a second T3 instance.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {result?.status === "needs-collision-choices" ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">{result.message}</p>
                <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                  {result.threadIds.map((threadId) => {
                    const choice = collisionChoices[threadId] ?? "clone";
                    return (
                      <div key={threadId} className="space-y-1 rounded-md border p-2">
                        <code className="block truncate text-xs">{threadId}</code>
                        <Select
                          value={choice}
                          onValueChange={(value) => {
                            if (value !== "clone" && value !== "replace" && value !== "skip") {
                              return;
                            }
                            setCollisionChoices((current) => ({
                              ...current,
                              [threadId]: value,
                            }));
                          }}
                          items={(["clone", "replace", "skip"] as const).map((value) => ({
                            value,
                            label: collisionLabel(value),
                          }))}
                        >
                          <SelectTrigger size="sm" aria-label={`Collision choice for ${threadId}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            {(["clone", "replace", "skip"] as const).map((value) => (
                              <SelectItem key={value} value={value}>
                                {collisionLabel(value)}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : result?.status === "imported" ? (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                Imported {result.importedEventCount} events and {result.copiedAttachmentCount}{" "}
                attachments. Turbo has restarted with the merged database.
              </div>
            ) : result?.status === "blocked" ? (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-destructive">
                  {result.message}
                </p>
                <details className="text-xs text-muted-foreground">
                  <summary>Run manually</summary>
                  <code className="mt-2 block select-all break-all rounded bg-muted p-2">
                    {result.runCommand}
                  </code>
                  <p className="mt-2">
                    For per-chat collision review, run: <code>{result.planCommand}</code>
                  </p>
                </details>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Finish active chats in both apps first. If matching chat IDs have different history,
                Turbo will pause and ask what to do with each one.
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={importing} onClick={() => setImportOpen(false)}>
              {result?.status === "imported" ? "Close" : "Cancel"}
            </Button>
            {result?.status !== "imported" ? (
              <Button disabled={importing} onClick={handleImport}>
                {importing ? <Spinner /> : null}
                {result?.status === "needs-collision-choices" ? "Apply choices" : "Check & import"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
