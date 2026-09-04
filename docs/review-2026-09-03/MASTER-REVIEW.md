# FlowMap — MASTER-REVIEW (2026-09-03)

**Repo:** github.com/nazmiefearmutcu/flowmap @ `7ae45a1` (main, v1.3.1.1) — fresh clone: `C:\Users\Kullanıcı\.zcode\workspace\default\flowmap`

## Kapsam tablosu

| Kapsam | Yürütücü | Durum |
|---|---|---|
| Server core (core/*, config) | review ajanı | ✅ [server-core.md](server-core.md) |
| Frontend/UX/a11y (tüm UI) | ana ajan | ✅ [FRONTEND-REVIEW.md](FRONTEND-REVIEW.md) |
| Canlı doğrulama (sim feed + 12 durum ekran görüntüsü) | ana ajan | ✅ `shots/out/` (öncesi), `shots/out-fixed/` (sonrası) |
| Client net/proto/state + GL yüzey + build/packaging | ana ajan | ✅ [client-net-state-gl-build.md](client-net-state-gl-build.md) |
| Client React mantığı | ana ajan | ✅ FRONTEND-REVIEW.md §3-§4 kapsamında (tüm ui/* satır satır okundu) |
| Server feeds/crypto/equity derin satır-satır | — | ⚠️ hedefli tarama (secrets/backoff/temizlik ✓); tam okuma sonraki oturum |

**Rate-limit dersi (kalıcı):** bu API planında paralel review ajanı limiti **2 eşzamanlı**; altını aşan dalga [1302] ile toplu düşüyor. Kalan kapsam ana akışta tamamlandı.

## İkinci dalga bulguları (2026-09-03) — **DÜZELTİLDİ** (kullanıcı onayıyla, commit `eae87d6`)

| ID | Severity | Sorun | Uygulanan fix | Doğrulama |
|---|---|---|---|---|
| H-NEW-1 | High | **Replay sunucuda uygulanmamış**: `build_feed` mode'u yok sayar (aynı canlı feed), ws.py Seek/Speed/Pause/Resume'u düşer — client REPLAY pill'i + kontrolleri boş controllere bağlanır | Önce dürüst redd+gating; ardından **gerçek motor** (üçüncü dalga) | e2e `test_replay_subscribe_refused_with_1003` (kayıt yoksa); `test_replay_engine_streams_recorded_session` (motor) |
| M-NEW-1 | Medium | `connection.ts` reconnect timer + manuel connect yarışı → çift soket, çift trade/BBO akışı | `openSocket` bekleyen reconnect timer'ını iptal eder | `connection.test.ts` çift-soket yarış testi |
| M-NEW-2 | Medium | ws.py ölü eş algılama yok → kara delik TCP eşinde oturum+görev sonsuza dek takılı | `_send` 10s timeout + 30s liveness abort | e2e `test_silent_peer_aborted_after_liveness_timeout` |

**İkinci dalga doğrulama:** server 416 passed (2 yeni e2e) · client tsc clean + **593/593**.

## Üçüncü dalga: replay motoru + Low'lar (2026-09-03) — **TAMAMLANDI** (kullanıcı sürekli-onay talimatıyla; commit `ddc7918`, `bd71738`)

- **Replay motoru uygulandı** (H-NEW-1'in kalıcı çözümü): `feeds/replay.py` ReplayFeed — kayıtlı kolonları `BookState` snapshot'ına sintezleyip standart session/grid makinesinden akıtır; duvar-saati pacing + `control()` (Seek/SetSpeed/Pause/Resume); kayıt sonu park eder (session yıkılmaz), Seek geri sarar. `SessionManager.subscribe` replay için `recorder.load_all` ile besler (kayıt yoksa `ReplayUnavailableError` → dürüst 1003 reddi kalır). `_capability()` her Hello/Status'a `replay: True` server rozetini ekler → client Replay düğmesi bu build'de GERÇEKten çalışır. Controls ws dispatch'ten `Session.feed_control` ile beslemeye ulaşır. Semantik: SetSpeed tek başına pause'ı kaldırmaz (pause yalnız Resume ile açılır). Tasarım dokümanı: `docs/superpowers/specs/2026-09-03-replay-engine-design.md`. Fidelity notu: replay kitap snapshot'larını yeniden sintezler — kolon şekli/fiyatları kayıtla aynı, interval-içi mikro yapı değil.
- **Low'lar:** market_cache single-flight lock prune (dict büyümesi bitti); `client/perf_report.json` untrack + gitignore. CSP ve `beforeBuildCommand` bilinçli ertelendi (CSP paket-app smoke testi ister; build tuzağı package.sh akışında dokümante).
- **Doğrulama:** server **422 passed** (5 yeni replay birim + 1 yeni replay e2e; 2 capability assert'i yeni rozete güncellendi; tek fail pre-existing config). Client değişmedi (593/593 geçerli).

## Birinci dalga bulguları (uygulandı)

Brainstorming skill'i ile tasarım paketi sunuldu, kullanıcı **A+B+C+D tamamı**na onay verdi; hepsi uygulandı ve doğrulandı.

### Kritik
| ID | Sorun | Fix | Doğrulama |
|---|---|---|---|
| C1 | `grid.py` canlı yoğunluk f16'ya clamp'siz cast → SHIB/DOGE sınıfı kitaplarda tüm heatmap `+inf` | `_finalize_current`'ta 65504 saturasyonu | `test_a1_live_density_saturates_at_f16_max` |
| F1 | WebGL2 yok → Renderer effect'i throw → React root çöker → **tümü siyah ekran**, mesaj yok | try/catch + `glError` state + stage'de "Heatmap unavailable" paneli + root `ErrorBoundary`; bağlantı sürer, ladder/T&S/palet çalışır | canlı: `out-fixed/12-no-webgl2.png` (panel + canlı T&S), pageerror 3→0 |

### Yüksek
| ID | Sorun | Fix | Doğrulama |
|---|---|---|---|
| H1 | Hibrit ölçek kayıtlara yazılmıyordu → restart sonrası `deep` bant yanlış binliyor (kayda da geçiyor) | `_EPOCHS_SCHEMA`/`_epochs_frame`/`load_tail`'a 7 scale alanı (eski kayıtlar default=linear); `preload` `scale_of()` ile ölçeği kurar | `test_b1a_*`, `test_b1b_*` |
| H2+L2 | Boot sırasında teardown → ölümsüz zombi feed task + 256-512MiB ring sızıntısı; attach RuntimeError'u | `start()` boot sonrası `_closed` recheck → None; `subscribe` tek retry (`_retry` ile sınırlı) | `test_b2_*` (session + manager) |
| H3 | Tam-ring rehidrasyon satır-satır Python decode → ilk attach onlarca saniye donuyor | `load_tail` epoch çözümlemeyi öne aldı + bid/ask `list.explode().to_numpy().reshape` (C hızında); ragged veri → None (cold start) | `test_round_trip_bit_identical` (bit-özdeşlik) + `test_b3_*` |
| F2 | Topbar dar ekranda taşıyor — 900px'de Settings erişilemez, 620px'de yarı UI kayıp | Kademeli media query'ler (≤1180 caps, ≤1060 trigger+kbd, ≤960 ikincil saat, ≤880 wrap) | canlı: `out-fixed/10/11-*.png` — tüm kontroller erişilebilir |

### Orta
| ID | Sorun | Fix | Doğrulama |
|---|---|---|---|
| F3 | Replay'de DOM "waiting for book…" (kitap gelmeyecek) | "no book stream in replay — the tape keeps playing" | DomLadder testi |
| M1 | Dejenere mum boot'u sonsuz blokluyor (milyarlarca elemanlı range) | `lo_r/hi_r` clamp'i range ÖNCESİ | `test_c2_*` (düzeltesiz gerçekten hang ediyordu — reproduce edildi) |
| M2 | Başarısız tail yine de backfill'i kapatıyordu | `_apply_tail` bool döndürür | `test_c3_*` |
| M3 | İlk anchor'ı kapsayan banded tail kalıcı reddediliyordu | epoch-başına shape + `multiple ∈ {cfg, en-yeni}` | `test_c4_*` |

### Düşük/UX
keys.ts `dialog` gate'i (drawer açıkken Space artık chart'ı çevirmiyor) · index.html meta description/theme-color · `100dvh` · T&S hover "HELD" rozeti · sim akış saatinden yanıltıcı "UTC" ekinin kaldırılması · Settings drawer'a kodla doğrulanmış "Keyboard" referansı.

### Bilinçli ertelenenler (gerekçeli)
- Tape satır anahtarı `${tsNs}-${i}`: işlevsel olarak doğru (satır kimliği/animasyon yok) — değişim riski > kazanç.
- M4 ClientTx non-col drop-oldest O(n) taraması: patolojik yolda perf; yaygın durum ilk adımda buluyor; yapısal değişim riskli.
- M5 epochs retention muafiyeti: docstring'de "bilinçli basitlik" tradeoff'u olarak belgelenmiş.
- `tests/test_config.py::test_data_dir_env_override_expands_user`: temiz clone'da da düşen Windows path-ayraç sorunu (çevresel, önceden var).

## Doğrulama özeti

- **Server:** 9 yeni regresyon testi (`tests/core/test_review_fixes.py`) + tam suite: **414 passed** (1 fail pre-existing, stash ile kanıtlandı). Ortam notu: pyruntime'daki editable `.pth` Temp repo'yu gösterdiği için koşular `PYTHONPATH=<clone>/server/src` ile yapıldı — aksi halde yanlış paket test edilir.
- **Client:** `tsc -b` clean + **vitest 591/591** (keys/TopBar/DomLadder testleri yeni davranışa göre güncellendi ve genişletildi).
- **Canlı smoke:** sim feed + vite + Playwright; 12 durumun ekran görüntüleri `shots/out-fixed/`. Pageerror: 3 → **0** (WebGL2 senaryosu dahil). Kalan iki console uyarısı teardown anı WS kapanışı + abort edilen in-flight fetch — ikisi de benign.

## Değişen dosyalar
16 file changed, 502 insertions(+), 76 deletions(-) + 2 new (`client/src/ui/ErrorBoundary.tsx`, `server/tests/core/test_review_fixes.py`).
