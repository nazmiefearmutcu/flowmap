# Client net/proto/state + GL + build/packaging review (ana ajan, 2026-09-03)

Kapsam: `client/src/net|state|proto|input` (tam okuma), `client/src/gl` (yüzey taraması — context-loss, kaynak yönetimi, shader hassasiyeti desenleri), `app/src-tauri/tauri.conf.json`, `client/vite.config.ts`, repo hijyeni. React UI mantığı FRONTEND-REVIEW.md'de kapsandı.

## Bulgular

### High
**H-NEW-1. Replay modu sunucu tarafında uygulanmamış — kontroller boşluğa mesaj gönderiyor (client+server ortak).**
- `feeds/router.py::build_feed` yalnız `sub.market`'e bakar; `mode='replay'` aynı canlı feed'i üretir. Kayıttan okuyan bir replay feed'i yok.
- `api/ws.py::_dispatch`: "Seek/SetSpeed/Pause/Resume are replay controls (M3): decodable but inert" → düşürülüyor.
- Client REPLAY'e basınca aynı canlı akış "REPLAY 1× PLAYING" pill'i, play/pause, hız ve scrubber ile sunuluyor; Timeline.tsx docstring'inin LIVE için kaldırdığı "ölü kontroller" problemi replay'de yaşanıyor. ui/settings.ts'teki `HISTORY_LABEL` vb. dürüstlük ilkesiyle çelişen tek büyük yüzey.
- Öneri (ucuz + dürüst): sunucu `mode='replay'` Subscribe'ı `Status{feed_state:'degraded'}` reddiyle (SessionLimitError yolu gibi) geri çevirsin + client Replay düğmesini Hello capability'de replay bayrağı yoksa gizlesin ("replay this build'te yok" tooltip'i). Gerçek replay (kayıttan besleyen pacing feed + kontrol işleme) ayrı, ağır bir özellik olarak tasarlanmalı (Architectural path).

### Medium
**M-NEW-1. `net/connection.ts` — yeniden bağlanma zamanlayıcısı ile manuel `connect()` yarışı çift soket üretebilir.**
`scheduleReconnect` silahlandığı anda kullanıcı `subscribe()` → `connect()` çağırırsa (socket null) yeni soket açılır; ardından timer Patlar → `openSocket` `this.socket`'i EZEREK ikinci soket açar. İlki yetim kalır ama handler'ları canlıdır: her iki soket de abone olur → trade/BBO/marker çift akar (final kolonlar (epoch,col_seq) dedupe ile kurtulur), biri kapanınca `this.socket=null` yanlış sıfırlanır. Fix: `openSocket` başında bekleyen `reconnectTimer`'ı iptal et.

**M-NEW-2. `api/ws.py` — ölü eş algılama yok (send timeout / liveness policy).**
Kara deliğe düşen TCP eşi (FIN yok) `send_bytes`'i sonsuz bekletir → flush/ping görevleri takılır, `unsubscribe` hiç koşmaz → oturum refcount'ta kalır, sonsuza dek ölü ClientTx'e yayın yapar. Kuyruk offer-tarafı lag-drop ile sınırlı (bellek sızıntısı yok) ama oturum+görev sızıntısı gerçek. Fix: `_send`'e `asyncio.wait_for` timeout'u + ping-pong temelli liveness (N ping cevapsız → bağlantıyı kes).

### Low
- `api/market_cache.py`: `_quote_locks`/`_movers_locks` dict'leri sembol başına Lock biriktirir (asla evict edilmez) — sembollerle lineer, ihmal edilebilir ama sınırsız.
- `tauri.conf.json`: `"csp": null` — webview CSP'siz çalışıyor (yalnızca yerel varlık + loopback sidecar; pratik risk düşük, Tauri önerisine aykırı).
- `client/perf_report.json` commitlenmiş build artifact'ı.
- `tauri.conf.json`: `beforeBuildCommand: ""` — `vite build` unutulursa eski dist sessizce gömülür (bu proje geçmişinde 3 kez rebuild maliyetine yol açan bilinen tuzak; bir `check` script'i veya docs uyarısı düşük maliyetli önlem).
- `api/ws.py:162` yorumu ("inert at M1") H-NEW-1'in kök nedeni — ya replay uygulanmalı ya yorum + UI dürüstlüğü.

## Doğrulanmış sorunsuzlar
- `proto/decode.ts` ↔ `wire.py`: envelope/payload sınırları her adımda doğrulanıyor; golden vector'lar dil-ötesi sözleşmeyi kilitliyor; i64 ns için lossless-JSON taban kontrolü modül yüklenirken yüksek sesle düşüyor.
- `state/store.ts`: oturum-kapsamlı reset eksiksiz (normSeed gerekçesiyle belgelenmiş); yüksek frekans React dışında.
- `state/bookStore.ts`: 10 Hz throttle, bounded trade ring, partial-kolon ayrımı doğru; lazy stream aboneliği.
- `net/history.ts`: tek-in-flight, tükenme mandalı, geçici hatada retry, ring-güvenli sayfalama — dikkatli.
- `input/gestures.ts`: pointercancel dahil tam listener temizliği, pointer capture, eşiğin altı delta tamponlama.
- `gl`: `webglcontextlost/restored` + `WEBGL_lose_context` test hook'u, `deleteTexture/deleteProgram` teardown, `highp` shader'lar, tile+mip mimarisi (derin satır-satır okuma sonraki oturuma).
- `api/app.py`: CORS GET-only + kısıtlı origin listesi; REST handler'ları ağsız; tüm ağ `MarketDataCache` per-key lock + TTL arkasında; API anahtarları loglara/URL'lere sızmıyor (yalnız provider factory'e geçiyor).
