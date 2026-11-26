window.__ModuleLoader__.load({
  id: '@wordpost/dsh-composer-predictions',
  factory(require) {
    const React = require('react');
    const { createElement: h, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = React;
    const overlaySlot = 'conversation.input.overlay';
    const toolbarSlot = 'conversation.input.left';
    const settingsSlot = 'settings.general.item';
    const autoPreferenceKey = 'wordpost.composer-predictions.auto';
    const dismissalLifetime = 15 * 60 * 1000; // At least as long as a Host suggestion can be fresh.
    const namespace = 'local-composer-predictions';
    const editableSelector = '[data-composer-input][contenteditable="true"]:not([data-composer-composing])';
    const placeholderSelector = '[data-composer-placeholder]';
    const triggerMenu = '[data-trigger-menu], button[aria-haspopup="listbox"][aria-expanded="true"]';
    const emptyCard = `[data-composer-card]:has(${editableSelector} + ${placeholderSelector}):not(:has(${triggerMenu}))`;
    const activeCard = `${emptyCard}:has(${editableSelector}:focus, .dsh-next-message-accept:focus):has(> [data-composer-overlay] .dsh-next-message)`;
    const styles = `
      .dsh-next-message {
        display:none; position:absolute; z-index:1; box-sizing:border-box;
        /* Resident empty editor's text line: its top inset is 8px + 4px. */
        inset:12px 12px auto 14px; min-width:0;
        align-items:center; gap:8px; padding:0; border:0; background:transparent;
        font:inherit; text-align:start; pointer-events:none;
      }
      ${activeCard} > [data-composer-overlay] .dsh-next-message { display:flex; }
      ${activeCard} ${editableSelector} + ${placeholderSelector} { visibility:hidden; }
      .dsh-next-message-text { min-width:0; flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
        color:var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary)); user-select:none; }
      .dsh-next-message-accept { flex:none; font:inherit; font-size:.77em; line-height:1.4; padding:0 4px;
        border:1px solid var(--dsw-alias-border-l2); border-radius:4px; background:transparent;
        color:var(--dsw-alias-label-secondary); cursor:pointer; pointer-events:auto; }
      .dsh-next-message-accept:hover, .dsh-next-message-accept:focus-visible { color:var(--dsw-alias-label-primary); }
      .dsh-next-message-accept:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
      .dsh-next-message-dismiss { display:grid; place-items:center; min-width:20px; min-height:20px; }
      .dsh-next-message-announcement { position:absolute; width:1px; height:1px;
        overflow:hidden; clip-path:inset(50%); white-space:nowrap; visibility:hidden; }
      ${activeCard} > [data-composer-overlay] .dsh-next-message-announcement { visibility:visible; }
      .dsh-next-message-accept kbd { font:inherit; }
      .dsh-next-message-accept kbd + span { display:none; }
      @media (pointer:coarse) {
        .dsh-next-message-accept { min-height:28px; }
        .dsh-next-message-accept kbd { display:none; }
        .dsh-next-message-accept kbd + span { display:inline; }
      }
    `;

    const toolbarStyles = `
      .dsh-next-message-generate, .dsh-draft-rewrite-open {
        display:none; place-items:center; flex:none; width:28px; height:28px; padding:0;
        border:0; border-radius:999px; background:var(--dsw-alias-bg-layer-2);
        color:var(--dsw-alias-label-secondary); cursor:pointer;
      }
      ${emptyCard} .dsh-next-message-generate { display:grid; }
      .dsh-next-message-generate:disabled { cursor:progress; }
      [data-composer-card]:has(${editableSelector}):not(:has(${editableSelector} [data-composer-quote], ${editableSelector} [data-composer-command])) .dsh-draft-rewrite-open { display:grid; }
      .dsh-next-message-generate:hover:not(:disabled), .dsh-draft-rewrite-open:hover:not(:disabled) { color:var(--dsw-alias-label-primary); }
      .dsh-next-message-generate:focus-visible, .dsh-draft-rewrite-open:focus-visible,
      .dsh-draft-rewrite button:focus-visible, .dsh-draft-rewrite-text:focus-visible {
        outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px;
      }
      .dsh-draft-rewrite {
        box-sizing:border-box; width:min(42rem, calc(100vw - 2rem)); max-height:calc(100dvh - 2rem); overflow:auto;
        padding:16px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
        background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit;
      }
      .dsh-draft-rewrite::backdrop { background:color-mix(in srgb, var(--dsw-alias-label-primary) 25%, transparent); }
      .dsh-draft-rewrite h2, .dsh-draft-rewrite h3 { margin:0 0 6px; font-size:inherit; font-weight:600; }
      .dsh-draft-rewrite-versions { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap:12px; }
      .dsh-draft-rewrite-text { max-height:min(33vh, 16rem); overflow:auto; overflow-wrap:anywhere;
        white-space:pre-wrap; padding:8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); }
      .dsh-draft-rewrite-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
      .dsh-draft-rewrite button { border:1px solid var(--dsw-alias-border-l2); border-radius:6px;
        color:inherit; background:var(--dsw-alias-bg-layer-2); font:inherit; padding:4px 10px; cursor:pointer; }
      .dsh-draft-rewrite button:disabled { color:var(--dsw-alias-label-secondary); cursor:default; }
      .dsh-next-message-spinner { box-sizing:border-box; width:13px; height:13px; border:1.5px solid currentColor;
        border-right-color:transparent; border-radius:50%; }
      @media (prefers-reduced-motion:no-preference) {
        .dsh-next-message-spinner { animation:dsh-next-message-spin .8s linear infinite; }
      }
      @keyframes dsh-next-message-spin { to { transform:rotate(360deg); } }
      .dsh-next-message-status { min-width:0; color:var(--dsw-alias-label-secondary);
        font-size:.8em; line-height:1.25; white-space:normal; overflow-wrap:anywhere; }
      .dsh-next-message-status:not([data-visible]) { position:absolute; width:1px; height:1px;
        overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
    `;

    const settingsStyles = `
      .dsh-prediction-setting { display:flex; align-items:center; gap:16px; padding:16px 0;
        border-bottom:1px solid var(--dsw-alias-border-l2); }
      .dsh-prediction-setting-text { flex:1; min-width:0; }
      .dsh-prediction-setting-title { font-size:14px; line-height:22px; color:var(--dsw-alias-label-primary); }
      .dsh-prediction-setting-desc { margin-top:4px; font-size:12px; line-height:18px;
        color:var(--dsw-alias-label-secondary); }
      .dsh-prediction-setting-switch { position:relative; flex:none; width:44px; height:26px; border:0;
        padding:0; border-radius:999px; background:var(--dsw-alias-state-idle-primary); cursor:pointer; }
      .dsh-prediction-setting-switch[aria-checked='true'] { background:var(--dsw-alias-brand-primary); }
      .dsh-prediction-setting-switch::after { content:''; position:absolute; inset-block-start:3px;
        inset-inline-start:3px; width:20px; height:20px; border-radius:50%; background:var(--dsw-alias-bg-layer-1); }
      .dsh-prediction-setting-switch[aria-checked='true']::after { inset-inline-start:21px; }
      .dsh-prediction-setting-switch:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
    `;

    function AutoSuggestionSetting({ t, preference }) {
      const enabled = useSyncExternalStore(preference.subscribe, preference.snapshot);
      const [failed, setFailed] = useState(false);
      const label = useId();
      const description = useId();
      return h('div', { className: 'dsh-prediction-setting' },
        h('style', null, settingsStyles),
        h('div', { className: 'dsh-prediction-setting-text' },
          h('div', { id: label, className: 'dsh-prediction-setting-title' }, t('autoSuggestions')),
          h('div', { id: description, className: 'dsh-prediction-setting-desc' }, t('autoSuggestionsDetail')),
          failed && h('div', { className: 'dsh-prediction-setting-desc', role: 'status' }, t('autoSuggestionsSaveError'))),
        h('button', { type: 'button', role: 'switch', className: 'dsh-prediction-setting-switch',
          'aria-labelledby': label, 'aria-describedby': description, 'aria-checked': enabled,
          onClick: () => {
            try { preference.set(!enabled); setFailed(false); } catch { setFailed(true); }
          },
        }));
    }

    function isEmpty(input) {
      return input.phase === 'plain' && input.draft === '' && input.attachmentIds.length === 0
        && input.occurrences.length === 0;
    }

    function createAutoPreference() {
      let enabled = true;
      let storage;
      try {
        storage = window.localStorage;
        enabled = storage.getItem(autoPreferenceKey) !== 'off';
      } catch { /* storage may be blocked */ }
      const listeners = new Set();
      function publish(next) {
        if (next === enabled) return;
        enabled = next;
        for (const listener of listeners) listener();
      }
      return {
        snapshot: () => enabled,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        set(next) {
          if (!storage) throw new Error('Preference storage unavailable');
          storage.setItem(autoPreferenceKey, next ? 'on' : 'off');
          publish(next);
        },
        observe() {
          const onStorage = event => {
            if (event.storageArea === storage && (event.key === autoPreferenceKey || event.key === null)) {
              publish(event.newValue !== 'off');
            }
          };
          window.addEventListener('storage', onStorage);
          return () => window.removeEventListener('storage', onStorage);
        },
      };
    }

    // Both composer slots subscribe to one request and one result per mounted session.
    function createPredictionStore(preference) {
      const entries = new Map();
      const dismissedTurns = new Map();
      const initial = { phase: 'auto' };

      function publish(entry, state) {
        entry.state = state;
        for (const listener of entry.listeners) listener();
      }

      const errorLabels = new Map([
        ['timeout', 'suggestionTimeout'], ['rateLimited', 'suggestionRateLimited'],
        ['modelError', 'suggestionModelError'], ['invalidResponse', 'suggestionInvalidResponse'],
      ]);

      async function request(sessionId, entry, manual = false, retry = null, fromAvailability = false) {
        const now = Date.now();
        for (const [id, dismissal] of dismissedTurns) {
          if (dismissal.expires > now) break;
          dismissedTurns.delete(id);
        }
        entry.controller?.abort();
        const controller = new AbortController();
        entry.controller = controller;
        const availability = retry === null && (fromAvailability || (!manual && !preference.snapshot()));
        const params = new URLSearchParams({ session: sessionId });
        if (retry !== null) params.set('retry', retry);
        if (availability) params.set('availability', '1');
        // Resend the same key on network failure: Host joins/retrieves the same attempt.
        let result = { phase: 'ready', retry, availability, status: 'suggestionConnectionError' };
        try {
          const response = await fetch(`api/local-composer-predictions/next?${params}`, {
            method: 'POST', credentials: 'same-origin', signal: controller.signal,
          });
          if (!response.ok) {
            if (response.status === 429) {
              result = { phase: 'ready', retry, availability, status: 'suggestionRateLimited' };
            } else if (response.status >= 400 && response.status < 500) {
              result = { phase: 'finished', status: 'suggestionUnavailable' };
            }
          } else {
            const body = await response.json();
            const status = errorLabels.get(body?.reason);
            const turn = Number.isSafeInteger(body?.turn) ? body.turn : null;
            const dismissed = dismissedTurns.get(sessionId);
            if (controller.signal.aborted) return;
            if (dismissed && turn !== null && dismissed.turn !== turn) dismissedTurns.delete(sessionId);
            if (dismissed?.turn === turn) {
              result = { phase: 'finished' };
            } else if (typeof body?.suggestion === 'string' && body.suggestion.length > 0 && [...body.suggestion].length <= 240) {
              result = { phase: 'suggestion', text: body.suggestion, turn };
            } else if (typeof body?.retry === 'string' && /^\d+:\d+$/u.test(body.retry)) {
              if (manual && availability && !controller.signal.aborted) {
                // Finish a user-initiated request after recovering a failed availability check.
                void request(sessionId, entry, true, body.retry);
                return;
              }
              result = { phase: 'ready', retry: body.retry, status };
            } else if (body?.suggestion === null && body.retry === null) {
              result = { phase: 'finished', status: status ? 'suggestionAttemptsExhausted' : manual ? 'noSuggestion' : undefined,
                detail: status };
            }
          }
        } catch {
          // Do not surface raw transport errors or affect the composer.
        }
        if (!controller.signal.aborted) publish(entry, result);
      }

      return {
        subscribe(sessionId, listener) {
          let entry = entries.get(sessionId);
          if (!entry) {
            entry = { state: initial, listeners: new Set() };
            entries.set(sessionId, entry);
            void request(sessionId, entry);
          }
          entry.listeners.add(listener);
          return () => {
            entry.listeners.delete(listener);
            if (entry.listeners.size > 0) return;
            entries.delete(sessionId);
            entry.controller?.abort();
          };
        },
        snapshot: sessionId => entries.get(sessionId)?.state ?? initial,
        retry(sessionId) {
          const entry = entries.get(sessionId);
          if (entry?.state.phase !== 'ready') return;
          const { retry, availability } = entry.state;
          publish(entry, { phase: 'manual' });
          void request(sessionId, entry, true, retry, availability);
        },
        dismiss(sessionId) {
          const entry = entries.get(sessionId);
          if (entry?.state.phase !== 'suggestion') return false;
          if (entry.state.turn !== null) {
            dismissedTurns.delete(sessionId);
            dismissedTurns.set(sessionId, { turn: entry.state.turn, expires: Date.now() + dismissalLifetime });
          }
          publish(entry, { phase: 'finished' });
          return true;
        },
        preferenceChanged() {
          for (const [sessionId, entry] of entries) {
            if (entry.state.phase === 'manual') continue;
            publish(entry, initial);
            void request(sessionId, entry);
          }
        },
      };
    }

    function usePrediction(store, sessionId) {
      const subscribe = useCallback(fn => store.subscribe(sessionId, fn), [store, sessionId]);
      return useSyncExternalStore(subscribe, () => store.snapshot(sessionId));
    }

    // undefined: do not mount; null: keep the candidate but hide it; number: empty draft revision.
    function predictionRevision(input) {
      if (!input || input.phase === 'sending' || input.queue.length > 0) return undefined;
      return isEmpty(input) ? input.draftRev : null;
    }

    function Prediction({ ctx, t, store, sessionId, revision, inputActions }) {
      const state = usePrediction(store, sessionId);
      const candidate = state.phase === 'suggestion' ? state.text : null;
      const button = useRef(null);
      const dismissButton = useRef(null);
      const empty = revision !== null;
      const label = t('insert');
      const action = t('action');
      const dismissHint = t('dismissHint');
      const shortcuts = ctx.get('shortcuts');
      const current = useRef(null);
      useLayoutEffect(() => {
        current.current = { revision, empty, candidate };
        return () => { current.current = null; };
      });

      function accept() {
        const now = current.current;
        if (!now?.candidate || !now.empty) return false;
        const editor = button.current?.closest(activeCard)?.querySelector(editableSelector);
        if (!editor) return false;
        // Lexical only moves the visible caret with the edit if the editor already has focus.
        if (editor.ownerDocument.activeElement !== editor) editor.focus({ preventScroll: true });
        const span = inputActions.captureInsertion();
        if (span.start !== 0 || span.end !== 0 || span.draftRev !== now.revision) return false;
        if (!inputActions.insertText(now.candidate, span)) return false;
        store.dismiss(sessionId);
        current.current = { ...now, empty: false };
        return true;
      }

      function dismiss() {
        if (!current.current?.empty) return false;
        const editor = button.current?.closest(activeCard)?.querySelector(editableSelector);
        if (!editor || !store.dismiss(sessionId)) return false;
        if (editor.ownerDocument.activeElement !== editor) editor.focus({ preventScroll: true });
        current.current = null;
        return true;
      }

      const visible = empty && candidate !== null;
      useEffect(() => {
        if (!visible || !shortcuts) return;
        return shortcuts.observeFixedInput((event) => {
          if (event.type !== 'keydown') return;
          const { gesture, context } = event;
          if ((gesture.code !== 'Tab' && gesture.code !== 'Escape') || gesture.repeat || gesture.composing
            || gesture.defaultPrevented || gesture.shift || gesture.alt || gesture.control || gesture.meta
            || context.modal !== null || !current.current?.empty) return;
          const actionButton = button.current;
          const editable = context.target?.closest(editableSelector);
          const card = actionButton?.closest(activeCard);
          if (!card) return;
          const inEditor = editable && card === editable.closest('[data-composer-card]');
          if (gesture.code === 'Tab') {
            if (inEditor && accept()) event.consume();
          } else if ((inEditor || actionButton?.contains(context.target) || dismissButton.current?.contains(context.target))
            && dismiss()) event.consume();
        });
      }, [visible, shortcuts, inputActions, store, sessionId]);

      return h(React.Fragment, null,
        h('style', null, styles),
        h('span', { className: 'dsh-next-message-announcement', role: 'status', 'aria-atomic': true },
          visible ? `${t(shortcuts ? 'suggestionReady' : 'suggestionReadyWithoutTab')} ${candidate}` : ''),
        visible && h('div', { className: 'dsh-next-message' },
          h('span', { className: 'dsh-next-message-text', 'aria-hidden': true }, candidate),
          h('button', {
            ref: button, type: 'button', className: 'dsh-next-message-accept',
            title: `${label}: ${candidate}`,
            'aria-label': `${label}: ${candidate}`,
            'aria-keyshortcuts': shortcuts ? 'Tab' : undefined,
            onMouseDown: event => event.preventDefault(),
            onClick: accept,
          }, shortcuts && h('kbd', { 'aria-hidden': true }, 'Tab'), h('span', null, action)),
          h('button', { ref: dismissButton, type: 'button', className: 'dsh-next-message-accept dsh-next-message-dismiss',
            title: shortcuts ? dismissHint : t('dismissSuggestion'), 'aria-label': t('dismissSuggestion'),
            'aria-keyshortcuts': shortcuts ? 'Escape' : undefined,
            onMouseDown: event => event.preventDefault(), onClick: dismiss,
          }, h('span', { 'aria-hidden': true }, '×'))));
    }

    function DraftRewrite({ t, sessionId, input, inputActions }) {
      const [view, setView] = useState(null);
      const pending = useRef(null);
      const wand = useRef(null);
      const dialog = useRef(null);
      const dismissButton = useRef(null);
      const summary = useRef(null);
      const titleId = useId();
      const statusId = useId();
      const eligible = input.phase === 'plain' && input.queue.length === 0 && input.occurrences.length === 0
        && input.draft.length <= 2000 && !!input.draft.trim() && !/^\s*\//u.test(input.draft);
      const stale = view !== null && (!eligible || view.revision !== input.draftRev || view.original !== input.draft);

      function getEditor() {
        const editor = wand.current?.closest('[data-composer-card]')?.querySelector(editableSelector);
        return editor && !editor.querySelector('[data-composer-quote], [data-composer-command]') ? editor : null;
      }

      useLayoutEffect(() => () => pending.current?.abort(), []);
      useEffect(() => {
        if (stale) pending.current?.abort();
      }, [stale]);

      const open = view !== null;
      useLayoutEffect(() => {
        if (!open) return;
        const element = dialog.current;
        element.showModal();
        dismissButton.current?.focus();
        return () => { if (element.open) element.close(); };
      }, [open]);
      useLayoutEffect(() => {
        if (view?.phase === 'preview' && !stale && dialog.current?.ownerDocument.activeElement === dismissButton.current) {
          summary.current?.focus();
        }
      }, [view, stale]);

      function dismiss() {
        pending.current?.abort();
        pending.current = null;
        dialog.current?.close();
        setView(null);
      }

      async function start() {
        if (!eligible || pending.current || view || !getEditor()) return;
        if (inputActions.captureInsertion().draftRev !== input.draftRev) return;
        const job = new AbortController();
        pending.current = job;
        const captured = { original: input.draft, revision: input.draftRev };
        setView({ ...captured, phase: 'working' });
        let result = { ...captured, phase: 'error' };
        try {
          const params = new URLSearchParams({ session: sessionId });
          const response = await fetch(`api/local-composer-predictions/rewrite?${params}`, {
            method: 'POST', credentials: 'same-origin', signal: job.signal,
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: captured.original }),
          });
          if (response.status === 409) {
            const body = await response.json();
            result.phase = body?.reason === 'busy' ? 'busy' : 'unavailable';
          } else if (response.ok) {
            const body = await response.json();
            if (typeof body?.rewrite === 'string' && body.rewrite.trim() && body.rewrite.length <= 4000) {
              result = body.rewrite.trim() === captured.original.trim()
                ? { ...captured, phase: 'same' }
                : { ...captured, phase: 'preview', text: body.rewrite };
            }
          }
        } catch {
          // Keep the original draft on all transport and provider failures.
        } finally {
          if (pending.current === job) pending.current = null;
        }
        if (!job.signal.aborted) setView(result);
      }

      function replace() {
        if (view?.phase !== 'preview' || stale) return;
        const editor = getEditor();
        if (!editor || inputActions.captureInsertion().draftRev !== view.revision) {
          setView({ ...view, phase: 'stale' });
          return;
        }
        dialog.current?.close();
        editor.focus({ preventScroll: true });
        // With no chips, clipboard and detect offsets are identical. The editor checks the captured revision again.
        if (inputActions.insertText(view.text, { start: 0, end: view.original.length, draftRev: view.revision })) {
          setView(null);
        } else {
          dialog.current?.showModal();
          dismissButton.current?.focus();
          setView({ ...view, phase: 'stale' });
        }
      }

      const preview = view?.phase === 'preview' && !stale;
      const status = stale ? 'rewriteStale' : view && {
        working: 'rewriting', error: 'rewriteError', busy: 'rewriteBusy', unavailable: 'rewriteUnavailable',
        same: 'rewriteSame', stale: 'rewriteStale',
      }[view.phase];
      if (!eligible && !open) return null;
      return h(React.Fragment, null,
        eligible && h('button', {
          ref: wand, type: 'button', className: 'dsh-draft-rewrite-open', title: t('rewrite'),
          'aria-label': t('rewrite'), 'aria-haspopup': 'dialog', onClick: start,
        }, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M2.5 13.5l7-7 2 2-7 7-2-2Zm5-5 2 2M11.5 1v4m-2-2h4m.5 6v3m-1.5-1.5h3',
            stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
        open && h('dialog', {
          ref: dialog, className: 'dsh-draft-rewrite', role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId,
          'aria-describedby': status ? statusId : undefined,
          onCancel: event => { event.preventDefault(); dismiss(); },
        },
        h('h2', { id: titleId, ref: summary, tabIndex: -1 }, t('rewrite')),
        h('p', { id: statusId, role: 'status' }, status ? t(status) : t('rewriteReview')),
        preview && h('div', { className: 'dsh-draft-rewrite-versions' },
          h('section', null, h('h3', null, t('original')),
            h('div', { className: 'dsh-draft-rewrite-text', tabIndex: 0, role: 'region', 'aria-label': t('original') }, view.original)),
          h('section', null, h('h3', null, t('rewriteVariant')),
            h('div', { className: 'dsh-draft-rewrite-text', tabIndex: 0, role: 'region', 'aria-label': t('rewriteVariant') }, view.text))),
        h('div', { className: 'dsh-draft-rewrite-actions' },
          h('button', { ref: dismissButton, type: 'button', onClick: dismiss }, t('keepOriginal')),
          preview && h('button', { type: 'button', onClick: replace }, t('replaceDraft')))));
    }

    const GenerationButton = React.memo(function GenerationButton({ t, store, sessionId, revision }) {
      const state = usePrediction(store, sessionId);
      const button = useRef(null);
      const empty = revision !== null;
      const ready = state.phase === 'ready';
      const busy = state.phase === 'manual';
      const status = state.status ? t(state.status) : '';
      const detail = state.detail ? `${t(state.detail)} ${status}` : status;
      const label = t(busy ? 'generating' : ready && status ? 'retrySuggestion' : 'generate');

      function generate() {
        if (!empty || !ready) return;
        const editor = button.current?.closest(emptyCard)?.querySelector(editableSelector);
        if (!editor?.nextElementSibling?.matches(placeholderSelector)) return;
        if (editor.ownerDocument.activeElement !== editor) editor.focus({ preventScroll: true });
        store.retry(sessionId);
      }

      return h(React.Fragment, null,
        empty && (ready || busy) && h('button', {
          ref: button, type: 'button', className: 'dsh-next-message-generate', title: label,
          'aria-label': label, disabled: busy, 'aria-busy': busy || undefined,
          onMouseDown: event => event.preventDefault(), onClick: generate,
        }, busy
          ? h('span', { className: 'dsh-next-message-spinner', 'aria-hidden': true })
          : h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M8 1.75 9.6 6.4 14.25 8 9.6 9.6 8 14.25 6.4 9.6 1.75 8 6.4 6.4Z',
              stroke: 'currentColor', strokeWidth: 1.25, strokeLinejoin: 'round' }))),
        h('span', { className: 'dsh-next-message-status', role: 'status',
          title: empty && detail ? detail : undefined, 'data-visible': empty && detail ? '' : undefined },
          !empty ? '' : detail || (state.phase === 'manual' ? t('generating') : '')));
    });

    const idleSession = session => session.openState === 'open' && session.subagent === null
      && !session.removed && !session.running && session.pendingSubmissions.length === 0;
    const predictionSession = session => idleSession(session) && !session.blank;

    function useAvailable({ useAccess, useSessionStatus, sessionId }) {
      const allowed = useAccess('session/prompt') === true;
      const pending = useSessionStatus(snapshot => snapshot.get(sessionId)?.pendingInteraction !== undefined);
      return allowed && !pending;
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const preference = createAutoPreference();
        const store = createPredictionStore(preference);
        ctx.effect(() => preference.observe());
        ctx.effect(() => preference.subscribe(store.preferenceChanged));
        ctx.effect(() => ctx.locale.register(namespace, {
          en: { insert: 'Insert suggested message', action: 'Insert', generate: 'Suggest a next message',
            dismissHint: 'Dismiss suggestion (Esc)', dismissSuggestion: 'Dismiss suggestion', autoSuggestions: 'Automatic next-message suggestions',
            autoSuggestionsDetail: 'Suggest after the agent replies. When off, use the sparkle button for a suggestion; draft improvement still works. Saved in this browser or app.',
            autoSuggestionsSaveError: 'Could not save the preference. It has not changed.',
            generating: 'Generating suggestion…', noSuggestion: 'No suggestion this time', suggestionReady: 'Suggestion ready. Press Tab in the message box to insert.', suggestionReadyWithoutTab: 'Suggestion ready.',
            retrySuggestion: 'Retry suggestion', suggestionTimeout: 'The model did not respond in time.',
            suggestionRateLimited: 'The provider is limiting requests. Wait before retrying.',
            suggestionModelError: 'The model request failed.', suggestionInvalidResponse: 'The model returned an unusable suggestion.',
            suggestionConnectionError: 'Could not reach the suggestion service.', suggestionUnavailable: 'Suggestions are unavailable in this chat.',
            suggestionAttemptsExhausted: 'No more attempts for this reply.',
            rewrite: 'Improve draft', rewriting: 'Preparing a clearer version…', rewriteReview: 'Compare the versions before replacing your draft.',
            original: 'Original', rewriteVariant: 'Suggested version', keepOriginal: 'Keep original', replaceDraft: 'Replace draft',
            rewriteError: 'Could not prepare a version. Your draft is unchanged.', rewriteSame: 'No changes suggested.',
            rewriteBusy: 'A draft in this chat is already being improved. Try again when it finishes.',
            rewriteUnavailable: 'Improvement is unavailable. Check that a model is selected and the chat is idle.',
            rewriteStale: 'The draft changed. This version will not replace it.' },
          ru: { insert: 'Вставить подсказку', action: 'Вставить', generate: 'Предложить следующее сообщение',
            dismissHint: 'Скрыть подсказку (Esc)', dismissSuggestion: 'Скрыть подсказку', autoSuggestions: 'Автоподсказки следующего сообщения',
            autoSuggestionsDetail: 'Предлагать реплику после ответа агента. Если выключить, подсказку можно запросить звёздочкой; палочка для черновика останется. Сохраняется в этом браузере или приложении.',
            autoSuggestionsSaveError: 'Не удалось сохранить настройку. Она не изменилась.',
            generating: 'Генерирую подсказку…', noSuggestion: 'Не удалось подобрать подсказку', suggestionReady: 'Подсказка готова. Для вставки нажмите Tab в поле ввода.', suggestionReadyWithoutTab: 'Подсказка готова.',
            retrySuggestion: 'Повторить генерацию подсказки', suggestionTimeout: 'Модель не успела ответить.',
            suggestionRateLimited: 'Провайдер ограничил запросы. Подожди и повтори.',
            suggestionModelError: 'Запрос к модели завершился с ошибкой.', suggestionInvalidResponse: 'Модель вернула неподходящий ответ.',
            suggestionConnectionError: 'Не удалось связаться со службой подсказок.', suggestionUnavailable: 'Подсказки в этом чате недоступны.',
            suggestionAttemptsExhausted: 'Попытки для этого ответа закончились.',
            rewrite: 'Улучшить черновик', rewriting: 'Готовлю более ясный вариант…', rewriteReview: 'Сравните варианты, прежде чем заменять черновик.',
            original: 'Оригинал', rewriteVariant: 'Предложенный вариант', keepOriginal: 'Оставить оригинал', replaceDraft: 'Заменить черновик',
            rewriteError: 'Не удалось подготовить вариант. Черновик не изменился.', rewriteSame: 'Изменений не предложено.',
            rewriteBusy: 'В этом чате уже улучшается черновик. Повторите после завершения запроса.',
            rewriteUnavailable: 'Улучшение недоступно. Проверьте, что выбрана модель и чат не занят.',
            rewriteStale: 'Черновик изменился. Этот вариант не заменит его.' },
          zh: { insert: '插入建议消息', action: '插入', generate: '建议下一条消息',
            dismissHint: '按 Esc 隐藏建议', dismissSuggestion: '隐藏建议', autoSuggestions: '自动建议下一条消息',
            autoSuggestionsDetail: '在助手回复后提供建议。关闭后仍可点击星形按钮获取建议，草稿润色仍可使用。设置保存在当前浏览器或应用中。',
            autoSuggestionsSaveError: '无法保存设置，设置未更改。',
            generating: '正在生成建议…', noSuggestion: '本次没有可用建议', suggestionReady: '建议已就绪。在输入框中按 Tab 插入。', suggestionReadyWithoutTab: '建议已就绪。',
            retrySuggestion: '重试生成建议', suggestionTimeout: '模型响应超时。',
            suggestionRateLimited: '模型提供方限制了请求，请稍后重试。',
            suggestionModelError: '模型请求失败。', suggestionInvalidResponse: '模型返回的建议无法使用。',
            suggestionConnectionError: '无法连接到建议服务。', suggestionUnavailable: '此对话暂不支持建议。',
            suggestionAttemptsExhausted: '这条回复的尝试次数已用完。',
            rewrite: '润色草稿', rewriting: '正在准备更清晰的版本…', rewriteReview: '替换草稿前，请先比较两个版本。',
            original: '原文', rewriteVariant: '建议版本', keepOriginal: '保留原文', replaceDraft: '替换草稿',
            rewriteError: '无法生成建议版本，草稿未更改。', rewriteSame: '没有建议的改动。',
            rewriteBusy: '此对话已有草稿正在润色，请等待完成后重试。',
            rewriteUnavailable: '暂时无法润色。请确认已选择模型且对话处于空闲状态。',
            rewriteStale: '草稿已更改，此版本不会替换它。' },
        }));
        function PredictionSeat(props) {
          const { useInput, sessionId, inputActions, t } = props;
          const available = useAvailable(props);
          const canPredict = props.useSession(predictionSession);
          const revision = useInput(predictionRevision);
          if (!available || !canPredict || revision === undefined || !inputActions) return null;
          return h(Prediction, { ctx, t, store, sessionId, revision, inputActions, key: sessionId });
        }

        function ToolbarSeat(props) {
          const { useInput, sessionId, inputActions, t } = props;
          const available = useAvailable(props);
          const idle = props.useSession(idleSession);
          const blank = props.useSession(session => session.blank);
          const input = useInput(snapshot => snapshot);
          if (!available || !idle || !input || !inputActions) return null;
          const revision = predictionRevision(input);
          return h(React.Fragment, null,
            h('style', null, toolbarStyles),
            h(DraftRewrite, { t, sessionId, input, inputActions, key: `draft:${sessionId}` }),
            !blank && revision !== undefined && h(GenerationButton, { t, store, sessionId, revision, key: `suggestion:${sessionId}` }));
        }
        ctx.slots.inject(overlaySlot, () => ctx.slots.register({ name: overlaySlot, id: namespace, order: 30, locale: namespace }, PredictionSeat));
        ctx.slots.inject(toolbarSlot, () => ctx.slots.register({ name: toolbarSlot, id: namespace, locale: namespace }, ToolbarSeat));
        ctx.slots.inject(settingsSlot, () => ctx.slots.register({ name: settingsSlot, id: namespace, order: 21, locale: namespace },
          ({ t }) => h(AutoSuggestionSetting, { t, preference })));
      },
    };
  },
});
