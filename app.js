(() => {
  "use strict";
  const cfg = window.MONEY_DESK_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, {
    auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const FIELDS = {
    Accounts: [
      ["Account", "text", true], ["Institution", "text"], ["Type", "text"], ["Owner", "text"],
      ["Current Amount", "amount"], ["Last Updated", "date"], ["Source", "text"],
    ],
    Transactions: [
      ["Date", "date", true], ["Account", "account", true], ["Kind", "kind", true], ["Amount", "amount", true],
      ["Category", "text"], ["Source", "text"], ["Status", "status"], ["Txn ID", "text"], ["Note", "text-wide"],
    ],
  };
  let data = null; // held in memory only, never stored
  let enrollFactorId = null, verifyFactorId = null;

  // ---------- screens ----------
  function show(id) {
    for (const s of ["screenLogin", "screenEnroll", "screenVerify", "screenApp"]) $(s).classList.toggle("hidden", s !== id);
    const inApp = id === "screenApp";
    $("refreshBtn").classList.toggle("hidden", !inApp);
    $("signOutBtn").classList.toggle("hidden", id === "screenLogin");
  }
  function msg(id, text, ok = false) { const m = $(id); m.textContent = text || ""; m.classList.toggle("ok", ok); }
  function busy(on) { $("loading").classList.toggle("hidden", !on); }

  async function route() {
    const { data: s } = await sb.auth.getSession();
    if (!s.session) { data = null; show("screenLogin"); return; }
    const { data: aal, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) { show("screenLogin"); return; }
    if (aal.currentLevel === "aal2") { show("screenApp"); return loadAll(); }
    const { data: f } = await sb.auth.mfa.listFactors();
    const verified = (f?.totp || []).filter((x) => x.status === "verified");
    if (verified.length) { verifyFactorId = verified[0].id; show("screenVerify"); $("verifyCode").focus(); return; }
    return startEnroll(f);
  }

  async function startEnroll(f) {
    for (const x of (f?.all || [])) if (x.status !== "verified") await sb.auth.mfa.unenroll({ factorId: x.id });
    const { data: e, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Money Desk " + new Date().toISOString().slice(0, 10), issuer: "Money Desk" });
    if (error) { show("screenLogin"); msg("loginMsg", "Could not start 2FA setup. Try again."); return; }
    enrollFactorId = e.id;
    $("enrollQr").src = e.totp.qr_code;
    $("enrollSecret").textContent = e.totp.secret;
    show("screenEnroll"); $("enrollCode").focus();
  }

  async function verifyCode(factorId, code, msgId) {
    // Retry once: challenge and verify must come from the same network address.
    for (let i = 0; i < 2; i++) {
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code });
      if (!error) return true;
      if (!/ip/i.test(error.code || error.message || "")) { msg(msgId, "That code didn't work. Check the time on your phone and try the newest code."); return false; }
    }
    msg(msgId, "Your network changed during sign in. Try again."); return false;
  }

  // ---------- auth forms ----------
  $("loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); msg("loginMsg", "");
    const btn = ev.submitter; if (btn) btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $("loginEmail").value.trim(), password: $("loginPassword").value });
    if (btn) btn.disabled = false;
    $("loginPassword").value = "";
    if (error) { msg("loginMsg", "Email or password is wrong."); return; }
    route();
  });
  $("enrollForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); msg("enrollMsg", "");
    if (await verifyCode(enrollFactorId, $("enrollCode").value.trim(), "enrollMsg")) { $("enrollSecret").textContent = ""; $("enrollQr").removeAttribute("src"); route(); }
    $("enrollCode").value = "";
  });
  $("verifyForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); msg("verifyMsg", "");
    if (await verifyCode(verifyFactorId, $("verifyCode").value.trim(), "verifyMsg")) route();
    $("verifyCode").value = "";
  });
  async function signOut() { data = null; clearViews(); await sb.auth.signOut(); show("screenLogin"); }
  $("signOutBtn").addEventListener("click", signOut);
  $("refreshBtn").addEventListener("click", () => loadAll());

  // Idle sign out.
  let idleTimer;
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (data) signOut(); }, cfg.idleMinutes * 60000); };
  ["click", "keydown", "touchstart", "visibilitychange"].forEach((e) => document.addEventListener(e, resetIdle, { passive: true }));
  resetIdle();

  // ---------- API ----------
  async function api(body) {
    const { data: s } = await sb.auth.getSession();
    if (!s.session) throw Object.assign(new Error("Signed out"), { code: "signed_out" });
    const res = await fetch(cfg.functionUrl, {
      method: "POST", cache: "no-store", credentials: "omit",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.session.access_token, apikey: cfg.publishableKey },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(j.message || "Request failed"), { code: j.error, status: res.status });
    return j;
  }

  async function loadAll() {
    msg("appMsg", ""); busy(true);
    try {
      data = await api({ action: "bootstrap" });
      renderAll();
    } catch (e) {
      if (e.status === 401 || e.code === "signed_out") return signOut();
      if (e.code === "mfa_required") return route();
      msg("appMsg", e.code === "sheet_not_connected" ? "Signed in. The ledger sheet is not connected yet." : e.message);
    } finally { busy(false); }
  }

  // ---------- helpers ----------
  const num = (s) => { if (s == null) return NaN; let t = String(s).replace(/[$,\s]/g, ""); if (/^\(.*\)$/.test(t)) t = "-" + t.slice(1, -1); return t === "" ? NaN : Number(t); };
  const isNumeric = (s) => !isNaN(num(s));
  const isoDate = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || "").trim()); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : String(s || "").trim().slice(0, 10); };
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  function fillSelect(sel, values, allLabel) {
    const keep = sel.value; sel.replaceChildren(el("option", null, allLabel)); sel.firstChild.value = "";
    for (const v of values) { const o = el("option", null, v); o.value = v; sel.appendChild(o); }
    if (values.includes(keep)) sel.value = keep;
  }
  function clearViews() { for (const id of ["dashboard", "accList", "txnList"]) $(id).replaceChildren(); $("txnCount").textContent = ""; }

  // ---------- render ----------
  function renderAll() { renderDashboard(); renderAccounts(); renderTransactions(); }

  function renderDashboard() {
    const root = $("dashboard"); root.replaceChildren();
    const grid = data.dashboard || [];
    let section = null, first = true;
    const newSection = (title) => { section = el("div", "dash-section"); if (title) section.appendChild(el("h3", null, title)); root.appendChild(section); return section; };
    let i = 0;
    while (i < grid.length) {
      const row = grid[i].map((c) => String(c).trim());
      const filled = row.filter((c) => c !== "");
      if (!filled.length) { section = null; i++; continue; }
      if (filled.length === 1 && !isNumeric(filled[0])) { newSection(filled[0]); i++; continue; }
      if (!section) newSection(null);
      if (row.length <= 2 || filled.length <= 2) {
        let metrics = section.querySelector(".metrics:last-child");
        if (!metrics) { metrics = el("div", "metrics"); section.appendChild(metrics); }
        const m = el("div", "metric" + (first ? " hero" : "")); first = false;
        m.append(el("div", "l", row[0] || ""), el("div", "v", filled[filled.length - 1]));
        metrics.appendChild(m); i++; continue;
      }
      // Table block: consecutive rows with 3+ cells.
      const wrap = el("div", "scroll"), table = el("table", "grid");
      let header = row.slice(1).every((c) => c === "" || !isNumeric(c));
      while (i < grid.length) {
        const r = grid[i].map((c) => String(c).trim());
        if (r.filter((c) => c !== "").length < 2) break;
        const tr = el("tr");
        r.forEach((c) => tr.appendChild(el(header ? "th" : "td", null, c)));
        table.appendChild(tr); header = false; i++;
      }
      wrap.appendChild(table); section.appendChild(wrap);
    }
    if (!root.children.length) root.appendChild(el("p", "muted", "The Dashboard tab is empty."));
  }

  function amountNode(v) {
    const n = num(v); const a = el("div", "amt" + (n < 0 ? " neg" : ""), v || ""); return a;
  }

  function renderAccounts() {
    const rows = data.accounts.rows;
    fillSelect($("accType"), uniq(rows.map((r) => r.values["Type"])), "All types");
    fillSelect($("accOwner"), uniq(rows.map((r) => r.values["Owner"])), "All owners");
    const q = $("accSearch").value.toLowerCase(), t = $("accType").value, o = $("accOwner").value;
    const list = $("accList"); list.replaceChildren();
    for (const r of rows) {
      const v = r.values;
      if (t && v["Type"] !== t) continue;
      if (o && v["Owner"] !== o) continue;
      if (q && !Object.values(v).join(" ").toLowerCase().includes(q)) continue;
      const b = el("button", "item"); b.type = "button";
      const left = el("div"); left.append(el("div", "t", v["Account"]), el("div", "s", [v["Institution"], v["Type"], v["Owner"]].filter(Boolean).join(" · ")));
      const right = el("div"); right.append(amountNode(v["Current Amount"]), el("div", "s", v["Last Updated"] ? "Updated " + v["Last Updated"] : ""));
      b.append(left, right);
      b.addEventListener("click", () => openEditor("Accounts", r));
      list.appendChild(b);
    }
    if (!list.children.length) list.appendChild(el("p", "muted", "No accounts match."));
  }

  function renderTransactions() {
    const rows = data.transactions.rows;
    fillSelect($("txnAccount"), uniq(rows.map((r) => r.values["Account"]).concat(data.accounts.rows.map((r) => r.values["Account"]))), "All accounts");
    fillSelect($("txnKind"), uniq(rows.map((r) => r.values["Kind"])), "All kinds");
    fillSelect($("txnStatus"), uniq(rows.map((r) => r.values["Status"])), "All statuses");
    const q = $("txnSearch").value.toLowerCase(), a = $("txnAccount").value, k = $("txnKind").value, s = $("txnStatus").value;
    const from = $("txnFrom").value, to = $("txnTo").value;
    const sorted = [...rows].sort((x, y) => isoDate(y.values["Date"]).localeCompare(isoDate(x.values["Date"])) || y.row - x.row);
    const list = $("txnList"); list.replaceChildren();
    let shown = 0;
    for (const r of sorted) {
      const v = r.values, d = isoDate(v["Date"]);
      if (a && v["Account"] !== a) continue;
      if (k && v["Kind"] !== k) continue;
      if (s && v["Status"] !== s) continue;
      if (from && d < from) continue;
      if (to && d > to) continue;
      if (q && ![v["Note"], v["Category"], v["Txn ID"], v["Source"], v["Account"]].join(" ").toLowerCase().includes(q)) continue;
      if (++shown > 500) continue;
      const b = el("button", "item"); b.type = "button";
      const left = el("div"); const title = el("div", "t", v["Account"]);
      if (v["Status"]) title.appendChild(el("span", "badge" + (v["Status"].toUpperCase() === "FAILED" ? " failed" : ""), v["Status"]));
      left.append(title, el("div", "s", [d, v["Kind"], v["Category"], v["Note"]].filter(Boolean).join(" · ")));
      b.append(left, amountNode(v["Amount"]));
      b.addEventListener("click", () => openEditor("Transactions", r));
      list.appendChild(b);
    }
    $("txnCount").textContent = shown > 500 ? `Showing 500 of ${shown}. Narrow the filters to see more.` : `${shown} transaction${shown === 1 ? "" : "s"}`;
  }

  for (const id of ["accSearch", "accType", "accOwner"]) $(id).addEventListener("input", () => data && renderAccounts());
  for (const id of ["txnSearch", "txnAccount", "txnKind", "txnStatus", "txnFrom", "txnTo"]) $(id).addEventListener("input", () => data && renderTransactions());
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    for (const v of ["overview", "accounts", "transactions"]) $("view" + v[0].toUpperCase() + v.slice(1)).classList.toggle("hidden", v !== t.dataset.view);
  }));

  // ---------- editor ----------
  let editing = null;
  const LAST4 = /(\d)[\s\-.\u2022*xX#]+(?=\d)/g;
  function openEditor(tab, row) {
    editing = { tab, row };
    $("editorTitle").textContent = (row ? "Edit " : "Add ") + (tab === "Accounts" ? "account" : "transaction");
    const box = $("editorFields"); box.replaceChildren(); msg("editorMsg", "");
    for (const [name, kind, req] of FIELDS[tab]) {
      const lab = el("label", kind === "text-wide" ? "wide" : null, name + (req ? " *" : ""));
      let input;
      const cur = row ? row.values[name] : "";
      if (kind === "status" || kind === "kind" || kind === "account") {
        input = el("input"); input.setAttribute("list", "dl-" + name.replace(/\s/g, ""));
        const dl = el("datalist"); dl.id = "dl-" + name.replace(/\s/g, "");
        const pool = kind === "account" ? uniq(data.accounts.rows.map((r) => r.values["Account"]))
          : kind === "status" ? uniq(["POSTED", "PENDING", "FAILED"].concat(data.transactions.rows.map((r) => r.values["Status"])))
          : uniq(data.transactions.rows.map((r) => r.values["Kind"]));
        for (const p of pool) { const o = el("option"); o.value = p; dl.appendChild(o); }
        lab.appendChild(dl);
      } else if (kind === "date") {
        input = el("input"); input.type = "date";
      } else {
        input = el("input"); input.type = "text";
        if (kind === "amount") input.inputMode = "decimal";
      }
      input.name = name; input.required = !!req; input.autocomplete = "off";
      input.value = kind === "date" ? isoDate(cur) : (kind === "amount" && cur ? String(num(cur)) : cur);
      if (kind === "date" && !row && name === "Date") input.value = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      lab.appendChild(input); box.appendChild(lab);
    }
    $("editor").showModal();
  }
  $("accAdd").addEventListener("click", () => openEditor("Accounts", null));
  $("txnAdd").addEventListener("click", () => openEditor("Transactions", null));
  $("editorCancel").addEventListener("click", () => $("editor").close());
  $("editorForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const { tab, row } = editing;
    const values = {};
    for (const [name] of FIELDS[tab]) values[name] = $("editorForm").elements[name].value.trim();
    for (const f of ["Account", "Institution"]) {
      if (values[f] !== undefined && /\d{5,}/.test(values[f].replace(LAST4, "$1"))) { msg("editorMsg", `${f} can only show the last 4 digits of a number.`); return; }
    }
    const btn = $("editorSave"); btn.disabled = true; msg("editorMsg", "");
    try {
      if (row) await api({ action: "update", tab, row: row.row, values, expected: row.values });
      else await api({ action: "append", tab, values });
      $("editor").close();
      await loadAll();
      msg("appMsg", "Saved to the sheet.", true);
    } catch (e) {
      if (e.status === 401) { $("editor").close(); return signOut(); }
      msg("editorMsg", e.message);
    } finally { btn.disabled = false; }
  });

  sb.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_OUT") { data = null; clearViews(); show("screenLogin"); } });
  route();
})();
