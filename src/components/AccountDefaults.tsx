import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { TOOL_LABEL, useDesk } from "../store";
import { CLAUDE_EFFORTS, CLAUDE_MODELS, loadCodexModelsFor, optionsKey, probeAcpOptions, useChats } from "../chat";
import { isAcpAgent } from "../acp";
import type { Account } from "../types";

const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", minimal: "Minimal", none: "None" };

/** The model and effort an account's new chats start with. Each chat can still change them. */
export function AccountDefaults({ account }: { account: Account }) {
  const kind = account.kind;
  const codexModels = useChats((s) => s.codexModels[account.dir ?? ""]);
  const acp = useChats((s) => (isAcpAgent(kind) ? s.acpOptions[optionsKey(kind, account.dir)] : undefined));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const update = (patch: Partial<Account>) => useDesk.getState().updateAccount(account.id, patch);

  useEffect(() => {
    // Codex's catalog is a file in its folder: cheap to read.
    if (kind === "codex") void loadCodexModelsFor(account.dir);
  }, [kind, account.dir]);

  if (kind === "github") return null;

  let models: { id: string; label: string }[] = [];
  let efforts: { id: string; label: string }[] = [];
  if (kind === "claude") {
    models = CLAUDE_MODELS.filter((m) => m.id).map((m) => ({ id: m.id, label: m.label }));
    efforts = CLAUDE_EFFORTS.map((e) => ({ id: e, label: EFFORT_LABEL[e] ?? e }));
  } else if (kind === "codex") {
    models = (codexModels ?? []).map((m) => ({ id: m.id, label: m.label }));
    const list = codexModels?.find((m) => m.id === account.model)?.efforts ?? ["low", "medium", "high", "xhigh"];
    efforts = list.map((e) => ({ id: e, label: EFFORT_LABEL[e] ?? e }));
  } else if (acp) {
    models = (acp.find((o) => o.category === "model")?.choices ?? []).map((c) => ({ id: c.value, label: c.name }));
    efforts = (acp.find((o) => o.category === "thought_level")?.choices ?? []).map((c) => ({ id: c.value, label: c.name }));
  }
  // A saved choice the list no longer has still shows, so it isn't silently dropped.
  if (account.model && !models.some((m) => m.id === account.model)) models = [{ id: account.model, label: account.model }, ...models];
  if (account.effort && !efforts.some((e) => e.id === account.effort)) efforts = [{ id: account.effort, label: EFFORT_LABEL[account.effort] ?? account.effort }, ...efforts];

  const load = () => {
    if (!isAcpAgent(kind)) return;
    setLoading(true);
    setError("");
    probeAcpOptions(kind, account).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false));
  };
  const needsLoad = isAcpAgent(kind) && !acp;

  return (
    <div className="account-defaults">
      <label>
        <span>Default model</span>
        <select aria-label={`Default model for ${account.name}`} value={account.model ?? ""} disabled={needsLoad} onChange={(e) => update({ model: e.target.value || undefined, ...(kind === "codex" ? { effort: undefined } : {}) })}>
          <option value="">{TOOL_LABEL[kind]}'s default</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      {(efforts.length > 0 || needsLoad) && (
        <label>
          <span>Default effort</span>
          <select aria-label={`Default effort for ${account.name}`} value={account.effort ?? ""} disabled={needsLoad} onChange={(e) => update({ effort: e.target.value || undefined })}>
            <option value="">Model's default</option>
            {efforts.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
      )}
      {isAcpAgent(kind) && (
        <button className="text-button account-defaults-load" disabled={loading} onClick={load} title={`Starts ${TOOL_LABEL[kind]} for a moment to ask which models it offers`}>
          {loading ? <LoaderCircle size={12} className="is-spinning" /> : <RefreshCw size={12} />}{acp ? "Refresh models" : "Load models"}
        </button>
      )}
      {error && <p className="account-defaults-error">{error}</p>}
    </div>
  );
}
