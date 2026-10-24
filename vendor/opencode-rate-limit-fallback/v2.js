import { loadConfig } from "./src/utils/config.js";
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Delay before retrying on a freshly selected fallback model. */
const SWITCH_DELAY_MS = 1000;
const RETRYABLE_ERROR_PATTERNS = [
    /\b429\b/i,
    /rate[\s_-]*limit/i,
    /too many requests/i,
    /quota/i,
    /usage limit/i,
    /resource[\s_-]*exhausted/i,
    /try again later/i,
    // Transient upstream failures that OpenCode classifies as ProviderInternal
    // (for example "Error from provider (Console Go): Upstream request failed:
    // Endpoint is unavailable."). These clear on their own, so wait them out
    // instead of letting the turn stop once OpenCode's own retry budget runs out.
    /endpoint is unavailable/i,
    /upstream request failed/i,
];
function isRetryableError(value) {
    if (!value || typeof value !== "object")
        return false;
    const error = value;
    if (error.status === 429)
        return true;
    const text = `${error.type ?? ""} ${error.message ?? ""}`;
    return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}
function effectiveCooldown(cooldownMs) {
    return Math.max(1000, cooldownMs ?? 60000);
}
function exponentialDelay(baseDelayMs, failureCount) {
    const exponent = Math.min(Math.max(0, failureCount - 1), 52);
    return Math.min(Math.max(MAX_BACKOFF_MS, baseDelayMs), baseDelayMs * 2 ** exponent);
}
function sameModel(a, b) {
    return a !== undefined && b !== undefined && a.providerID === b.providerID && a.id === b.id
        && (a.variant ?? "default") === (b.variant ?? "default");
}
function toModelRef(model) {
    return { providerID: model.providerID, id: model.modelID };
}
/**
 * Errors saying the model itself is not served (rather than busy). With
 * autoFallback such a model is left out of chains for a while.
 */
const UNAVAILABLE_MODEL_PATTERNS = [
    /model is unavailable/i,
    /model[^.]{0,40}\bnot (found|available|supported)/i,
    /unknown model/i,
    /no such model/i,
    /model[^.]{0,40}does not exist/i,
];
const DEFAULT_UNAVAILABLE_MS = 6 * 60 * 60 * 1000;
function isUnavailableModelError(value) {
    if (!value || typeof value !== "object")
        return false;
    const text = `${value.type ?? ""} ${value.message ?? ""}`;
    return UNAVAILABLE_MODEL_PATTERNS.some((pattern) => pattern.test(text));
}
/**
 * The provider's free allowance is used up ("Free usage limit reached" from
 * OpenCode Zen, counted per IP): all of its free models fail alike, so with
 * autoFallback they are left out together for a while.
 */
const FREE_LIMIT_PATTERNS = [/free usage limit/i, /FreeUsageLimit/];
const DEFAULT_FREE_LIMIT_MS = 30 * 60 * 1000;
function isFreeLimitError(value) {
    if (!value || typeof value !== "object")
        return false;
    const text = `${value.type ?? ""} ${value.name ?? ""} ${value.message ?? ""}`;
    return FREE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}
function isFree(model) {
    return (model.cost ?? []).every((cost) => (cost.input ?? 0) === 0 && (cost.output ?? 0) === 0);
}
/**
 * The models a session walks through on consecutive failures: its own model,
 * then the configured fallbacks listed after it. A model that is not in
 * `fallbackModels` has no fallbacks: it is retried after a cooldown when
 * otherModels is "wait" (or in "wait" mode), and otherwise never gets here.
 */
function chainFor(model, fallbacks) {
    if (model === undefined)
        return [];
    const index = fallbacks.findIndex((candidate) => sameModel(candidate, model));
    if (index < 0)
        return [model];
    return [model, ...fallbacks.slice(index + 1).filter((candidate) => !sameModel(candidate, model))];
}
export default {
    id: "opencode-rate-limit-fallback",
    async setup(context) {
        const { config } = loadConfig(context.location.directory, context.location.directory);
        if (!config.enabled)
            return;
        // "wait" never switches models; the other modes walk the fallback chain
        // first and only then decide between waiting ("cycle", "retry-last") and
        // giving up ("stop"). A session whose model is not in the chain is left
        // to OpenCode unless otherModels is "wait".
        const mode = config.fallbackMode;
        const otherModels = config.otherModels ?? "ignore";
        const fallbacks = mode === "wait" ? [] : (config.fallbackModels ?? [])
            .filter((model) => typeof model?.providerID === "string" && typeof model?.modelID === "string")
            .map(toModelRef);
        // autoFallback ({ providers, freeOnly, unavailableMs }; an opencode-slack-channel
        // addition) appends every model the server lists now for those providers
        // (only free ones unless freeOnly is false) to the configured fallbacks, so
        // models that come and go need no config change. Configured fallbacks the
        // server no longer lists are skipped, and so is a model that answered
        // "unavailable" within unavailableMs (default 6 h), or any free model of a
        // provider that answered "free usage limit" within freeLimitMs (default 30 min).
        // With nothing usable left, a turn fails at once instead of waiting out backoffs.
        const auto = mode !== "wait" && Array.isArray(config.autoFallback?.providers)
            ? {
                providers: config.autoFallback.providers,
                freeOnly: config.autoFallback.freeOnly !== false,
                unavailableMs: Number.isFinite(config.autoFallback.unavailableMs) ? config.autoFallback.unavailableMs : DEFAULT_UNAVAILABLE_MS,
                freeLimitMs: Number.isFinite(config.autoFallback.freeLimitMs) ? config.autoFallback.freeLimitMs : DEFAULT_FREE_LIMIT_MS,
            }
            : undefined;
        if (mode !== "wait" && fallbacks.length === 0 && otherModels !== "wait" && auto === undefined)
            return;
        const handles = (model) => mode === "wait" || otherModels === "wait" || fallbacks.some((candidate) => sameModel(candidate, model))
            || (auto !== undefined && model !== undefined && auto.providers.includes(model.providerID));
        const handlesError = (error) => isRetryableError(error) || (auto !== undefined && isUnavailableModelError(error));
        const unavailableUntil = new Map();
        const modelKey = (model) => `${model.providerID}/${model.id}`;
        const isUnavailable = (model) => (unavailableUntil.get(modelKey(model)) ?? 0) > Date.now();
        const noteFailure = async (model, error) => {
            if (auto === undefined || model === undefined)
                return;
            if (isFreeLimitError(error)) {
                const until = Date.now() + auto.freeLimitMs;
                unavailableUntil.set(modelKey(model), until);
                for (const listed of await listedModels()) {
                    if (listed.providerID === model.providerID && isFree(listed))
                        unavailableUntil.set(modelKey(listed), until);
                }
            }
            else if (isUnavailableModelError(error))
                unavailableUntil.set(modelKey(model), Date.now() + auto.unavailableMs);
        };
        const listedModels = async () => {
            try {
                const result = await context.model.list();
                return (Array.isArray(result?.data) ? result.data : [])
                    .filter((model) => model.enabled !== false && (model.status ?? "active") === "active");
            }
            catch {
                return [];
            }
        };
        // A model a session may stay on: listed, not "unavailable" lately and, with
        // freeOnly, free. A paid model can be listed once the provider has a key, and
        // a session can land on one (the subagent tool takes a model argument).
        const usable = async (model) => {
            if (isUnavailable(model))
                return false;
            const listed = (await listedModels()).find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id);
            return listed !== undefined && !(auto?.freeOnly && auto.providers.includes(model.providerID) && !isFree(listed));
        };
        // Configured fallbacks the server lists, then the other listed models of
        // autoFallback.providers, newest release first.
        const autoFallbacks = async () => {
            const listed = await listedModels();
            const configured = fallbacks.filter((model) => listed.some((candidate) => candidate.providerID === model.providerID && candidate.id === model.id));
            const extra = listed
                .filter((model) => model.capabilities?.tools !== false && auto.providers.includes(model.providerID) && (!auto.freeOnly || isFree(model)))
                .sort((a, b) => (b.time?.released ?? 0) - (a.time?.released ?? 0) || a.id.localeCompare(b.id))
                .map((model) => ({ providerID: model.providerID, id: model.id }))
                .filter((ref) => !configured.some((model) => sameModel(model, ref)));
            return [...configured, ...extra].filter((model) => !isUnavailable(model));
        };
        // With autoFallback a failing model is followed by every other usable
        // model in that order (a streak starts on the session's own model, so
        // the configured fallbacks come first).
        const chainFrom = async (model) => {
            if (auto === undefined || model === undefined)
                return chainFor(model, fallbacks);
            const order = await autoFallbacks();
            return [model, ...order.filter((candidate) => !sameModel(candidate, model))];
        };
        const cooldownMs = effectiveCooldown(config.cooldownMs);
        const resumeTimers = new Map();
        const streaks = new Map();
        const cancelResume = (sessionID) => {
            const previous = resumeTimers.get(sessionID);
            if (previous) {
                clearTimeout(previous);
                resumeTimers.delete(sessionID);
            }
        };
        const scheduleResume = (sessionID, delay) => {
            cancelResume(sessionID);
            const timer = setTimeout(() => {
                resumeTimers.delete(sessionID);
                void context.session.prompt({ sessionID, text: "", resume: true }).catch(() => {
                    // A deleted or otherwise unavailable session must not keep retrying.
                });
            }, delay);
            resumeTimers.set(sessionID, timer);
        };
        const switchModel = async (sessionID, model) => {
            if (!context.session.switchModel)
                return false;
            try {
                await context.session.switchModel({ sessionID, model });
                return true;
            }
            catch {
                return false;
            }
        };
        const currentModel = async (sessionID) => {
            try {
                return context.session.get ? (await context.session.get({ sessionID }))?.model : undefined;
            }
            catch {
                return undefined;
            }
        };
        // Put the session back on its own model, unless someone picked another
        // model since this plugin switched it.
        const restoreModel = async (sessionID, streak) => {
            if (streak.selected === undefined || streak.original === undefined)
                return;
            if (sameModel(streak.selected, streak.original))
                return;
            const current = await currentModel(sessionID);
            if (current !== undefined && !sameModel(current, streak.selected))
                return;
            if (auto !== undefined && !(await usable(streak.original)))
                return;
            await switchModel(sessionID, streak.original);
        };
        // Before a real prompt runs (autoFallback): a session on a model the server
        // no longer lists, one that answered "unavailable" lately, or (freeOnly) a
        // paid one, moves to the first usable fallback instead of failing first.
        const leaveUnusableModel = async (sessionID) => {
            const current = await currentModel(sessionID);
            if (current === undefined || !auto.providers.includes(current.providerID) || (await usable(current)))
                return;
            const next = (await autoFallbacks()).find((candidate) => !sameModel(candidate, current));
            if (next !== undefined)
                await switchModel(sessionID, next);
        };
        // `failed` just failed with a retryable error: select the model for the
        // next try and say when it is due.
        const decide = async (sessionID, failed) => {
            let streak = streaks.get(sessionID);
            let position = streak?.chain.findIndex((model) => sameModel(model, failed)) ?? -1;
            if (!streak || (failed !== undefined && position < 0)) {
                // First failure, or the model was changed by someone else mid-streak:
                // start over from the model that just failed.
                streak = { original: failed, chain: await chainFrom(failed), passes: streak?.passes ?? 0 };
                streaks.set(sessionID, streak);
                position = 0;
            }
            // With autoFallback, models that became unusable since the chain was built are passed over.
            let offset = position + 1;
            while (auto !== undefined && streak.chain[offset] !== undefined && isUnavailable(streak.chain[offset]))
                offset += 1;
            let next = streak.chain[offset];
            let delay = SWITCH_DELAY_MS;
            if (next !== undefined && !(await switchModel(sessionID, next)))
                next = undefined;
            if (next === undefined) {
                // Every model in the chain failed on this pass (or switching is not possible).
                if (mode === "stop" && streak.chain.length > 1)
                    return { retry: false };
                // Nothing usable is left and the failed model cannot serve either
                // (gone, or out of free allowance): waiting would only delay the failure.
                if (auto !== undefined && failed !== undefined && isUnavailable(failed))
                    return { retry: false };
                streak.passes += 1;
                delay = exponentialDelay(cooldownMs, streak.passes);
                const first = auto !== undefined ? streak.chain.find((model) => !isUnavailable(model)) : streak.chain[0];
                if (mode !== "retry-last" && first !== undefined && !sameModel(first, failed)) {
                    if (await switchModel(sessionID, first))
                        next = first;
                }
            }
            if (next !== undefined)
                streak.selected = next;
            return { retry: true, delay };
        };
        const promptRegistration = await context.session.hook("prompt", async (event) => {
            // A real user prompt starts a fresh backoff sequence on the session's own
            // model. The empty prompt used to resume a failed turn must preserve the
            // streak.
            if (event.prompt.text.trim().length === 0)
                return;
            cancelResume(event.sessionID);
            const streak = streaks.get(event.sessionID);
            streaks.delete(event.sessionID);
            if (streak)
                await restoreModel(event.sessionID, streak);
            if (auto !== undefined)
                await leaveUnusableModel(event.sessionID);
        });
        const retryRegistration = await context.session.hook("retry", async (event) => {
            if (!handlesError(event.error) || !handles(event.model))
                return;
            await noteFailure(event.model, event.error);
            cancelResume(event.sessionID);
            event.decision = await decide(event.sessionID, event.model);
        });
        // OpenCode has its own ceiling on retries and fails the turn once it is
        // reached, even when this plugin asked for another try. Such a turn is
        // resumed when the next try is due. An interrupted turn stays stopped.
        const abort = new AbortController();
        const onEvent = async (event) => {
            const sessionID = event.data?.sessionID;
            if (typeof sessionID !== "string")
                return;
            if (event.type === "session.deleted") {
                cancelResume(sessionID);
                streaks.delete(sessionID);
                return;
            }
            if (event.type !== "session.execution.failed")
                return;
            const streak = streaks.get(sessionID);
            if (!streak || !handlesError(event.data?.error))
                return;
            const failed = (await currentModel(sessionID)) ?? streak.selected ?? streak.original;
            if (!handles(failed))
                return;
            await noteFailure(failed, event.data?.error);
            const decision = await decide(sessionID, failed);
            if (decision.retry)
                scheduleResume(sessionID, decision.delay);
        };
        const watch = async (events) => {
            while (!abort.signal.aborted) {
                try {
                    for await (const event of events.subscribe({ signal: abort.signal })) {
                        void onEvent(event).catch(() => { });
                    }
                }
                catch {
                    // The stream broke; subscribe again below.
                }
                if (!abort.signal.aborted)
                    await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        };
        if (context.event)
            void watch(context.event);
        return async () => {
            abort.abort();
            await promptRegistration.dispose();
            await retryRegistration.dispose();
            for (const timer of resumeTimers.values())
                clearTimeout(timer);
            resumeTimers.clear();
            streaks.clear();
        };
    },
};
