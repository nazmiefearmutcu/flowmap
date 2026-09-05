# Security

FlowMap ships **unsigned installers** — an Apple Developer ID and a Windows publisher
certificate both cost money this project does not have. So your OS will warn you, and it is
right to: an unsigned binary from an unknown developer is, on its face, indistinguishable
from malware. "The source is open" is not an answer, because the source is not what you
downloaded.

This file is the answer. Everything below is checkable — by you, without trusting me.

## Verify what you downloaded

Every installer in a release is signed with a **SLSA build-provenance attestation** at build
time ([`.github/workflows/release.yml`](.github/workflows/release.yml)). The attestation is a
Sigstore-backed statement that binds the file's SHA-256 digest to this repository, this
workflow file, and the exact commit it was built from. GitHub stores it publicly; nothing on
the release page can forge it.

```bash
# needs the GitHub CLI: https://cli.github.com
gh attestation verify ~/Downloads/<the-file-you-downloaded> -R nazmiefearmutcu/flowmap
```

A pass prints the workflow and commit that produced the file. **A failure means the file did
not come from this repository — do not run it.**

> Attestations and `SHA256SUMS` are produced by the release workflow from the **next tagged
> release onward**. Assets on v1.3.0 and earlier were built before this existed and will not
> verify — that is their age, not tampering, and it is exactly the gap this closes.

Each release also carries a `SHA256SUMS` asset covering every installer, for a check that
needs no tooling at all:

```bash
shasum -a 256 -c SHA256SUMS      # run it in the folder you downloaded into
```

The checksums tell you the file arrived intact. The attestation tells you *where it came
from*. Prefer the attestation; the checksums are the fallback.

## The unsigned-app warning

Once a download verifies, the OS warning is about a missing certificate — not about the file
being unknown to you. Getting past it:

- **macOS:** right-click → **Open** (confirm once), or `xattr -cr /Applications/FlowMap.app`.
- **Windows:** SmartScreen → **More info** → **Run anyway**.

Do this **after** `gh attestation verify` passes, not before. If you are not willing to do it
in that order, run from source instead — it is a supported path, not a fallback:

```bash
./scripts/dev.sh          # Python 3.13 + uv, Node 22 + npm; no binary to trust
```

## What FlowMap is, from a security point of view

A market-data **viewer**. It reads public market data and draws it. It places no orders, holds
no funds, and has no code path that could.

| | |
|---|---|
| Wallets, private keys, seed phrases | **Never asked for, no code to accept them** |
| Trading / withdrawal API keys | **Never asked for.** The optional keys below are read-only *market data* keys |
| Telemetry, analytics, crash reporting | **None.** No SDK, no beacon, no first-run ping |
| Auto-updater | **None.** The Tauri build enables no updater or shell plugin — an update is a download you initiate |
| Network listener | `127.0.0.1:8720` only. Any non-loopback `FLOWMAP_HOST` is rejected with `ValueError` at startup ([`server/src/flowmap_server/config.py`](server/src/flowmap_server/config.py)), not silently accepted |
| Authentication on the local API | **None — by design, today.** See the next section |
| Browser origins accepted | The local client only (`http://localhost:5173`, `http://127.0.0.1:5173`, `http://tauri.localhost`) |
| Elevated privileges | None. The Windows `-setup.exe` installs per-user, no admin |

## The local API has no authentication — plainly stated

The sidecar's HTTP and WebSocket endpoints (`/api/*`, `/ws` on `127.0.0.1:8720`, including the
operational snapshot at `/api/health`) accept **any local process, with no token, no auth, and no
confirmation**. This is a deliberate trade, not an oversight: FlowMap is a single-user desktop
app whose only client is the one sitting next to the server, so the trust boundary it enforces is
the operating system's user account, not a password. Everything the API can do — subscribe to
public market data, read the symbol directory, drive a replay — is something any process running
as your user can already do on its own.

Threat model, honestly drawn:

- **In scope:** a malicious *remote* party. The server never binds a non-loopback address
  (enforced twice, in `Config.from_env` and again at the entrypoint), and the client loads no
  external origin, so a remote attacker has no route into the API.
- **Out of scope:** a malicious process already running as your user. It can read this API — and
  also your browser cookies, SSH keys, and everything else you own. No in-app authentication
  changes that; adding one would only create a false sense of a boundary that does not exist.
- **Known residual risks:** any local process can read your session recordings
  (`~/.flowmap/recordings/`), consume the API, or preempt port 8720. Cross-origin *browser*
  requests are limited by the CORS allow-list (the vite dev origins and `tauri.localhost`, set in
  `api/app.py`) — but CORS is browser-enforced only; it is not a defense against non-browser
  local processes, and it is not a complete DNS-rebinding defense. If this threat model does not
  fit your environment (e.g. shared or untrusted machines), run from source behind a firewall
  rule that blocks 8720 for other local users, or do not run FlowMap there.

If a hardening release (loopback auth token, per-origin pinning) is wanted, it will be treated as
a feature, designed openly, and announced — silently tightening the boundary on existing users is
worse than the gap.

## Where it connects

Outbound traffic is market data, and it is driven by what you subscribe to:

- **Crypto** — the public REST/WebSocket endpoints of the venue you pick, reached through
  [Crocodile](https://github.com/nazmiefearmutcu/Crocodile) (native connectors for binance,
  bybit, coinbase, deribit, okx; every other venue via `ccxt`). Public endpoints: no key, no
  account.
- **Crypto history backfill** — `api.binance.com`, `fapi.binance.com`, `dapi.binance.com`
  ([`server/src/flowmap_server/core/backfill.py`](server/src/flowmap_server/core/backfill.py)).
- **US equities** — Yahoo 1-minute bars for the keyless SYNTH tier.
- **US equities, optional upgrades** — Alpaca (`ALPACA_API_KEY` + `ALPACA_API_SECRET`) and
  Finnhub (`FINNHUB_API_KEY`), read from the environment if present and simply absent if not.
  These are **market-data** credentials; FlowMap never sends an order endpoint a request.
- **The `sim:SIM-DEMO` feed** — no network at all. Use it to watch what the app does before
  giving it a live venue.

The WebGL2 client loads **no** external origin: no CDN, no web fonts, no analytics. Everything
it renders comes from the loopback server.

## What it writes

`~/.flowmap/recordings/{market}/{symbol}/…parquet` — its own session recordings, so you can
replay them. A global cap (default **20 GB**, `FLOWMAP_RECORDING_GB_CAP`) deletes the oldest
files as it fills. Set `FLOWMAP_RECORDING_ENABLED=0` to write nothing, or point
`FLOWMAP_DATA_DIR` elsewhere. It writes nowhere else in your home directory.

## What is in the installer

The installers are large (100–430 MB) because they are self-contained: the built WebGL2 client,
a relocatable CPython 3.13 from
[astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone), the
Python dependencies from `server/pyproject.toml`, and the Tauri shell. Nothing is fetched at
first run.

The dependency set is deliberately small and pinned: the market-data engine is pinned to an
exact git commit (`crocodile` rev in
[`server/pyproject.toml`](server/pyproject.toml)), and the rest are mainstream libraries —
`aiohttp`, `certifi`, `msgspec`, `numpy`, `polars`, `fastapi`, `uvicorn`. Every GitHub Action
used in CI is pinned to a commit SHA rather than a moving tag.

## Reporting a vulnerability

**Contact (maintainer placeholder — replace with the active handle/email):** open a private
GitHub security advisory, or reach the maintainer via `@nazmiefearmutcu` on GitHub.

Open a [private security advisory](https://github.com/nazmiefearmutcu/flowmap/security/advisories/new)
— that keeps the report non-public until there is a fix. Please do not open a public issue for
a vulnerability. Include what you ran, what you observed, and how to reproduce it.

Only the latest release is supported; fixes go out as a new tagged release.
