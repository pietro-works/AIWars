/* AI Wars Bridge — chatbot-page content script.
   Receives one game job, pastes it into the chatbot composer, submits, then
   watches the page for the tagged reply block and writes it to
   chrome.storage.local for bridge.js to pick up.

   Injection, submit loop, and DOM-watch mechanics are ported from WireFlow's
   autopilot handoff (production-tested selector sets per chatbot). No
   attachments here — text in, text out.

   Reply protocol: the game's prompt instructs the model to wrap its JSON
   between the exact lines `AIWARS_RESULT <requestId>` and `AIWARS_END`.
   Extraction requires a balanced, parseable {...} between the tags, which
   the instruction text itself never contains — so echoes of the instruction
   can't false-positive. */

'use strict';

(function () {
  /* selector sets + per-bot behavior, aligned with WireFlow's production-tested
     wf-autopilot-handoff CHATBOT_CONFIG (the reference for what actually works) */
  const CONFIG = {
    'claude.ai': {
      inputSelectors: [
        '[data-testid="chat-input"]',
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"]'
      ],
      submitSelectors: ['button[data-testid="send-button"]', 'button[aria-label="Send message"]', 'button[aria-label*="Send" i]', 'button[type="submit"]'],
      globalSubmitSelectors: ['button[data-testid="send-button"]', 'button[aria-label="Send message"]', 'button[aria-label*="Send" i]'],
      settleMs: 1200
    },
    'chatgpt.com': {
      inputSelectors: [
        '#prompt-textarea',
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"]'
      ],
      submitSelectors: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label*="Send prompt" i]'],
      globalSubmitSelectors: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label*="Send prompt" i]'],
      settleMs: 1200
    },
    'gemini.google.com': {
      inputSelectors: [
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"][aria-label*="Gemini" i]',
        'div[contenteditable="true"]'
      ],
      submitSelectors: [
        'gem-icon-button.send-button button',
        '.send-button-container button',
        'button[aria-label="Enviar mensagem"]',
        'button[aria-label*="Wyślij" i]',
        'button[aria-label*="Send" i]'
      ],
      globalSubmitSelectors: ['gem-icon-button.send-button button', '.send-button-container button', 'button[aria-label*="Wyślij" i]', 'button[aria-label*="Send" i]'],
      /* Quill silently drops synthetic paste events — write textContent directly */
      textInjection: 'textContent',
      settleMs: 1800
    }
  };

  function currentBotCfg() {
    const host = location.hostname.replace(/^www\./, '');
    for (const key of Object.keys(CONFIG)) if (host.endsWith(key)) return CONFIG[key];
    return null;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function isUsable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    /* visibility matters: a cloaked contenteditable has a nonzero rect and
       would swallow the injection while the real composer stays empty */
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }
  function findFirst(selectors) {
    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) if (isUsable(el)) return el;
      } catch (e) { /* unsupported selector */ }
    }
    return null;
  }
  async function waitFor(selectors, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = findFirst(selectors);
      if (el) return el;
      await sleep(400);
    }
    return null;
  }

  /* ---- prompt injection (WireFlow mechanics) ---- */
  function injectIntoTextarea(el, text) {
    el.focus();
    const setter =
      (Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value') || {}).set ||
      (Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') || {}).set;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  function injectIntoContentEditable(el, text) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
      return;
    } catch (e) { /* fall back */ }
    if (!document.execCommand('insertText', false, text)) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    }
  }
  /* Quill-style editors (Gemini) ignore synthetic paste: clear the selection,
     write textContent, and announce it with an insertText InputEvent (WireFlow's
     injectIntoTextContentEditor) */
  function injectIntoTextContentEditor(el, text) {
    el.focus();
    try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch (e) { /* non-fatal */ }
    try {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false, null);
      selection.removeAllRanges();
    } catch (e) { /* non-fatal */ }
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  function injectPrompt(input, text, cfg) {
    if (cfg && cfg.textInjection === 'textContent') return injectIntoTextContentEditor(input, text);
    if (input.isContentEditable) injectIntoContentEditable(input, text);
    else injectIntoTextarea(input, text);
  }
  /* escalation injector for the retry path (WireFlow forceInjectPrompt):
     synthetic paste can be silently ignored — write the DOM directly */
  function forceInjectPrompt(input, text) {
    if ('value' in input && !input.isContentEditable) injectIntoTextarea(input, text);
    else injectIntoTextContentEditor(input, text);
  }
  function inputText(input) {
    if ('value' in input && input.value) return input.value;
    return input.textContent || input.innerText || '';
  }
  function promptPresent(input, marker) {
    return inputText(input).indexOf(marker) !== -1;
  }

  /* ---- submit (button-click loop, WireFlow style — NEVER a synthetic Enter:
     ProseMirror/Quill treat that as "insert newline", which on Claude typed
     blank lines into the composer instead of sending) ---- */
  function generationStarted(debug) {
    /* existence is NOT proof: Gemini keeps stop-labeled buttons parked in the
       DOM while idle (hidden/disabled send-stop swap), which made a bare
       querySelector spin the pre-inject wait forever. Only a VISIBLE, ENABLED
       stop button means a generation is actually running. */
    const els = document.querySelectorAll(
      'button[data-testid="stop-button"],button[aria-label*="Stop" i],button[aria-label*="Parar" i],button[aria-label*="Interromper" i],button[aria-label*="Zatrzymaj" i]'
    );
    let parked = 0;
    for (const el of els) {
      if (!isClickable(el)) { parked++; continue; }
      if (debug) {
        const path = [];
        let n = el;
        for (let i = 0; i < 6 && n; i++) {
          path.push((n.tagName || '?').toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').slice(0, 2).join('.') : ''));
          n = n.parentElement;
        }
        console.log('[aiwars-debug] generationStarted() matched VISIBLE -- aria-label:', JSON.stringify(el.getAttribute('aria-label')), 'data-testid:', el.getAttribute('data-testid'), 'ancestor path (self->up):', path.join(' < '));
      }
      return true;
    }
    if (debug && parked) console.log('[aiwars-debug] generationStarted(): ' + parked + ' stop-labeled button(s) in DOM but none visible/enabled -- treating as idle');
    return false;
  }
  function isClickable(btn) {
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
    const r = btn.getBoundingClientRect();
    const s = getComputedStyle(btn);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }
  /* composer-scoped candidates first, then global — a page can render several
     matching buttons (edit bubbles, history) and only the composer's counts */
  function composerScope(cfg, input) {
    const el = input || findFirst(cfg.inputSelectors);
    if (!el) return document.body;
    return el.closest('form')
        || el.closest('.xap-uploader-dropzone')      /* Gemini: tight composer wrapper */
        || el.closest('chat-window')
        || el.closest('chat-window-input')
        || el.closest('.text-input-field')
        || el.closest('[class*="composer" i]')
        || el.closest('[data-testid*="composer" i]')
        || (el.parentElement && el.parentElement.parentElement)
        || document.body;
  }
  function candidatesIn(root, selectors) {
    const out = [];
    for (const sel of selectors || []) {
      try {
        if (root.matches && root.matches(sel)) out.push(root);
        out.push.apply(out, root.querySelectorAll(sel));
      } catch (e) { /* skip invalid selectors */ }
    }
    return Array.from(new Set(out));
  }
  function findSubmit(cfg, input) {
    const scoped = candidatesIn(composerScope(cfg, input), cfg.submitSelectors);
    const global = candidatesIn(document, cfg.globalSubmitSelectors || cfg.submitSelectors);
    return scoped.concat(global).find(isClickable) || null;
  }
  /* `wasGenerating` guards against conflating a PREVIOUS reply still
     streaming with "our send was accepted": a stop-button that predates our
     click is not proof of submission (send is disabled during streaming) */
  function composerCleared(input, marker, wasGenerating) {
    if (!input || !document.contains(input)) return true;    /* navigated to thread */
    if (!wasGenerating && generationStarted()) return true;  /* OUR generation began */
    return !promptPresent(input, marker);                    /* box emptied */
  }
  async function submitPrompt(input, cfg, marker) {
    await sleep(350);
    const wasGenerating = generationStarted();
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (composerCleared(input, marker, wasGenerating && generationStarted())) return true;
      const btn = findSubmit(cfg, input);
      if (btn) btn.click();
      /* no button ready -> just wait for the UI to enable Send (upload settle,
         input registration). Synthetic Enter is banned: editors newline on it. */
      await sleep(500);
      if (composerCleared(input, marker, wasGenerating && generationStarted())) return true;
      await sleep(500);
    }
    throw new Error('composer never cleared — send not accepted (no clickable Send button)');
  }

  /* ---- reply extraction ---- */
  function escapeRegex(v) { return String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function firstJsonObject(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    const cand = text.slice(start, end + 1);
    try { JSON.parse(cand); return cand; } catch (e) { /* try tighter scan */ }
    /* balanced-brace scan from first '{' (strings ignored — good enough here) */
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          const c2 = text.slice(start, i + 1);
          try { JSON.parse(c2); return c2; } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  /* a JSON candidate that is actually an echo of OUR request (chatty models,
     Gemini especially, restate the task with the payload inline) */
  function looksLikeRequestEcho(json) {
    try {
      const o = JSON.parse(json);
      return !!(o && (o.your_units || o.visible_enemy_units || o.you_are || o.request === 'stance'));
    } catch (e) { return true; }
  }

  function extractReply(requestId) {
    const texts = [];
    for (const sel of ['[data-message-author-role="assistant"]', 'article', 'main']) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const t = el.innerText || '';
          if (t) texts.push(t);
        });
      } catch (e) { /* ignore */ }
    }
    texts.push(document.body ? document.body.innerText || '' : '');
    /* line-anchored tags: the real block has each tag on its own line per the
       protocol; inline prose mentions ("I will reply with AIWARS_RESULT x...")
       don't match. Prefer the LAST candidate — the real block ends the reply,
       echoes precede it. */
    // PACS0012 — these regexes must byte-match the reply markers webtab-client.js tells the model to emit — AGENTS.md
    const marker = new RegExp('(?:^|\\n)\\s*AIWARS_RESULT\\s+' + escapeRegex(requestId) + '\\s*(?:\\n|$)', 'g');
    let best = null;
    for (const text of [...new Set(texts)]) {
      let m;
      while ((m = marker.exec(text))) {
        const after = text.slice(m.index + m[0].length);
        const endIdx = after.search(/(?:^|\n)\s*AIWARS_END\b/);
        if (endIdx === -1) continue;
        const block = after.slice(0, endIdx);
        const json = firstJsonObject(block);
        if (json && !looksLikeRequestEcho(json)) best = json;
      }
    }
    return best;
  }

  function publishResult(requestId, payload) {
    const key = 'aiwars_result_' + requestId;
    /* ts lets the background worker sweep results nobody consumed — the
       setTimeout below dies with this tab, so it can't be the only cleanup */
    chrome.storage.local.set({ [key]: Object.assign({ ts: Date.now() }, payload) });
    setTimeout(() => chrome.storage.local.remove(key), 10 * 60 * 1000);
  }

  function watchForReply(requestId, timeoutMs) {
    const started = Date.now();
    let done = false;
    let observer = null;
    let timer = null;
    let scheduled = null;
    const finish = payload => {
      if (done) return;
      done = true;
      if (observer) observer.disconnect();
      if (timer) clearInterval(timer);
      if (scheduled) clearTimeout(scheduled);
      publishResult(requestId, payload);
    };
    const scan = () => {
      if (done) return;
      if (Date.now() - started > timeoutMs) { finish({ ok: false, error: 'timed out waiting for chatbot reply' }); return; }
      /* gate BEFORE extractReply: innerText forces layout on the whole thread,
         and results are rejected during streaming anyway. The stop-button's
         removal is itself a mutation, so the terminal state still triggers. */
      if (generationStarted()) return;
      const json = extractReply(requestId);
      if (json) finish({ ok: true, raw: json });
    };
    /* debounced: token-streaming fires many mutation batches per second */
    observer = new MutationObserver(() => {
      if (scheduled || done) return;
      scheduled = setTimeout(() => { scheduled = null; scan(); }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    timer = setInterval(scan, 1500);   /* fallback while tab is backgrounded */
  }

  /* ---- job intake ---- */
  let busy = false;

  /* survives SPA navigation within the tab; a re-delivered job (background
     retry after a closed ack port / full navigation) must not paste twice */
  function alreadySubmitted(requestId) {
    try { return sessionStorage.getItem('aiwars_submitted_' + requestId) === '1'; } catch (e) { return false; }
  }
  function markSubmitted(requestId) {
    try { sessionStorage.setItem('aiwars_submitted_' + requestId, '1'); } catch (e) { /* ignore */ }
  }

  function watchWindowMs(job) {
    /* absolute deadline shared with the game page: always publish (result or
       timeout) BEFORE the page-side backstop gives up, so the pending entry
       in bridge.js is always consumed while this tab lives */
    if (job.deadlineTs) return Math.max(5000, job.deadlineTs - Date.now());
    return job.timeoutMs || 240000;
  }

  async function executeJob(job) {
    console.log('[aiwars-debug] executeJob start, requestId=', job.requestId, 'host=', location.hostname);
    const cfg = currentBotCfg();
    console.log('[aiwars-debug] cfg matched:', cfg ? Object.keys(cfg) : null);
    if (!cfg) throw new Error('chatbot not recognized: ' + location.hostname);

    if (alreadySubmitted(job.requestId)) {   /* re-delivery: just keep watching */
      console.log('[aiwars-debug] alreadySubmitted=true, skipping straight to watchForReply');
      watchForReply(job.requestId, watchWindowMs(job));
      return;
    }

    await sleep(cfg.settleMs || 800);   /* let the SPA finish wiring the composer */
    const input = await waitFor(cfg.inputSelectors, 15000);
    console.log('[aiwars-debug] composer found:', !!input, input ? { tag: input.tagName, cls: input.className, isCE: input.isContentEditable } : null);
    if (!input) throw new Error('chat composer not found — are you logged in?');

    /* don't inject while a previous reply is still streaming: send is disabled
       and a pre-existing stop button would fake the submitted signal */
    console.log('[aiwars-debug] checking generationStarted() before waiting...');
    const genDeadline = Date.now() + 90000;
    let ticks = 0;
    while (generationStarted(ticks === 0) && Date.now() < genDeadline) {
      if (ticks % 4 === 0) console.log('[aiwars-debug] still waiting on generationStarted(), elapsed ms=', 90000 - (genDeadline - Date.now()));
      ticks++;
      await sleep(500);
    }
    if (generationStarted(true)) {
      console.log('[aiwars-debug] gave up: generationStarted() still true after 90s wait');
      throw new Error('previous generation still running');
    }
    console.log('[aiwars-debug] generationStarted() clear, proceeding to inject');

    /* first job in this tab carries the rules; later jobs ride the thread */
    const text = window.__aiwarsPrimed ? job.body : (job.rules + '\n\n' + job.body);
    console.log('[aiwars-debug] primed=', !!window.__aiwarsPrimed, 'text length=', text.length, 'requestId present in outgoing text?', text.indexOf(job.requestId) !== -1);

    injectPrompt(input, text, cfg);
    await sleep(200);
    let present = promptPresent(input, job.requestId);
    console.log('[aiwars-debug] after injectPrompt: promptPresent=', present, 'inputText length=', inputText(input).length, 'inputText snippet=', JSON.stringify(inputText(input).slice(0, 120)));
    if (!present) {
      /* escalate, don't repeat: a silently-dropped synthetic paste drops the
         same way twice — the textContent injector is the recovery path
         (WireFlow's forceInjectPrompt) */
      console.log('[aiwars-debug] escalating to forceInjectPrompt');
      forceInjectPrompt(input, text);
      await sleep(200);
      present = promptPresent(input, job.requestId);
      console.log('[aiwars-debug] after forceInjectPrompt: promptPresent=', present, 'inputText length=', inputText(input).length, 'inputText snippet=', JSON.stringify(inputText(input).slice(0, 120)));
    }
    if (!present) {
      console.log('[aiwars-debug] FINAL FAIL — full inputText:', JSON.stringify(inputText(input)));
      throw new Error('prompt injection failed');
    }

    /* mark BEFORE submit: if the tab navigates mid-submit-loop after the click
       was accepted, a redelivered job must not paste again — worst case the
       alreadySubmitted branch just re-arms the watcher */
    markSubmitted(job.requestId);
    await submitPrompt(input, cfg, job.requestId);
    window.__aiwarsPrimed = true;
    watchForReply(job.requestId, watchWindowMs(job));
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.action !== 'aiwars.paste') return false;
    /* retryable: background may re-deliver while we're mid-turn */
    if (busy) { sendResponse({ ok: false, retryable: true, error: 'tab busy with previous turn' }); return false; }
    busy = true;
    /* ack SYNCHRONOUSLY and run the job detached: executeJob can legitimately
       take minutes (settle + previous-generation wait + submit loop), far past
       MV3's worker idle-kill — a held sendResponse channel would die with the
       worker and the background would misread the turn as undelivered.
       Failures travel via publishResult (chrome.storage), same as results. */
    sendResponse({ ok: true, accepted: true });
    executeJob(msg.job)
      .then(() => { busy = false; })
      .catch(err => {
        busy = false;
        publishResult(msg.job.requestId, { ok: false, error: err.message || String(err) });
      });
    return false;
  });
})();