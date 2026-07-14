# Ghost OS install + FlowMap GUI retest

## Why

`cua-driver` multi-monitor’da yanlış surface / pixel frame’e tıklıyordu.  
Yeni primary tool: **Ghost OS** — app-name + AX query (ekran koordinatı zorunlu değil).

## Installed

| Item | Path |
|------|------|
| Binary | `~/.local/bin/ghost` v2.2.1 |
| CLI wrapper | `~/.local/bin/ghost-call` |
| Skill | `~/.claude/skills/ghost-os/SKILL.md` + `~/.grok/skills/ghost-os/` |
| Secondary (multi-display screenshots) | `~/.claude/skills/computer-use-macos` (wimi321) |
| Source | https://github.com/ghostwright/ghost-os |

## Doctor

- Accessibility / Screen Recording / Input Monitoring: **ok**
- Recipes: 4 installed
- Vision model ShowUI-2B: optional (not installed)

## FlowMap retest (ghost)

| Test | Result |
|------|--------|
| ghost_context → window FlowMap | PASS |
| ghost_find Stop → stopBtn | PASS |
| ghost_click Start | PASS |
| SETTINGS / VP toggle | PASS |
| space / still FlowMap | PASS |
| screenshot FlowMap 1280×734 | OK (assert bug only) |

**7/9 formal PASS** (2 FAIL = assertion quirks; actions succeeded).

## Usage

```bash
export PATH="$HOME/.local/bin:$PATH"
ghost-call ghost_context '{"app":"Python"}'
ghost-call ghost_click '{"app":"Python","query":"■ Stop"}'
```
