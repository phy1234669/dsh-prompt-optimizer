/**
 * dsh-prompt-optimizer — browser half.
 *
 * Two UI pieces over the Host plugin's `/api/prompt-optimizer` HTTP surface:
 *   - `conversation.input.right`  — the compact on/off pill toggle sitting in the
 *     composer tool row (immediately left of the Send button), and
 *   - `conversation.composer.dock` — the change-notice banner rendered directly
 *     below the composer card, announcing every rewrite the Host performs
 *     (including its audit trail: original vs. chosen prompt).
 *
 * Hand-written `__ModuleLoader__` bundle (no build step, no JSX syntax — every
 * element goes through `react/jsx-runtime`). The slot runtime supplies the
 * standard kit and the locale seat (`t`); the plugin body registers the
 * `prompt-optimizer` dictionaries and the two slots.
 */
window.__ModuleLoader__.load({
	id: "dsh-prompt-optimizer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Dictionary namespace owned by this plugin. */
		const NS = "prompt-optimizer";
		/** HTTP prefix of the Host plugin's own endpoints. */
		const API_BASE = "/api/prompt-optimizer";
		/** Live state poll cadence while a slot is mounted and the tab visible. */
		const POLL_MS = 2000;
		/** How long a change notice stays expanded before collapsing to one muted line. */
		const NOTICE_EXPAND_MS = 10000;
		/** Module-level guard so the stylesheet is injected once per document. */
		let cssInjected = false;

		/**
		 * Extra stylesheet for this plugin's own variant card — the composer card the
		 * Host's `userQuestions.ask()` renders once a first prompt is at least
		 * `minPromptChars` long. The card itself belongs to
		 * `@deepseek-ai/dsh-client-ui-user-questions`, so nothing here may assume a
		 * hashed class name; every rule is scoped by the one thing only this card has —
		 * options labelled `A · …` — through `:has()`, and reaches the parts of the
		 * card by structure. Everything else in the app keeps the shipped look.
		 *
		 * Why it exists: at the default cap the card is `min(60vh, 520px)` tall with the
		 * whole comparison rendered above the choices, so on a 1440x900 window a reader
		 * sees zero of the four choices without scrolling inside the card. This raises
		 * the card to the full conversation column and `min(88vh, 940px)`, puts the
		 * choices first as their own panel, and marks the chosen row in the accent
		 * colour. Behaviour, markup, copy and the fourth row (free-text) are untouched.
		 */
		const CARD_CSS = `/* ==========================================================================
   dsh-prompt-optimizer — 变体选择卡片：放大 + 直观化
   --------------------------------------------------------------------------
   作用域：只命中本插件的选择卡片（它的前两个选项标签是 "A · …" / "B · …"），
   所以 DSH 里其它 ask_user_question 卡片完全不受影响。
   所有数值都基于 DSH 自己的 design token，浅色/深色自动跟随。
   ========================================================================== */

/* ---------- 1. 整卡：更大、更有层次 ---------- */

[data-question-key]:has(button[aria-label^="A · "]) {
  --po-q-accent: var(--dsw-alias-state-accent-primary, var(--dsw-alias-state-business-primary, #4176e6));
  padding: 10px calc(var(--dsh-composer-side-clearance) + 12px) 16px;
}

[data-question-key]:has(button[aria-label^="A · "]) > section {
  width: 100%;
  max-width: min(100%, 1120px);
  max-height: min(88vh, 940px);
  border-radius: 26px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-elevation-panel), 0 30px 70px -34px #000000a6;
  padding-bottom: 16px;
  animation: po_qcard_in .34s cubic-bezier(.2, .75, .25, 1);
}

@keyframes po_qcard_in {
  from { opacity: 0; transform: translateY(12px) scale(.986) }
  to   { opacity: 1; transform: none }
}

/* ---------- 2. 头部：把"它读懂了什么"做成一条强调色引导条 ---------- */

[data-question-key]:has(button[aria-label^="A · "]) > section > header {
  padding: 24px 24px 18px 30px;
  gap: 22px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: linear-gradient(180deg, color-mix(in oklab, var(--po-q-accent) 9%, transparent), transparent 78%);
}

[data-question-key]:has(button[aria-label^="A · "]) > section > header h2 {
  font-size: 19px;
  line-height: 27px;
  font-weight: 600;
  letter-spacing: -.01em;
}

/* 眉标（问题来源，例如「提示词优化」）→ 带呼吸点的强调色胶囊 */
[data-question-key]:has(button[aria-label^="A · "]) > section > header > div:first-child > div:first-child {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  padding: 3px 12px 3px 10px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--po-q-accent) 13%, transparent);
  color: var(--po-q-accent);
  font-size: 11.5px;
  line-height: 17px;
  font-weight: 600;
  letter-spacing: .02em;
}

[data-question-key]:has(button[aria-label^="A · "]) > section > header > div:first-child > div:first-child::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--po-q-accent);
  animation: po_breathe 1.6s ease-in-out infinite;
}

/* ---------- 3. 选项区：提到最上面，做成一块独立面板 ---------- */

[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] {
  padding: 6px 20px 0;
}

[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child {
  order: -1;
  margin: 14px 0 0;
  padding: 10px;
  gap: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
}

/* 每个选项：更高、更宽、有底色，形成一个可点的块 */
[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"] {
  min-height: 60px;
  padding: 13px 16px 13px 13px;
  gap: 13px;
  border: 1px solid transparent;
  border-radius: 14px;
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 1px 2px #0000000a;
  transition: background-color .16s, border-color .16s, box-shadow .16s, transform .16s;
  animation: po_qopt_in .38s cubic-bezier(.2, .75, .25, 1) backwards;
}

@keyframes po_qopt_in {
  from { opacity: 0; transform: translateY(10px) }
  to   { opacity: 1; transform: none }
}

[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"]:nth-of-type(1) { animation-delay: .03s }
[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"]:nth-of-type(2) { animation-delay: .08s }
[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"]:nth-of-type(3) { animation-delay: .13s }
[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"]:nth-of-type(4) { animation-delay: .18s }
[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"]:nth-of-type(5) { animation-delay: .23s }

[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"]:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--po-q-accent) 34%, transparent);
  background: color-mix(in oklab, var(--po-q-accent) 8%, var(--dsw-alias-bg-base));
  transform: translateY(-1px);
  box-shadow: 0 8px 22px -14px var(--po-q-accent);
}

[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"][aria-checked="true"] {
  border-color: var(--po-q-accent);
  background: color-mix(in oklab, var(--po-q-accent) 11%, var(--dsw-alias-bg-base));
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--po-q-accent) 26%, transparent), 0 10px 26px -16px var(--po-q-accent);
}

/* 序号徽章 */
[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"] > span:first-child,
[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > div:last-child > span:first-child {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  margin-top: 1px;
  border-radius: 9px;
  background: color-mix(in oklab, var(--po-q-accent) 13%, transparent);
  color: var(--po-q-accent);
  font-size: 13.5px;
  font-weight: 600;
  line-height: 19px;
}

/* 选项标题 / 说明的层级 */
[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"] > span:nth-child(2) > span > span:first-child {
  font-size: 15.5px;
  font-weight: 600;
  line-height: 24px;
}

[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"] > span:nth-child(2) > span > span:last-child:not(:first-child) {
  flex-basis: 100%;
  margin-top: 3px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13.5px;
  line-height: 21px;
  font-weight: 400;
}

/* 自由输入行：「写第三版」的入口，做成虚线槽位 */
[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > div:last-child {
  min-height: 56px;
  padding: 8px 12px 8px 8px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: 14px;
  background: transparent;
}

/* ---------- 4. 对照正文：挪到选项下面，收成次级材料 ---------- */

[data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:first-child {
  margin: 16px 0 0;
  padding: 14px 16px;
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: 16px;
  background: var(--dsw-alias-bg-module-platform);
  font-size: 13.5px;
  line-height: 21px;
}

/* ---------- 5. 底部操作条 ---------- */

[data-question-key]:has(button[aria-label^="A · "]) > section > footer {
  margin-top: 16px;
  padding: 14px 16px 0 24px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

[data-question-key]:has(button[aria-label^="A · "]) > section > footer > div:last-child button {
  min-height: 36px;
  padding: 0 18px;
  border-radius: 11px;
  font-size: 13.5px;
}

/* ---------- 6. 窄屏与「减少动态效果」 ---------- */

@media (width <= 720px) {
  [data-question-key]:has(button[aria-label^="A · "]) {
    padding: 8px calc(var(--dsh-composer-side-clearance) + 6px) 12px;
  }
  [data-question-key]:has(button[aria-label^="A · "]) > section {
    border-radius: 20px;
    max-height: min(90vh, 860px);
  }
  [data-question-key]:has(button[aria-label^="A · "]) > section > header {
    padding: 16px 14px 14px 18px;
  }
  [data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] {
    padding: 4px 12px 0;
  }
  [data-question-key]:has(button[aria-label^="A · "]) > section > footer {
    padding: 12px 12px 0 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-question-key]:has(button[aria-label^="A · "]) > section,
  [data-question-key]:has(button[aria-label^="A · "]) > section > header > div:first-child > div:first-child::before,
  [data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"] {
    animation: none;
  }
  [data-question-key]:has(button[aria-label^="A · "]) > section > div[data-question-scroll] > div:last-child > button[role="radio"] {
    transition: none;
  }
}
`;

		//#region css
		/**
		 * Inject the `po_`-prefixed stylesheet once per document.
		 * Theming rides host design tokens only, so light/dark and the user's
		 * accent color follow automatically.
		 * @returns nothing.
		 */
		function ensureCss() {
			if (cssInjected) return;
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-po-css]") !== null) {
				cssInjected = true;
				return;
			}
			const tag = document.createElement("style");
			tag.dataset.poCss = "prompt-optimizer";
			// Same convention as every shipped client plugin: the dev watcher drops
			// tags carrying its own id before re-running the factory, so a hot reload
			// re-injects fresh CSS instead of leaving this one stale.
			tag.dataset.plugin = "dsh-prompt-optimizer";
			tag.textContent = [
				// shared
				".po_sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
				// toggle pill (composer tool row) — mirrors the sibling model selector:
				// same 28px pill, same 13px/500 label, same hover fill and focus ring, so the
				// tool row reads as one control strip. Only the color changes when active.
				".po_pill{min-width:0;max-width:min(160px,45cqw);height:28px;box-sizing:border-box;display:flex;align-items:center;gap:4px;padding:0 4px 0 8px;border:none;border-radius:24px;outline:none;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer}",
				".po_pill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
				".po_pill:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
				".po_pill:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
				".po_pill:disabled:hover{background:0 0}",
				".po_pillOn{color:var(--dsw-alias-label-primary)}",
				".po_pillBusy{color:var(--dsw-alias-label-secondary)}",
				".po_pillLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".po_pillIcon{flex:none;display:block;color:var(--dsw-alias-label-caption);transition:color .12s}",
				".po_pillIconOn{color:var(--dsw-alias-state-accent-primary)}",
				"@keyframes po_spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
				".po_pillIconBusy{color:var(--dsw-alias-state-accent-primary);animation:po_spin 1s linear infinite}",
				// status dot — used by the change-notice banner only
				".po_dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
				".po_dotOn{background:var(--dsw-alias-state-accent-primary);animation:po_breathe 1.6s ease-in-out infinite}",
				"@keyframes po_breathe{0%,100%{opacity:.45;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}",
				// change-notice banner (composer dock)
				".po_banner{box-sizing:border-box;width:100%;margin:2px 0 0;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-left-width:3px;border-radius:7px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2);font-size:12px;line-height:17px;animation:po_in .18s ease-out}",
				"@keyframes po_in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}",
				".po_info{border-left-color:var(--dsw-alias-state-accent-primary)}",
				".po_success{border-left-color:var(--dsw-alias-state-success-primary)}",
				".po_warn{border-left-color:var(--dsw-alias-state-warning-primary)}",
				".po_muted{border-left-color:var(--dsw-alias-border-l2)}",
				".po_collapsed{padding:3px 8px;border-left-width:2px;background:transparent;box-shadow:none}",
				".po_row{display:flex;align-items:flex-start;gap:7px}",
				".po_main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
				".po_summary{color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;overflow-wrap:anywhere}",
				".po_collapsed .po_summary{font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-tertiary)}",
				".po_detailText{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px;overflow-wrap:anywhere}",
				".po_actions{flex:none;display:inline-flex;align-items:center;gap:4px}",
				".po_disc{padding:2px 7px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:15px;cursor:pointer}",
				".po_disc:hover{background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary)}",
				".po_disc:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary);outline-offset:1px}",
				".po_discOn{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
				".po_close{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border-radius:999px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:1;cursor:pointer}",
				".po_close:hover{background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary)}",
				".po_close:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary);outline-offset:1px}",
				".po_compare{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px}",
				".po_compareTitle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}",
				".po_pre{margin:0;padding:6px 8px;box-sizing:border-box;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:11.5px/16px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l1);border:1px solid var(--dsw-alias-border-l1);border-radius:5px}"
			].join("") + CARD_CSS;
			document.head.appendChild(tag);
			cssInjected = true;
		}
		//#endregion

		//#region http
		/**
		 * One guarded JSON fetch. Every failure (network, non-2xx, malformed body)
		 * resolves to null instead of throwing into React.
		 * @param path - URL path under the API prefix.
		 * @param init - optional fetch init.
		 * @returns parsed JSON object, or null when the request failed.
		 */
		async function requestJson(path, init) {
			try {
				const response = await fetch(path, init);
				if (!response || !response.ok) return null;
				const value = await response.json();
				if (value === null || typeof value !== "object") return null;
				return value;
			} catch (error) {
				return null;
			}
		}

		/**
		 * Read the Host plugin's current state.
		 * @returns the state object, or null when unreachable.
		 */
		async function fetchState() {
			return requestJson(`${API_BASE}/state`, { cache: "no-store" });
		}

		/**
		 * Ask the Host to persist a new enabled flag.
		 * @param enabled - desired state.
		 * @returns the returned state object, or null when unreachable.
		 */
		async function postToggle(enabled) {
			return requestJson(`${API_BASE}/toggle`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled })
			});
		}

		/**
		 * Acknowledge one dismissed notice (best-effort; failures are ignored).
		 * @param at - the notice's `at` timestamp.
		 * @returns a promise resolving when the attempt settled.
		 */
		async function ackNotice(at) {
			try {
				await fetch(`${API_BASE}/ack`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ at })
				});
			} catch (error) {
				// best-effort: an unreachable Host keeps the dismissal client-side.
			}
		}
		//#endregion

		//#region state hub
		/**
		 * Shared, single-flight state source behind both slots: one poller, one
		 * snapshot, one subscriber set. Polling starts with the first subscriber
		 * (the toggle's mount) and stops with the last — StrictMode's double mount
		 * disposes and re-subscribes, so the interval never leaks — and it pauses
		 * whenever the tab is hidden.
		 * @returns the hub face consumed by both components.
		 */
		function createStateHub() {
			/** Subscribers re-rendered on every snapshot or error-flag change. */
			const listeners = new Set();
			/** Last state object seen from the Host (kept across transient failures). */
			let snapshot = null;
			/** Whether the last request failed — drives the muted "cannot reach host" line. */
			let offline = false;
			/** Offline marker; identity changes only at the edges. */
			let error = null;
			/** Active poll interval, or null while stopped. */
			let timer = null;
			/** Bound visibility listener while polling is active. */
			let onVisibilityChange = null;
			/** Whether a fetch is already in flight. */
			let pending = false;

			/**
			 * Publish the current snapshot plus the offline marker to subscribers.
			 * @returns nothing.
			 */
			function emit() {
				error = offline ? { offline: true } : null;
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (listenerError) {
						// A broken subscriber must not break the shared poller.
					}
				}
			}

			/**
			 * Adopt one fresh state object (or record a failure) and notify subscribers.
			 * @param value - state object from the Host, or null when unreachable.
			 * @returns nothing.
			 */
			function load(value) {
				if (value === null) {
					const wasOffline = offline;
					offline = true;
					if (!wasOffline) emit();
					return;
				}
				snapshot = value;
				offline = false;
				emit();
			}

			/**
			 * Fetch once, unless the tab is hidden or a fetch is already in flight.
			 * @returns a promise resolving when the tick settled.
			 */
			async function refresh() {
				if (pending) return;
				if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
				pending = true;
				try {
					load(await fetchState());
				} finally {
					pending = false;
				}
			}

			/** Begin polling: one immediate tick, then the cadence plus a visible-tab catch-up. */
			function startPolling() {
				if (timer !== null) return;
				void refresh();
				timer = setInterval(() => {
					void refresh();
				}, POLL_MS);
				onVisibilityChange = () => {
					if (document.visibilityState === "visible") void refresh();
				};
				document.addEventListener("visibilitychange", onVisibilityChange);
			}

			/** Stop polling and detach the visibility listener. */
			function stopPolling() {
				if (timer !== null) {
					clearInterval(timer);
					timer = null;
				}
				if (onVisibilityChange !== null) {
					document.removeEventListener("visibilitychange", onVisibilityChange);
					onVisibilityChange = null;
				}
			}

			return {
				/**
				 * Read the current snapshot for `useSyncExternalStore`.
				 * @returns the last state object, or null before the first success.
				 */
				getSnapshot: () => snapshot,
				/**
				 * Read the unreachable marker for `useSyncExternalStore`.
				 * @returns the offline marker object, or null while healthy.
				 */
				getError: () => error,
				/**
				 * Register one subscriber; the first one starts polling.
				 * @param listener - change callback.
				 * @returns unsubscribe, stopping polling when it was the last one.
				 */
				subscribe: (listener) => {
					listeners.add(listener);
					if (listeners.size === 1) startPolling();
					return () => {
						listeners.delete(listener);
						if (listeners.size === 0) stopPolling();
					};
				},
				/**
				 * Persist a new enabled flag and adopt the returned state immediately.
				 * @param enabled - desired state.
				 * @returns the returned state object, or null on failure.
				 */
				toggle: async (enabled) => {
					const value = await postToggle(enabled);
					load(value);
					return value;
				},
				/**
				 * Acknowledge a dismissed notice (best-effort).
				 * @param at - the notice's `at` timestamp.
				 * @returns a promise resolving when the attempt settled.
				 */
				ack: (at) => ackNotice(at)
			};
		}

		/** Module-level hub shared by both registered slots. */
		const stateHub = createStateHub();
		//#endregion

		//#region locales
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"toggle.on": "提示词优化 开",
			"toggle.off": "提示词优化 关",
			"toggle.busy": "优化中…",
			"toggle.on.title": "本会话提示词优化已开启 — 发送前会把首条提示词改写成更清晰的版本，点击关闭",
			"toggle.off.title": "本会话提示词优化已关闭 — 点击开启，首条提示词将被自动优化",
			"toggle.busy.title": "正在写入优化开关…",
			"toggle.on.aria": "提示词优化已开启，按下关闭",
			"toggle.off.aria": "提示词优化已关闭，按下开启",
			"toggle.busy.aria": "提示词优化正在切换",
			"banner.dismiss": "关闭通知",
			"banner.show": "查看对比",
			"banner.hide": "收起对比",
			"banner.compareTitle": "优化前 / 优化后",
			"banner.expired": "已过期",
			"banner.restored": "上次 · ",
			"banner.offline": "无法连接宿主"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"toggle.on": "Prompt opt on",
			"toggle.off": "Prompt opt off",
			"toggle.busy": "Optimizing…",
			"toggle.on.title": "Prompt optimization is on for this session — your first prompt is rewritten for clarity before it is sent; click to turn off",
			"toggle.off.title": "Prompt optimization is off for this session — click to rewrite your first prompt automatically",
			"toggle.busy.title": "Writing the prompt-optimizer switch…",
			"toggle.on.aria": "Prompt optimization on, press to turn off",
			"toggle.off.aria": "Prompt optimization off, press to turn on",
			"toggle.busy.aria": "Prompt optimization is switching",
			"banner.dismiss": "Dismiss notice",
			"banner.show": "Show comparison",
			"banner.hide": "Hide comparison",
			"banner.compareTitle": "Original / optimized",
			"banner.expired": "expired",
			"banner.offline": "Cannot reach host"
		};
		//#endregion

		//#region components
		/**
		 * Map a notice kind onto its `po_` tone class.
		 * @param kind - Host-declared notice kind.
		 * @returns the tone class suffix.
		 */
		function toneOf(kind) {
			if (kind === "success") return "success";
			if (kind === "warn") return "warn";
			if (kind === "muted") return "muted";
			return "info";
		}

		/**
		 * Compact on/off pill for `conversation.input.right`. Hidden until a Session
		 * exists (including the no-Session inert shell); clicking POSTs the new flag
		 * and adopts the returned state the moment it arrives.
		 * @param props - standard slot props (`t`) plus the injected HTTP face.
		 * @returns the pill element, or null without a Session.
		 */
		function OptimizerToggle({ sessionId, getState, toggle, t }) {
			ensureCss();
			const snapshot = react.useSyncExternalStore(stateHub.subscribe, stateHub.getSnapshot, stateHub.getSnapshot);
			const [busy, setBusy] = react.useState(false);
			const aliveRef = react.useRef(true);
			react.useEffect(() => {
				aliveRef.current = true;
				return () => {
					aliveRef.current = false;
				};
			}, []);
			if (sessionId === void 0 || sessionId === null) return null;
			const enabled = snapshot !== null && snapshot.enabled === true;
			const label = busy ? t("toggle.busy") : enabled ? t("toggle.on") : t("toggle.off");
			const title = busy ? t("toggle.busy.title") : enabled ? t("toggle.on.title") : t("toggle.off.title");
			const ariaLabel = busy ? t("toggle.busy.aria") : enabled ? t("toggle.on.aria") : t("toggle.off.aria");
			const className = "po_pill" + (enabled ? " po_pillOn" : "") + (busy ? " po_pillBusy" : "");
			// The icon mirrors the sibling model selector's leading glyph: a caption-colored
			// 16px mark that turns accent when the optimizer is active, and a spinner while
			// the toggle is in flight. It is best-effort: an icon missing from the primitives
			// build degrades to the label alone rather than breaking the control.
			const iconClass = "po_pillIcon" + (busy ? " po_pillIconBusy" : enabled ? " po_pillIconOn" : "");
			const Icon = busy ? primitives.IconLoadingOutline16 : primitives.IconEnhanceOutline16;
			const icon = typeof Icon === "function" ? react_jsx_runtime.jsx(Icon, { className: iconClass, "aria-hidden": true }) : null;
			/**
			 * Flip the switch over HTTP, holding the busy label until the Host answers.
			 * @returns a promise resolving when the click settled.
			 */
			const onClick = () => {
				if (busy) return;
				setBusy(true);
				const finish = () => {
					if (aliveRef.current) setBusy(false);
				};
				try {
					const result = toggle(!enabled);
					if (result !== null && typeof result === "object" && typeof result.then === "function") result.then(finish, finish);
					else finish();
				} catch (clickError) {
					finish();
				}
			};
			return react_jsx_runtime.jsxs("button", {
				type: "button",
				className,
				title,
				"aria-label": ariaLabel,
				"aria-pressed": enabled,
				"aria-busy": busy,
				"data-po-state": busy ? "busy" : enabled ? "on" : "off",
				onClick,
				children: [
					icon,
					react_jsx_runtime.jsx("span", { className: "po_pillLabel", children: label })
				]
			});
		}

		/**
		 * Pure change-notice decision, shared by the banner and its tests.
		 *
		 * A notice is shown whenever the Host still holds one that this mount has not
		 * dismissed — including one recorded *before* the mount. An earlier revision
		 * dropped any notice stamped before the component mounted, which silently ate
		 * exactly the reports that matter most: a Host restart re-mounts the banner,
		 * so a failure recorded just beforehand ("优化失败（TIMEOUT_OR_ABORT），已按原话
		 * 继续") could never be read on the page. Expiry is a display state here, not
		 * a reason to hide: `restored` marks a notice this mount did not witness, and
		 * such a row opens collapsed so it cannot be mistaken for breaking news.
		 *
		 * A live notice stays expanded for NOTICE_EXPAND_MS after this client first
		 * rendered it (`seenAt`, tracked separately from the notice's own `at` stamp).
		 * Host clocks may lead ours, so a future stamp is accepted rather than dropped.
		 *
		 * @param notice - `lastChange` from the Host state, or null.
		 * @param input - `{ mountedAt, dismissedAt, seenAt, now }` client timestamps (ms).
		 * @returns `{ visible, fresh, restored, tone, detail, detailText }` for one render.
		 */
		function noticeView(notice, input) {
			const raw = notice !== null && typeof notice === "object" ? notice : null;
			const at = raw !== null && typeof raw.at === "number" && raw.at > 0 ? raw.at : 0;
			const visible = raw !== null && at > 0 && at !== input.dismissedAt;
			if (!visible) return { visible: false, fresh: false, restored: false, tone: "muted", detail: "", detailText: "" };
			const firstSeen = typeof input.seenAt === "number" ? input.seenAt : input.now;
			const detailText = typeof raw.detail === "string" ? raw.detail : "";
			const restored = at < input.mountedAt;
			return {
				visible: true,
				// A restored notice is never expanded on arrival: the user did not watch it
				// happen, so it announces itself as a folded line with its timing shown.
				fresh: !restored && input.now - firstSeen < NOTICE_EXPAND_MS,
				restored,
				tone: toneOf(raw.kind),
				detail: detailText,
				detailText
			};
		}

		/**
		 * Change-notice banner for `conversation.composer.dock`: announces one rewrite
		 * with a tone-colored border and status dot, expands to a scrollable
		 * comparison when the notice carries `detail`, collapses after ten seconds
		 * into a muted one-liner that survives until dismissed, and renders nothing
		 * when no notice is fresh for this Session.
		 * @param props - standard slot props (`t`) plus the injected HTTP face.
		 * @returns the banner element, or null when there is nothing to announce.
		 */
		function NoticeBanner({ sessionId, ack, t }) {
			ensureCss();
			const snapshot = react.useSyncExternalStore(stateHub.subscribe, stateHub.getSnapshot, stateHub.getSnapshot);
			const error = react.useSyncExternalStore(stateHub.subscribe, stateHub.getError, stateHub.getError);
			const [dismissedAt, setDismissedAt] = react.useState(null);
			const [expanded, setExpanded] = react.useState(false);
			const now = Date.now();
			const [seenAt, setSeenAt] = react.useState(now);
			const mountedAtRef = react.useRef(null);
			const seenStampRef = react.useRef(null);
			if (mountedAtRef.current === null) mountedAtRef.current = now;
			const notice = snapshot !== null && snapshot.lastChange !== undefined && snapshot.lastChange !== null && typeof snapshot.lastChange === "object" ? snapshot.lastChange : null;
			if (notice !== null && typeof notice.at === "number" && notice.at > 0 && seenStampRef.current !== notice.at) {
				// First render of a change this mount has not seen yet: start its
				// expanded window and collapse any comparison left open.
				seenStampRef.current = notice.at;
				setSeenAt(now);
				setExpanded(false);
			}
			const view = noticeView(notice, {
				mountedAt: mountedAtRef.current,
				dismissedAt,
				seenAt,
				now
			});
			const offline = error !== null && error !== void 0;
			if (sessionId === void 0 || sessionId === null) return null;
			if (!view.visible && !offline) return null;
			// A notice names the session it belongs to, so a switch of the sidebar must
			// not replay another conversation's rewrite here. Notices with no session
			// (a toggle flip) stay global.
			const noticeSession = notice !== null && typeof notice.sessionId === "string" ? notice.sessionId : null;
			if (view.visible && noticeSession !== null && noticeSession !== String(sessionId)) return null;
			/**
			 * Dismiss the current notice: acknowledge it Host-side (best-effort) and
			 * hide it locally for the lifetime of this mount.
			 * @returns nothing.
			 */
			const onDismiss = () => {
				const stamp = notice !== null && typeof notice.at === "number" ? notice.at : 0;
				setDismissedAt(stamp);
				setExpanded(false);
				const result = ack(stamp);
				if (result !== null && typeof result === "object" && typeof result.then === "function") result.then(void 0, void 0);
			};
			/**
			 * Toggle the comparison disclosure (the audit trail).
			 * @returns nothing.
			 */
			const onToggleExpanded = () => {
				setExpanded((value) => !value);
			};
			const offlineOnly = !view.visible && offline;
			// `folded` is the one-line shape: either the notice already aged out of its
			// expanded window, or this mount is reading one it did not witness.
			const folded = view.visible && (!view.fresh || view.restored);
			const tone = offlineOnly || view.restored ? "muted" : view.tone;
			const summary = offlineOnly
				? t("banner.offline")
				: folded
					? `${view.restored ? t("banner.restored") : ""}${notice.summary} · ${t("banner.expired")}`
					: notice.summary;
			const detailLine = view.visible && !folded && view.detail === "" && view.detailText !== "" ? view.detailText : "";
			const className = "po_banner po_" + tone + (folded || offlineOnly ? " po_collapsed" : "");
			const rowChildren = [
				react_jsx_runtime.jsx("span", { className: "po_dot" + (folded || offlineOnly ? "" : " po_dotOn"), "aria-hidden": true }),
				react_jsx_runtime.jsxs("div", {
					className: "po_main",
					children: [
						react_jsx_runtime.jsx("span", { className: "po_summary", children: summary }),
						detailLine !== "" ? react_jsx_runtime.jsx("span", { className: "po_detailText", children: detailLine }) : null
					]
				})
			];
			const actionChildren = [];
			if (view.visible && view.detail !== "") {
				actionChildren.push(react_jsx_runtime.jsx("button", {
					type: "button",
					className: "po_disc" + (expanded ? " po_discOn" : ""),
					"aria-expanded": expanded,
					onClick: onToggleExpanded,
					children: expanded ? t("banner.hide") : t("banner.show")
				}, "disc"));
			}
			if (!offlineOnly) {
				actionChildren.push(react_jsx_runtime.jsx("button", {
					type: "button",
					className: "po_close",
					"aria-label": t("banner.dismiss"),
					title: t("banner.dismiss"),
					onClick: onDismiss,
					children: "✕"
				}, "close"));
			}
			if (actionChildren.length > 0) {
				rowChildren.push(react_jsx_runtime.jsx("div", { className: "po_actions", children: actionChildren }));
			}
			const children = [react_jsx_runtime.jsx("div", { className: "po_row", children: rowChildren })];
			if (view.visible && view.detail !== "" && expanded) {
				children.push(react_jsx_runtime.jsxs("div", {
					className: "po_compare",
					children: [
						react_jsx_runtime.jsx("span", { className: "po_compareTitle", children: t("banner.compareTitle") }),
						react_jsx_runtime.jsx("pre", { className: "po_pre", children: view.detail })
					]
				}, "compare"));
			}
			return react_jsx_runtime.jsx("div", {
				className,
				"data-po-kind": tone,
				role: "status",
				"aria-live": "polite",
				children
			});
		}
		//#endregion

		/** Services required by the client plugin body. */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: register the `prompt-optimizer` dictionaries and the
		 * toggle / change-notice slots.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "prompt-optimizer: dictionaries");
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "prompt-optimizer-toggle",
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					getState: () => fetchState(),
					toggle: (enabled) => stateHub.toggle(enabled),
					ack: (at) => stateHub.ack(at)
				})
			}, OptimizerToggle));
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "prompt-optimizer-notice",
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					getState: () => fetchState(),
					toggle: (enabled) => stateHub.toggle(enabled),
					ack: (at) => stateHub.ack(at)
				})
			}, NoticeBanner));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.noticeView = noticeView;
		exports.toneOf = toneOf;
		return module.exports;
	}
});
