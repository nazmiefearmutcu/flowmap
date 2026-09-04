# FlowMap — Kapsamlı Frontend (UI) Review

**Repo:** https://github.com/nazmiefearmutcu/flowmap — commit `7ae45a1` (main, v1.3.1.1, 2026-08-01)
**İnceleyen:** ana ajan (frontend/UX görevası) — paralel code review ajanları ayrıca çalışıyor
**Yöntem:** (1) tüm UI kaynak dosyalarının statik okuması (App.tsx, 19 ui/ bileşeni, theme.css + App.css ~1.9K satır, index.html), (2) **canlı çalıştırma**: fresh clone server (Desktop pyruntime Python 3.13 üstünden, `FLOWMAP_PORT=8720`, sim feed) + vite 5173 + Playwright/SwiftShader chromium ile 12 durumun ekran görüntüsü + konsol/pageerror yakalama.

**Ekran görüntüleri:** `flowmap-review/shots/out/01-main-live.png … 12-no-webgl2.png`

---

## 1. Yönetici Özeti

FlowMap'in UI'ı bir "professional order-flow terminal" hedefini **istisnai tutarlılıkla** yakalıyor: tek token seti (theme.css), GL rampasıyla birebir kilitli aksan renkleri, tabular mono numerikler, ve projenin en güçlü fikri olan **"dürüstlük (§7) ilkesi"nin** her yüzeyde uygulanması (SYNTH her yerde amber, capability chip'leri aynen, spread yalnız iki taraf gerçekten varken). A11y.bilinçli durum üstü: focus-visible ring'leri, aria-pressed/role=status/dialog odak tuzağı/odak iadesi, combobox aria-activedescendant, prefers-reduced-motion. Yüksek frekanslı verinin React dışında tutulması (renderer canvas'ı owns, 10Hz module store, değer-farklıysa-setState poll'ları) mimari olarak doğru.

Ancak canlı testte **2 kritik, 1 yüksek** kullanıcı-etkileyen bulgu çıktı:

| # | severity | bulgu |
|---|----------|-------|
| F1 | **Critical** | WebGL2 yoksa uygulama **tamamen siyah ekran** — hata mesajı/fallback yok, React tree çöküyor |
| F2 | **High** | ~<1000px genişlikte topbar taşıyor: 900px'de Rail yarım kesik + Settings erişilemez, 620px'de mod/status/saat/rail/settings **tamamen kayıp** |
| F3 | **Medium** | Replay modunda DOM merdiveni kalıcı "waiting for book…" — T&S dolu olduğu halde yanıltıcı boş-state mesajı |

Bunların dışında arayüz canlı sim verisiyle sorunsuz çalıştı: crosshair okuması, merdiven spread okutması, T&S renk/yan side sınıfları, CVD alt paneli hizası, palet önizleme paneli, ayarların canlı uygulanması, colormap geçişi (Inferno→Classic) SYNTH amber'ını koruyarak.

---

## 2. Kritik Bulgular

### F1 — WebGL2 fallback yok: siyah ekran (Critical)
**Kanıt:** `12-no-webgl2.png` — WebGL2'i devre dışı bırakılmış tarayıcıda tüm pencere #000. `pageerror: flowmap/gl: WebGL2 is not available in this browser/context` ×3.
**Kök neden:** `App.tsx:111-191` mount-once effect'i içinde `new Renderer(...)` bir istisna fırlatıyor; effect'teki yakalanmayan istisna React 18'de tüm root'u söker — topbar/paneller dahil hiçbir chrome render edilmiyor. Hata mesajı da kullanıcıya ulaşmıyor.
**Etki:** GPU'su kapalı/VM/uzak masaüstü/eski makine kullanıcılarında uygulama "açılmıyor" gibi görünür; teşhis için konsol gerekir.
**Öneri:** (a) Renderer kurulumunu try/catch'e al, hata durumunda viewport yerine net bir "WebGL2 gerekli" paneli + reinstall/hardware kılavuzu göster; (b) React error boundary ekle (root düzeyi) ki tek panel hatası tüm uygulamayı sökmeye yetmesin; (c) `gl/context.ts`'in döndürdüğü hatayı UI'a taşı.

### F2 — Topbar dar ağırlıkta taşıyor (High)
**Kanıt:** `10-narrow-900.png` (Rail düğmesi ekran dışına kaymış, Settings tamamen görünmez; saat kısmen kesik) ve `11-narrow-620.png` (LIVE/REPLAY, status, saat, Rail, Settings'in tamamı ekran dışı — erişilemez).
**Kök neden:** `App.css:35-48` `.topbar` tek satır `flex`, `nowrap` eğilimli çocuklar (`white-space: nowrap` her chip'te) ve wrap/scroll/media-query yok. Toplam doğal genişlik ≈1200px+; Tauri penceresi veya bölünmüş ekran 1000px altına düştüğünde kontroller kaybolur (klavye kısayolu olan Settings açılamaz bile).
**Öneri:** (a) `@media (max-width: 1100px)`: caps grubunu gizle (title'da zaten var), saati yalnız duyarlı modda sadeleştir; (b) 900px altı: `.topbar { flex-wrap: wrap; height: auto; }` veya taşan öğeleri `overflow-x: auto` ikinci satıra al; (c) en düşük baraj: topbar'a `min-width:0` + `flex-shrink` verip symbol trigger'ı daralt (232px sabit genişlik `App.css:325`).

### F3 — Replay'de DOM merdiveninin "waiting for book…" mesajı (Medium)
**Kanıt:** `08-replay.png` — T&S 20+ satırla dolu, DOM paneli "waiting for book…" gösteriyor; kullanıcı kitabın "geleceğini" bekler.
**Kök neden:** `DomLadder.tsx:364-371` empty mesajı yalnız `feedState`/`status`'a bakıyor; replay oturumunda kitap akışının gelmeyeceği (veya geç geleceği) bilgisi bu state'e yansımıyor.
**Öneri:** replay modunda "no book in replay — showing trades only" gibi durum-dürüst bir mesaj (veya replay'de kitap varsa geri doldurma).

---

## 3. Orta/ Düşük Bulgular (statik + canlı)

1. **Palet ilk-açılış deneyimi sim-only sunucuda boş** (`03-palette-movers.png`): "Top movers unavailable — type to search…" mesajı dürüst ve doğru, ancak ilk açılışta liste boş; sim/veri-yok senaryosunda en azından sembol dizini (universe) satırları gösterilebilirdi. Not: `04-palette-query.png`'de "btc" araması tek sonuç döndürdü — klonda `/api/universe` kısa döndü (ortamla ilgili olabilir, UI değil).
2. **`Tape.tsx:143` satır anahtarı `` `${t.tsNs}-${i}` ``** — index eki, hızlı akışta satır kimliğini karıştırır (React reconciliation'ı satır taşımayı animasyon/diff açısından boşa çıkarır). `tsNs+price+size+side` bileşik anahtarı daha kararlı. Düşük etkili.
3. **`App.css:24-29` `.app { height: 100vh; width: 100vw; }`** — mobil Safari/dinamik çubuk taşması klasik riski; hedef masaüstü Tauri olduğu için düşük öncelik, yine de `100dvh` + `overflow: clip` daha güvenli.
4. **`index.html`** — `<meta name="description">` yok, `theme-color` yok; masaüstü uygulama için etkisi minimal.
5. **Settings drawer arka planı kilitlemiyor** — scrim fare tıklamalarını yiyor ama klavye/odak arka plandaki kontrollere gidebilir (Tab trap yalnız drawer içindeki Tab'ları yakalıyor; drawer açıkken global kısayollar hâlâ çalışıyor — Space ile follow toggle yapılabiliyor). `keys.ts` tarafında modal açık-kapalı gating'i yok (önceki oturum kayıtlarında da "modal global-key gating" yapılmamış olarak not edilmiş — hâlâ geçerli).
6. **Kısayol keşfedilebilirliği** — Space, `/`, ⌘K, P, R, `[`/`]` gibi kısayolların hiçbiri UI'da listelenmiyor (yalnız palet footer'ında ↑↓/↵/esc var). Bir "klavye kısayolları" bölümü (Settings drawer altına ya da `?` modalı) düşük maliyetli yüksek kazanç.
7. **`.topbar` "Rail" düğmesi etiketi** — yeni kullanıcı için şifreli (title'ı var ama dokunma/cihazda görünmez). "Panels" gibi daha açıklayıcı bir kelime düşünülebilir.
8. **T&S hover-pause'un görsel göstergesi yok** (`Tape.tsx:94-100`): hover'da liste donuyor ama ekranda "paused" işareti yok; kullanıcı satırların neden güncellenmediğini anlamıyor olabilir. Soluk bir "held" çipi eklenebilir.
9. **`fmtStreamClock` (App.tsx:48-56)** sim oturumunda `T 00:00:06 UTC` biçiminde UTC diyor; sim ts'si oturum-göreli olduğundan "UTC" iddiası sim-de yanıltıcı (T&S/crosshair z biçimi de aynı). Estetik dürüstlük ilkesine küçük ters düşüş.

---

## 4. Güçlü Yönler (korunmalı)

- **Tasarım sistemi disiplini:** theme.css'te 30'dan az token ile tüm yüzeyler; aksan çifti (#1fb6a6/#d3524f) GL overlay'leriyle piksel düzeyinde kilitli; `HeatLegend` gradient'i `gl/lut.ts` stop listesinden üretiliyor (`HeatLegend.tsx:124-128`) — rampa değişince lejant kendiliğinden uyar. Bu tür "tek kaynak" kararları nadir ve değerli.
- **Dürüstlük ilkesinin tutarlı uygulanışı:** SYNTH amber her yüzeyde (heatmap, ladder, lejant, chip); spread yalnız iki taraf gerçekken (`DomLadder.tsx:186-193`); ölü quote "data unavailable"; failed venue listing ≠ empty venue (`SymbolSearch.tsx:575-593` retry'lı ayrık state'ler); non-finite size "∞" ("Infinity" yerine). Bu, TradingView sınıfı araçlarda bile eksik olan bir olgunluk.
- **Erişilebilirlik:** focus-visible ring seti (App.css:1741-1765), statik accessible name + aria-pressed ayrımı (`PriceAxis.tsx:77-81` — "LOCK, not pressed" tuzağına karşı), dialog odak yönetimi (SettingsDrawer.tsx:73-100), `aria-live` status'lar, canvas'larda aria-hidden + role=img lejantta, reduced-motion. Pek çok ticari terminalin altında bile.
- **Performans mimarisi:** yüksek frekans React dışında; tüm poll'lar (100-250ms) değer-değişti-ise setState deseniyle; Timeline geom diff eşiği 0.3%; Crosshair rAF-coalesced; Drawer/panel güncellemeleri 10Hz store aboneliğiyle. UI thread'inin GL döngüsüyle çatışmaması sağlanmış.
- **Canlı doğrulama:** sim feed ile tüm paneller, crosshair, palet, ayarlar, replay transport, colormap geçişi hatasız; konsolda yalnız teardown anı WS uyarısı (benign), pageerror sıfır.

---

## 5. Önceliklendirilmiş Öneriler

1. **(F1)** WebGL2 hata paneli + root error boundary — küçük DEĞİŞİKLİK, kritik kapatma.
2. **(F2)** Topbar responsive kırılımları (1100/900px media query'leri).
3. **(F3)** Replay DOM boş-state mesajı.
4. Drawer açıkken global kısayolları gate'le + T&S hover "held" göstergesi.
5. Kısayol yardım paneli (`?`).
6. Tape satır anahtarını bileşik yap.
7. `100dvh`, meta description/theme-color hijyen dokunuşları.

---

## 6. Paralel Code Review Sürüsü Durumu

6 kapsamda (server core, server feeds/api, client net/proto/state, client GL, client React, build/packaging) arka plan incelemesi başlatıldı; API rate-limit nedeniyle 5 ajan düştü, **tek tek sırayla** yeniden başlatılıyor (paralel sürü limiti aşıyor). Raporlar `flowmap-review/*.md` altına yazılacak; tamamlanınca derlenip `MASTER-REVIEW.md`'de birleştirilecek.
