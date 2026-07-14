# FlowMap Ön Yüz Testi — Ghost OS

**Araç:** Ghost OS v2.2.1 (`ghost` + persistent MCP)  
**App:** Python / window **FlowMap** (pid 68053)  
**Tarih:** 2026-07-13  

## Sonuç: **17/18 PASS** (1 bilinen Ghost query ambiguity)

| ID | Durum | Ne test edildi |
|----|--------|----------------|
| G01 | PASS | `ghost_context` → window=FlowMap |
| G02 | PASS | Toolbar: Stop/Start, Sidebar, Heatmap checkbox'ları |
| G03 | PASS | `ghost_find` Stop → `stopBtn` |
| G04 | PASS | Click **■ Stop** → **▶ Start** |
| G05 | PASS | Click **▶ Start** → **■ Stop** |
| G06 | PASS* | Sidebar tıklama (query bazen Heatmap'e düşüyor; `identifier=sidebarBtn` ile düzelir) |
| G07 | PASS | SETTINGS tab |
| G08 | PASS | INDICATORS tab |
| G09 | PASS | VP / BBO / Trades checkbox toggle |
| G10 | PASS | Show Order Heatmap toggle |
| G11 | PASS† | Space stop — `ghost_focus` sonrası çalışır |
| G12 | PASS | Space start |
| G13 | PASS | F (follow) |
| G14 | PASS | R (reset) |
| G15 | PASS | Symbol `AXTextField` |
| G16 | PASS | Screenshot 1280×734 FlowMap (+ PNG payload) |
| G17 | PASS | Suite sonunda hâlâ FlowMap |
| G18 | PASS | Dock Clear butonu |

\* `query:"Sidebar"` 8 eşleşme döndürüyor (sidebar paneli checkbox'ları + toolbar).  
  **Doğru kullanım:** `identifier: "QApplication.MainWindow.QToolBar.sidebarBtn"`  
† Suite'te ilk Space denemesi focus checkbox'tayken fail; `ghost_focus` + Space doğrulandı.

## Multi-monitor

Ghost **app adı + AX** ile hedef seçiyor; 3 monitörde yanlış ekran tıklaması yok.

## Komutlar

```bash
export PATH="$HOME/.local/bin:$PATH"
ghost-call ghost_context '{"app":"Python"}'
ghost-call ghost_click '{"app":"Python","query":"■ Stop"}'
ghost-call ghost_click '{"app":"Python","identifier":"QApplication.MainWindow.QToolBar.sidebarBtn"}'
ghost-call ghost_focus '{"app":"Python"}'
ghost-call ghost_press '{"app":"Python","key":"space"}'
```

## Artefaktlar

- `ghost_full_suite.json`
- `GHOST_FULL_SUITE_REPORT.md`
