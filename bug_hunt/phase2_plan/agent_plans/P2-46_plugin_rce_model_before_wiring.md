# P2-46 — Plugin RCE Model Before Wiring

| Field | Value |
|-------|-------|
| **Agent** | P2-46 |
| **Theme n** | 46 |
| **Track** | E — Security |
| **Zones** | **Z19** (Plugins security model) |
| **Siblings** | R13-S1–S8, R20 P1-12, R13-C10 |
| **Severity prior** | **P0 if enabled**; currently **latent P1 design debt** |
| **Focus** | `exec_module` unsandboxed load; decide model **before** MainWindow wiring |

---

## 1. Scope & linked zones / sibling hyps

### Files
- `/Users/nazmi/flowmap/flowmap/plugins/loader.py` — discover, `exec_module`, sys.path mutate
- `/Users/nazmi/flowmap/flowmap/plugins/plugin_api.py` — PluginAPI, AddonState, callback wrap
- `/Users/nazmi/flowmap/plugins/example_indicator.py` — sample
- **No call sites** in `main.py` / `MainWindow` (R13-S8)

### R13 security matrix (carry forward)

| ID | Sev | Issue |
|----|-----|-------|
| S1 | P0 if on | Arbitrary code via exec_module |
| S2 | P1 | No trust model |
| S3 | P1 | sys.path insert shadowing |
| S4 | P1 | Mutable OrderBook exposed |
| S5 | P2 | Load hang / fork before register returns |
| S6 | P2 | Callback wrap clobber (links P2-16) |
| S7 | P3 | Global error dict / traceback leak |
| S8 | P3 latent | Docs claim auto-load; not wired |

### Scope
- Threat model + security requirements doc for Phase 4.
- Red-team “if we call load_all today” impact.
- **Do not** wire plugins in Phase 3 without model sign-off.
- Interaction with packaging: never bundle untrusted plugins (R13-C10).

---

## 2. Threat model

| Attacker | Vector | Impact |
|----------|--------|--------|
| Malicious `.py` in `plugins/` | Auto-load at start | Full user RCE |
| Dependency confusion | sys.path insert package name `flowmap` | Shadow core |
| Evil plugin | Mutate OrderBook | Wrong trading viz / if ever trading bridge worse |
| Evil plugin | Wrap on_trade | Clobber other plugins / core (P2-16) |
| Supply chain | Example plugin replaced | Same RCE |
| Packaged app cwd | Load from unexpected dir | Accidental load |

**Assets:** user account, data lake path, live network credentials in process, GUI session.

**Current exposure:** code present but unwired → **risk is enabling feature without redesign**.

---

## 3. Concrete probes

### 3.1 Static confirmation unwired

```bash
rg -n "load_all_from_directory|discover_plugins|load_and_register|PluginAPI" \
  /Users/nazmi/flowmap/flowmap --glob '*.py'
# Expect: only plugins/* and example
```

### 3.2 Hostile plugin lab (isolated)

Create **offline** test dir `/tmp/flowmap_plugin_evil/` with:

```python
# pwn.py — DO NOT point production data_dir here
def register(api):
    open("/tmp/flowmap_pwned", "w").write("pwned")
    # optional: attempt network, subprocess
```

Call `load_plugin` + `register_plugin` in unit test subprocess.  
**Pass if:** proves RCE class (file written) → FIND documents latent risk.  
**Never** run hostile plugins against production lake or with network secrets.

### 3.3 sys.path shadow test

Plugin dir contains `json.py` or `flowmap.py`; import after load; assert core not shadowed after path pop (race during exec).

### 3.4 OrderBook mutability

Plugin calls `get_order_book()` and mutates internal dicts; assert whether core paint uses mutated state.

### 3.5 Callback clobber (coord P2-16)

Two plugins register_with_app; assert on_trade chain integrity.

### 3.6 Packaging

Confirm dist does not auto-scan cwd plugins; document C10.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PLG-P1 | Written security model approved before any MainWindow wire | Wire without model |
| PLG-P2 | Default **plugins disabled** | Default on |
| PLG-P3 | Allowlist path + hash/signature OR separate process | Bare exec_module only |
| PLG-P4 | Read-only OrderBook facade | Mutable OB to plugin |
| PLG-P5 | Docs match reality (no false auto-load) | Docs lie |
| PLG-P6 | Load timeout / subprocess kill | Hang main thread forever |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| `/tmp` evil plugin set | RCE class proof in sandbox |
| Good example_indicator | Happy path |
| Malformed plugin (no register) | Error path |
| Shadow package dir | sys.path |
| Subprocess test runner | Containment |

---

## 6. Phase-3 micro-tasks

| Hunt | Work |
|------|------|
| **H-46A** | Confirm zero production call sites + doc false claims FIND |
| **H-46B** | Sandboxed RCE class demonstration (FIND-P246-01) |
| **H-46C** | API surface threat review (OB, callbacks, notify_*) |
| **H-46D** | Write **Plugin Security Model v1** (requirements for Phase 4) |
| **H-46E** | Packaging/cwd load scenarios |

---

## 7. Expected finding IDs — `FIND-P246-XX`

| ID | Sev | Title |
|----|-----|-------|
| FIND-P246-01 | P0 latent | exec_module RCE if enabled |
| FIND-P246-02 | P1 | No trust/allowlist model |
| FIND-P246-03 | P1 | sys.path mutation |
| FIND-P246-04 | P1 | Mutable OrderBook exposure |
| FIND-P246-05 | P2 | Callback wrap clobber |
| FIND-P246-06 | P2 | Import-time hang risk |
| FIND-P246-07 | P3 | Docs auto-load false |
| FIND-P246-08 | P2 | Root `plugins` top-level package name collision |

---

## 8. Fix strategy sketch (security model outline)

**Model A — Recommended short term:** Keep **disabled**; mark experimental; fix docs; do not wire.

**Model B — Safe enable:**
1. User opt-in checkbox + restart.
2. Load only from `~/Library/Application Support/FlowMap/plugins` (macOS) allowlisted.
3. SHA256 allowlist file edited by user.
4. Subprocess plugin host + JSON IPC for indicators (no in-process exec long-term).
5. Read-only `OrderBookView` Protocol.
6. Callback registration via list, not reassignment.
7. Load timeout 2s kill.
8. Never `sys.path.insert` of plugin dir; force absolute imports only.

**Model C — Delete half-built API** until B ready (reduces attack surface).

---

## 9. Dependencies

| Theme | Link |
|-------|------|
| P2-16 | on_trade=None / wrap clobber |
| P2-48 | packaging must not enable plugins by accident |
| P2-47 | portable plugin data dirs |
| P2-50 | CUA not required unless UI gate added |

**Hard rule:** Phase 3 may **prove** risk; Phase 4 enables only after Model B.

---

## 10. Severity priors

R13-S1 → **P0 if enabled**. Unwired → file as **P0 latent / P1 design**. Enabling without fix = **release blocker**.
