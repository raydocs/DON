"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuBot, LuCircleCheck, LuShieldCheck } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { translateBackendError } from "@/lib/backend-errors";
import type { BrowserProfile } from "@/types";

interface ProviderStatus {
  endpoint: string;
  model: string;
  has_key: boolean;
}
interface Tab {
  id: string;
  title: string;
  url: string;
}
interface Field {
  selector: string;
  tag: string;
  label: string;
  type: string;
  filled: boolean;
}
interface Task {
  id: string;
  profile_id: string;
  tab_id: string;
  origin: string;
  state: string;
  steps: string[];
  result: string | null;
  observation: {
    url: string;
    title: string;
    text: string;
    fields: Field[];
  } | null;
  pending: {
    id: string;
    tool: string;
    origin: string;
    summary: { selector?: string; url?: string; fields: Field[] };
  } | null;
}
const active = (task: Task | null) =>
  !!task && !["completed", "failed", "cancelled"].includes(task.state);

/** Local browser tasks are independent of cloud MCP sessions and schedules. */
export function BrowserAgent({ profiles }: { profiles: BrowserProfile[] }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ProviderStatus | null>(null);
  const [savedConfig, setSavedConfig] = useState<ProviderStatus | null>(null);
  const [key, setKey] = useState("");
  const [profileId, setProfileId] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabId, setTabId] = useState("");
  const [goal, setGoal] = useState("");
  const [consent, setConsent] = useState(false);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingTabs, setLoadingTabs] = useState(false);
  const running = active(task);
  const configSaved =
    !!savedConfig &&
    config?.endpoint === savedConfig.endpoint &&
    config?.model === savedConfig.model &&
    !key;
  const reload = useCallback(async () => {
    setTask(await invoke<Task | null>("get_browser_agent_task"));
  }, []);
  useEffect(() => {
    let stopped = false;
    invoke<ProviderStatus>("get_browser_agent_config")
      .then((value) => {
        if (!stopped) {
          setConfig(value);
          setSavedConfig(value);
        }
      })
      .catch(() => {
        if (!stopped) setError("AI_CONFIG_UNAVAILABLE");
      });
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await invoke<Task | null>("get_browser_agent_task");
        if (!stopped) setTask(value);
      } catch {
        if (!stopped) setError("AI_STATE_UNAVAILABLE");
      }
      if (!stopped) timer = setTimeout(poll, 700);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    setTabs([]);
    setTabId("");
    if (!profileId) {
      setLoadingTabs(false);
      return;
    }
    setLoadingTabs(true);
    invoke<Tab[]>("get_browser_agent_tabs", { profileId })
      .then((value) => {
        if (!stopped) setTabs(value);
      })
      .catch(() => {
        if (!stopped) setError("AI_BROWSER_UNAVAILABLE");
      })
      .finally(() => {
        if (!stopped) setLoadingTabs(false);
      });
    return () => {
      stopped = true;
    };
  }, [profileId]);
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(translateBackendError(t, String(e)));
    } finally {
      setBusy(false);
    }
  };
  const control = (action: string) =>
    perform(() =>
      invoke("control_browser_agent_task", {
        id: task?.id,
        action,
        approvalId: task?.pending?.id ?? null,
      }),
    );
  const selected = profiles.find((p) => p.id === task?.profile_id);
  const field = "flex flex-col gap-1.5";
  const select =
    "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-50";
  return (
    <div
      data-testid="browser-agent"
      className="grid min-h-0 flex-1 auto-rows-min gap-4 overflow-y-auto pr-1 md:grid-cols-[minmax(16rem,0.85fr)_minmax(0,1.4fr)]"
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 font-medium">
            <LuBot aria-hidden />
            {t("browserAgent.title")}
          </div>
          <p className="text-sm text-muted-foreground">
            {t("browserAgent.description")}
          </p>
          <div className="mt-3 flex gap-2 rounded-lg bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
            <LuShieldCheck className="mt-0.5 shrink-0" aria-hidden />
            {t("browserAgent.boundary")}
          </div>
        </div>
        <details
          className="rounded-xl border border-border bg-card p-4"
          open={!config?.has_key}
        >
          <summary className="cursor-pointer text-sm font-medium">
            {t("browserAgent.provider")} ·{" "}
            {config?.has_key
              ? t("browserAgent.configured")
              : t("browserAgent.keyRequired")}
          </summary>
          {config ? (
            <div className="mt-4 flex flex-col gap-3">
              <div className={field}>
                <Label htmlFor="ai-endpoint">
                  {t("browserAgent.endpoint")}
                </Label>
                <Input
                  id="ai-endpoint"
                  value={config.endpoint}
                  disabled={running || busy}
                  onChange={(e) => {
                    setConsent(false);
                    setConfig({ ...config, endpoint: e.target.value });
                  }}
                />
              </div>
              <div className={field}>
                <Label htmlFor="ai-model">{t("browserAgent.model")}</Label>
                <Input
                  id="ai-model"
                  value={config.model}
                  disabled={running || busy}
                  onChange={(e) =>
                    setConfig({ ...config, model: e.target.value })
                  }
                />
              </div>
              <div className={field}>
                <Label htmlFor="ai-key">{t("browserAgent.key")}</Label>
                <Input
                  id="ai-key"
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  disabled={running || busy}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={t("browserAgent.keyHint")}
                />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("browserAgent.cost")}
              </p>
              {!configSaved && (
                <p className="text-xs text-warning">
                  {t("browserAgent.unsaved")}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={running || busy}
                  onClick={() =>
                    void perform(async () => {
                      const saved = await invoke<ProviderStatus>(
                        "save_browser_agent_config",
                        {
                          endpoint: config.endpoint,
                          model: config.model,
                          apiKey: key,
                          forgetKey: false,
                        },
                      );
                      setConfig(saved);
                      setSavedConfig(saved);
                      setConsent(false);
                      setKey("");
                    })
                  }
                >
                  {t("common.buttons.save")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running || busy || !config.has_key}
                  onClick={() =>
                    void perform(async () => {
                      const saved = await invoke<ProviderStatus>(
                        "save_browser_agent_config",
                        {
                          endpoint: config.endpoint,
                          model: config.model,
                          apiKey: "",
                          forgetKey: true,
                        },
                      );
                      setConfig(saved);
                      setSavedConfig(saved);
                      setConsent(false);
                      setKey("");
                    })
                  }
                >
                  {t("browserAgent.forget")}
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {t("browserAgent.loading")}
            </p>
          )}
        </details>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
          <div className={field}>
            <Label htmlFor="ai-profile">{t("browserAgent.profile")}</Label>
            <select
              id="ai-profile"
              className={select}
              value={profileId}
              disabled={running || busy}
              onChange={(e) => {
                setProfileId(e.target.value);
                setError("");
                setConsent(false);
              }}
            >
              <option value="">{t("browserAgent.chooseProfile")}</option>
              {profiles
                .filter((p) => p.browser === "wayfern")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
          <div className={field}>
            <Label htmlFor="ai-tab">{t("browserAgent.tab")}</Label>
            <select
              id="ai-tab"
              className={select}
              value={tabId}
              disabled={running || busy || loadingTabs}
              onChange={(e) => {
                setTabId(e.target.value);
                setConsent(false);
              }}
            >
              <option value="">
                {loadingTabs
                  ? t("browserAgent.loading")
                  : t("browserAgent.chooseTab")}
              </option>
              {tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.title || tab.url}
                </option>
              ))}
            </select>
            {profileId && !loadingTabs && !tabs.length && (
              <p className="text-xs text-muted-foreground">
                {t("browserAgent.noTabs")}
              </p>
            )}
          </div>
          <div className={field}>
            <Label htmlFor="ai-goal">{t("browserAgent.goal")}</Label>
            <Textarea
              id="ai-goal"
              className="min-h-24"
              maxLength={4000}
              value={goal}
              disabled={running || busy}
              placeholder={t("browserAgent.goalHint")}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
          <label className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <input
              data-testid="ai-consent"
              type="checkbox"
              checked={consent}
              disabled={running || busy || !configSaved}
              className="mt-1"
              onChange={(e) => setConsent(e.target.checked)}
            />
            {t("browserAgent.consent", {
              endpoint: savedConfig?.endpoint ?? "—",
            })}
          </label>
          <Button
            data-testid="ai-start"
            disabled={
              running ||
              busy ||
              !configSaved ||
              !config?.has_key ||
              !tabId ||
              !goal.trim() ||
              !consent
            }
            onClick={() =>
              void perform(async () => {
                setTask(
                  await invoke<Task>("start_browser_agent_task", {
                    profileId,
                    tabId,
                    goal,
                    consent,
                  }),
                );
              })
            }
          >
            {t("browserAgent.start")}
          </Button>
        </div>
      </div>
      <div
        className={`flex min-w-0 flex-col gap-4 ${task ? "order-first md:order-last" : ""}`}
      >
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
          >
            <p>{t("browserAgent.error")}</p>
            <code className="mt-2 block break-all text-xs">{error}</code>
          </div>
        )}
        <section
          className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-medium">{t("browserAgent.task")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {task
                  ? `${selected?.name ?? task.profile_id} · ${task.origin}`
                  : t("browserAgent.empty")}
              </p>
            </div>
            <span
              data-testid="ai-state"
              className="rounded-full bg-foreground/5 px-2.5 py-1 text-xs"
            >
              {t(`browserAgent.state.${task?.state ?? "idle"}`)}
            </span>
          </div>
          {task && running && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void control(
                    ["paused", "human"].includes(task.state)
                      ? "resume"
                      : "pause",
                  )
                }
              >
                {t(
                  ["paused", "human"].includes(task.state)
                    ? "browserAgent.resume"
                    : "browserAgent.pause",
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || task.state === "human"}
                onClick={() => void control("take_over")}
              >
                {t("browserAgent.takeOver")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void control("cancel")}
              >
                {t("common.buttons.cancel")}
              </Button>
            </div>
          )}
          {task?.pending && (
            <div
              data-testid="ai-confirmation"
              className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/5 p-4"
            >
              <h4 className="font-medium">{t("browserAgent.confirm")}</h4>
              <p className="break-all text-sm font-medium">
                {task.pending.origin}
              </p>
              <p className="break-all text-sm">
                {t(`browserAgent.action.${task.pending.tool}`)} ·{" "}
                <code>
                  {task.pending.summary.selector ?? task.pending.summary.url}
                </code>
              </p>
              <p className="text-xs text-muted-foreground">
                {t("browserAgent.confirmHint")}
              </p>
              <dl className="max-h-40 overflow-y-auto text-xs">
                {task.pending.summary.fields
                  .filter((f) =>
                    ["input", "textarea", "select"].includes(f.tag),
                  )
                  .map((f) => (
                    <div
                      key={f.selector}
                      className="flex justify-between gap-3 border-b border-border py-2"
                    >
                      <dt className="truncate">{f.label || f.selector}</dt>
                      <dd>
                        {t(
                          f.filled
                            ? "browserAgent.filled"
                            : "browserAgent.blank",
                        )}
                      </dd>
                    </div>
                  ))}
              </dl>
              <div className="flex gap-2">
                <Button
                  data-testid="ai-approve"
                  size="sm"
                  disabled={busy}
                  onClick={() => void control("approve")}
                >
                  {t("browserAgent.approve")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void control("reject")}
                >
                  {t("browserAgent.reject")}
                </Button>
              </div>
            </div>
          )}
          {task?.state === "human" && (
            <p className="rounded-lg bg-primary/5 p-3 text-sm">
              {t("browserAgent.humanHint")}
            </p>
          )}
          <ol className="flex max-h-48 flex-col gap-2 overflow-y-auto">
            {task?.steps.map((s, i) => (
              <li key={`${i}-${s}`} className="flex items-center gap-2 text-sm">
                <LuCircleCheck
                  className="shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                {t(`browserAgent.action.${s}`)}
              </li>
            ))}
          </ol>
          {task?.result && (
            <div
              data-testid="ai-result"
              className="border-t border-border pt-3"
            >
              <h4 className="mb-2 text-sm font-medium">
                {t("browserAgent.result")}
              </h4>
              <p className="whitespace-pre-wrap break-words text-sm">
                {task.state === "failed"
                  ? t("backendErrors.browserAgentFailed", {
                      reason: task.result,
                    })
                  : task.result}
              </p>
            </div>
          )}
          {task?.observation && (
            <details className="border-t border-border pt-3">
              <summary className="cursor-pointer text-sm">
                {t("browserAgent.observation")}
              </summary>
              <p className="mt-2 break-all text-xs text-muted-foreground">
                {task.observation.url}
              </p>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                {task.observation.text}
              </pre>
            </details>
          )}
        </section>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          {t("browserAgent.limits")}
        </p>
      </div>
    </div>
  );
}
