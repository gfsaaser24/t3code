import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopOfficialT3Environment, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon, LinkIcon, MonitorIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  connectPairing as connectPairingAtom,
  updateBearerConnection as updateBearerConnectionAtom,
} from "../../connection/onboarding";
import { setActiveEnvironmentId } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Input } from "../ui/input";
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
import {
  buildDesktopEnvironmentOptions,
  CONNECT_OFFICIAL_T3_VALUE,
  resolveOfficialT3PairingInput,
  shouldRefreshOfficialT3Connection,
} from "./DesktopEnvironmentSwitcher.logic";

const DISCOVERY_REFRESH_MS = 5_000;

function EnvironmentIcon({ kind }: { readonly kind: "turbo" | "official" | "other" }) {
  return kind === "turbo" ? (
    <MonitorIcon className="size-3 shrink-0" />
  ) : (
    <CloudIcon className="size-3 shrink-0" />
  );
}

interface DesktopEnvironmentSwitcherProps {
  readonly activeEnvironmentId: EnvironmentId;
}

export const DesktopEnvironmentSwitcher = memo(function DesktopEnvironmentSwitcher({
  activeEnvironmentId,
}: DesktopEnvironmentSwitcherProps) {
  const bridge = window.desktopBridge;
  const discoverOfficial = bridge?.discoverOfficialT3Environment;
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const updateBearerConnection = useAtomCommand(updateBearerConnectionAtom, {
    reportFailure: false,
  });
  const [official, setOfficial] = useState<DesktopOfficialT3Environment | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  useEffect(() => {
    if (!discoverOfficial) return;
    let cancelled = false;

    const refresh = () => {
      void discoverOfficial()
        .then((result) => {
          if (!cancelled) setOfficial(result);
        })
        .catch(() => {
          if (!cancelled) setOfficial(null);
        });
    };

    refresh();
    const interval = window.setInterval(refresh, DISCOVERY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [discoverOfficial]);

  const officialEnvironmentId = official?.descriptor.environmentId ?? null;
  const options = useMemo(
    () =>
      buildDesktopEnvironmentOptions({
        environments,
        primaryEnvironmentId,
        officialEnvironmentId,
      }),
    [environments, officialEnvironmentId, primaryEnvironmentId],
  );
  const officialIsConnected =
    officialEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === officialEnvironmentId);
  const officialEnvironment =
    officialEnvironmentId === null
      ? null
      : (environments.find((environment) => environment.environmentId === officialEnvironmentId) ??
        null);
  const selected = options.find((option) => option.environmentId === activeEnvironmentId) ?? null;

  useEffect(() => {
    if (
      !official ||
      !officialEnvironment ||
      officialEnvironment.entry.target._tag !== "BearerConnectionTarget" ||
      !shouldRefreshOfficialT3Connection(officialEnvironment.displayUrl, official.httpBaseUrl)
    ) {
      return;
    }

    void updateBearerConnection({
      environmentId: official.descriptor.environmentId,
      label: officialEnvironment.label,
      httpBaseUrl: official.httpBaseUrl,
    });
  }, [official, officialEnvironment, updateBearerConnection]);

  const switchEnvironment = useCallback(
    (environmentId: EnvironmentId) => {
      setActiveEnvironmentId(environmentId);
      void navigate({ to: "/" });
    },
    [navigate],
  );

  const handleValueChange = useCallback(
    (value: string | null) => {
      if (value === null) return;
      if (value === CONNECT_OFFICIAL_T3_VALUE) {
        setPairingError(null);
        setPairingOpen(true);
        return;
      }
      switchEnvironment(value as EnvironmentId);
    },
    [switchEnvironment],
  );

  const handlePair = useCallback(async () => {
    const code = pairingCode.trim();
    if (!official || !code) {
      setPairingError("Enter the pairing link or one-time code from T3 Code.");
      return;
    }

    setPairing(true);
    setPairingError(null);
    const result = await connectPairing(resolveOfficialT3PairingInput(code, official.httpBaseUrl));
    setPairing(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setPairingError(error instanceof Error ? error.message : "Could not connect to T3 Code.");
      }
      return;
    }

    setPairingCode("");
    setPairingOpen(false);
    switchEnvironment(result.value);
  }, [connectPairing, official, pairingCode, switchEnvironment]);

  if (!bridge || !discoverOfficial || selected === null) return null;

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
          {official ? (
            <>
              <SelectSeparator />
              <SelectItem value={CONNECT_OFFICIAL_T3_VALUE}>
                <span className="inline-flex items-center gap-1.5">
                  <LinkIcon className="size-3" />
                  {officialIsConnected ? "Reconnect T3 Code…" : "Connect T3 Code…"}
                </span>
              </SelectItem>
            </>
          ) : null}
        </SelectPopup>
      </Select>

      <Dialog
        open={pairingOpen}
        onOpenChange={(open) => {
          if (pairing) return;
          setPairingOpen(open);
          if (!open) setPairingError(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Connect official T3 Code</DialogTitle>
            <DialogDescription>
              In T3 Code, open Settings → Connections and create a pairing link. Paste the link or
              its one-time code here; Turbo will connect to the running server without opening its
              database.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void handlePair();
              }}
            >
              <Input
                autoFocus
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value)}
                placeholder="Pairing link or code"
                aria-label="Pairing link or code"
                autoComplete="off"
                disabled={pairing}
              />
              {pairingError ? (
                <p role="alert" className="text-sm text-destructive">
                  {pairingError}
                </p>
              ) : null}
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={pairing} onClick={() => setPairingOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pairing || pairingCode.trim().length === 0} onClick={handlePair}>
              {pairing ? <Spinner /> : null}
              Connect
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
