"use strict";
(() => {
  // src/portalAgent.ts
  var SENSITIVE_RE = /ssn|social.?security|alien|a-?number|a\s*#|a#|uscis|account|routing|\bcard\b|passport|i-?94\s*number|receipt.?number|bank|password|security.?question|signature|certif|attest|under penalty/i;
  var FINAL_SUBMIT_RE = /\b(submit|file|finish|complete|confirm|sign|certify|agree|pay|place order|send application)\b/i;
  var NEXT_RE = /\b(next|continue|save (and|&) continue|proceed|go on|forward|start)\b/i;
  var refCounter = 0;
  function ensureRef(el) {
    let ref = el.getAttribute("data-wf-ref");
    if (!ref) {
      ref = `wf-${++refCounter}`;
      el.setAttribute("data-wf-ref", ref);
    }
    return ref;
  }
  function byRef(ref) {
    return document.querySelector(`[data-wf-ref="${CSS.escape(ref)}"]`);
  }
  function isVisible(el) {
    if (el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function textOf(el) {
    return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  function labelFor(el) {
    const id = el.getAttribute("id");
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) return textOf(lab);
    }
    const wrap = el.closest("label");
    if (wrap) return textOf(wrap);
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map((i) => textOf(document.getElementById(i))).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const ph = el.getAttribute("placeholder");
    if (ph) return ph.trim();
    return el.getAttribute("name") ?? "";
  }
  function snapshot() {
    const fields = [];
    const controls = Array.from(
      document.querySelectorAll("input, select, textarea")
    );
    for (const el of controls) {
      const tag = el.tagName.toLowerCase();
      const inputType = el.type?.toLowerCase() || tag;
      if (inputType === "hidden") continue;
      if (!isVisible(el)) continue;
      const type = tag === "select" ? "select" : tag === "textarea" ? "textarea" : inputType;
      let options;
      if (tag === "select") {
        options = Array.from(el.options).map((o) => o.text.trim()).filter(Boolean).slice(0, 40);
      }
      let value;
      if (inputType === "checkbox" || inputType === "radio") {
        value = el.checked ? "checked" : "";
      } else {
        value = el.value || void 0;
      }
      fields.push({
        ref: ensureRef(el),
        label: labelFor(el).slice(0, 200),
        type,
        name: el.getAttribute("name") || void 0,
        placeholder: el.getAttribute("placeholder") || void 0,
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true" || void 0,
        value,
        options
      });
      if (fields.length >= 80) break;
    }
    const buttons = [];
    const btnEls = Array.from(
      document.querySelectorAll("button, input[type=submit], input[type=button], a[href]")
    );
    for (const el of btnEls) {
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      let text = textOf(el) || el.value || el.getAttribute("aria-label") || "";
      text = text.slice(0, 80);
      if (!text) continue;
      const kind = tag === "a" ? "link" : el.type === "submit" || FINAL_SUBMIT_RE.test(text) || NEXT_RE.test(text) ? "submit" : "button";
      if (tag === "a" && !NEXT_RE.test(text) && !FINAL_SUBMIT_RE.test(text) && buttons.length > 12) continue;
      buttons.push({ ref: ensureRef(el), text, kind });
      if (buttons.length >= 24) break;
    }
    const ariaEls = Array.from(
      document.querySelectorAll('[role="button"], [role="radio"], [role="checkbox"], [role="option"], [role="switch"]')
    );
    for (const el of ariaEls) {
      if (buttons.length >= 40) break;
      if (!isVisible(el)) continue;
      if (el.closest("button, a")) continue;
      if (el.hasAttribute("data-wf-ref") && buttons.some((b) => b.ref === el.getAttribute("data-wf-ref"))) continue;
      let text = textOf(el) || el.getAttribute("aria-label") || "";
      const checked = el.getAttribute("aria-checked");
      if (checked != null) text = `${text} (${checked === "true" ? "selected" : "not selected"})`;
      text = text.trim().slice(0, 80);
      if (!text) continue;
      buttons.push({ ref: ensureRef(el), text, kind: "button" });
    }
    const errors = [];
    const errEls = Array.from(
      document.querySelectorAll('[role="alert"], [aria-invalid="true"], .error, .invalid-feedback, .field-error, .usa-error-message')
    );
    for (const el of errEls) {
      const t = textOf(el);
      if (t && t.length < 240 && !errors.includes(t)) errors.push(t);
      if (errors.length >= 20) break;
    }
    const headings = Array.from(document.querySelectorAll("h1, h2, legend")).map((h) => textOf(h)).filter(Boolean).slice(0, 12);
    const bodyText = (document.body.innerText || "").slice(0, 4e3);
    const stepMatch = bodyText.match(/step\s+\d+\s+of\s+\d+/i) || bodyText.match(/page\s+\d+\s+of\s+\d+/i);
    return {
      url: location.href,
      title: document.title,
      headings,
      fields,
      buttons,
      errors,
      step: stepMatch ? stepMatch[0] : void 0
    };
  }
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function flash(el, color) {
    const prev = el.style.outline;
    el.style.outline = `3px solid ${color}`;
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = prev;
    }, 2200);
  }
  function execute(actions) {
    showBanner();
    const results = [];
    for (const a of actions) {
      const el = byRef(a.ref);
      if (!el) {
        results.push({ ref: a.ref, ok: false, note: "not found" });
        continue;
      }
      const labelHay = `${labelFor(el)} ${el.getAttribute("name") ?? ""}`;
      try {
        if (a.action === "fill" || a.action === "select") {
          if (SENSITIVE_RE.test(labelHay)) {
            results.push({ ref: a.ref, ok: false, note: "sensitive \u2014 skipped" });
            continue;
          }
          const itype = el.type?.toLowerCase?.() || "";
          if (itype === "radio" || itype === "checkbox") {
            const input = el;
            if (!input.checked) el.click();
            else if (itype === "radio") el.click();
            flash(input, "#2563eb");
            results.push({ ref: a.ref, ok: true });
            continue;
          }
          if (el.tagName.toLowerCase() === "select") {
            const sel = el;
            const want = a.value.trim().toLowerCase();
            const opt = Array.from(sel.options).find(
              (o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want
            );
            if (opt) {
              setNativeValue(sel, opt.value);
              flash(sel, "#2563eb");
              results.push({ ref: a.ref, ok: true });
            } else results.push({ ref: a.ref, ok: false, note: "no matching option" });
          } else {
            const input = el;
            if (input.value) {
              results.push({ ref: a.ref, ok: false, note: "already has a value" });
              continue;
            }
            setNativeValue(input, a.value);
            flash(input, "#2563eb");
            results.push({ ref: a.ref, ok: true });
          }
        } else if (a.action === "check") {
          if (SENSITIVE_RE.test(labelHay)) {
            results.push({ ref: a.ref, ok: false, note: "sensitive \u2014 skipped" });
            continue;
          }
          const input = el;
          const want = a.value !== false;
          const isToggle = input.type === "radio" || input.type === "checkbox";
          if (isToggle) {
            if (input.checked !== want) el.click();
            else if (input.type === "radio") el.click();
          } else {
            el.click();
          }
          flash(input, "#2563eb");
          results.push({ ref: a.ref, ok: true });
        } else if (a.action === "click") {
          const text = textOf(el) || el.value || "";
          if (FINAL_SUBMIT_RE.test(text) && !NEXT_RE.test(text)) {
            results.push({ ref: a.ref, ok: false, note: "final submit \u2014 refused" });
            continue;
          }
          el.click();
          results.push({ ref: a.ref, ok: true });
        }
      } catch (e) {
        results.push({ ref: a.ref, ok: false, note: String(e).slice(0, 80) });
      }
    }
    return results;
  }
  function showBanner() {
    if (document.getElementById("wf-agent-banner")) return;
    const host = document.createElement("div");
    host.id = "wf-agent-banner";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
    <style>
      :host { position: fixed; top: 14px; right: 14px; z-index: 2147483647; }
      .b { display:flex; gap:10px; align-items:flex-start; max-width: 300px; background:#fff; border:2px solid #2563eb; border-radius:12px; padding:12px 14px; box-shadow:0 10px 30px rgba(0,0,0,.16); font:13px/1.4 system-ui,sans-serif; color:#1a1a1a; }
      .t { font-weight:700; color:#1a3a5c; margin-bottom:3px; }
      .x { margin-left:auto; cursor:pointer; border:none; background:none; font-size:16px; color:#9ca3af; }
    </style>
    <div class="b">
      <div>
        <div class="t">Wayfinder is helping you</div>
        <div>It fills what it can and asks you about anything sensitive. Always review before you submit.</div>
      </div>
      <button class="x" id="wfx" aria-label="Hide">\xD7</button>
    </div>`;
    root.getElementById("wfx")?.addEventListener("click", () => host.remove());
    document.documentElement.appendChild(host);
  }
  function highlight(ref) {
    const el = byRef(ref);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      flash(el, "#d97706");
      el.focus?.();
    }
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg?.type === "wf-snapshot") {
        sendResponse({ ok: true, snapshot: snapshot() });
        return;
      }
      if (msg?.type === "wf-execute") {
        sendResponse({ ok: true, results: execute(msg.actions || []) });
        return;
      }
      if (msg?.type === "wf-highlight") {
        highlight(msg.ref);
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "wf-banner") {
        showBanner();
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "wf-ping") {
        sendResponse({ ok: true });
        return;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e).slice(0, 120) });
    }
  });
})();
