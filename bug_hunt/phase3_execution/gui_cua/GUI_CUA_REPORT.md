# FlowMap — Computer-Use (cua-driver) Ön Yüz Test Raporu

**Tarih:** 2026-07-13  
**Tooling:** cua-driver CLI + session `flowmap-main-display`  
**App:** `python run_flowmap.py` pid 68053  

## Multi-monitor bağlam

| Ekran | Çözünürlük | Rol |
|-------|------------|-----|
| **C27JG5x** | 2560×1440 | **Main display** (origin 0,0) |
| VX2458-mhd | 1920×1080 | İkincil |
| LF24T450F | 1920×1080 | İkincil |

Python process ~15 pencere üretiyor (Qt dock/helper/menubar ghost’ları):
- `x=-1920` ve `x=2560` üzerinde 30px yüksekliğinde hayalet pencereler
- **Gerçek UI:** `window_id=2626`, title=`FlowMap`, `2175×1248 @ (100,100)` → **main display**

### Önceki hata
İlk CUA turunda menubar/AX gürültüsü ve çoklu pencere adayları yüzünden yanlış surface’e tıklanma riski vardı.

### Düzeltme kuralı
1. Sadece `title == "FlowMap"` + `is_on_screen` + merkez noktası main display içinde  
2. Menubar / Apple menü elementlerine **asla** tıklama  
3. Her aksiyon: `get_window_state(pid, window_id=2626)` → `element_index` → re-snapshot  
4. Klavye: `press_key` pid’e (ekran-bağımsız)

## Sonuç: **12/12 PASS**

| ID | Test | Sonuç |
|----|------|--------|
| CUA-MM-00 | Target main display FlowMap | PASS — wid=2626 @ (100,100) |
| CUA-MM-01 | Tree = FlowMap (Start/Stop + Symbol) | PASS |
| CUA-MM-02 | ■ Stop → ▶ Start | PASS |
| CUA-MM-03 | ▶ Start → ■ Stop | PASS |
| CUA-MM-04 | Sidebar checkbox toggle | PASS |
| CUA-MM-05 | SETTINGS tab (Replay UI) | PASS |
| CUA-MM-06 | Show Volume Profile toggle | PASS |
| CUA-MM-07 | Space → stop | PASS |
| CUA-MM-08 | Space → start | PASS |
| CUA-MM-09 | F + R no crash | PASS |
| CUA-MM-10 | Hâlâ main display | PASS |
| CUA-MM-11 | Heatmap non-dark pixels | PASS (ratio≈0.23) |

## Artefaktlar

```
bug_hunt/phase3_execution/gui_cua/
  mm_00_target.png … mm_09_keys.png
  mm_results.json
  mm_target_window.json
  GUI_CUA_REPORT.md
```

## Not
Agent cursor overlay multi-monitor’da bazen ana ekran dışında görünebilir; **AX tıklamaları `window_id=2626` FlowMap’e gidiyor** (pixel screen-global değil, window-local + pid-targeted).
