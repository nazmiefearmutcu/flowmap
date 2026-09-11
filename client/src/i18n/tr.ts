/**
 * Turkish string table (lane CE, C7). May omit keys — lookup falls back to
 * English (contract C7: a missing locale entry NEVER renders the raw key).
 * Feature panes stay English; these are shell strings only.
 */
export const tr: Record<string, string> = {
  // --- TopBar ---
  'topbar.searchPlaceholder': 'Sembol ara',
  'topbar.live': 'Canlı',
  'topbar.replay': 'Tekrar oynat',
  'topbar.liveOrReplay': 'canlı veya tekrar',
  'topbar.noCaps': 'YETKİ YOK',
  'topbar.settings': 'ayarlar',
  'topbar.exportPng': 'PNG dışa aktar',
  'topbar.exportPngHint': 'grafiği PNG olarak indir (E)',
  'topbar.toggleRail': 'DOM merdiveni / kaset panelini aç-kapat',
  'topbar.dismissNotice': 'dışa aktarım bildirimini kapat',
  'topbar.png': 'PNG',
  'topbar.rail': 'Şerit',
  'topbar.settingsLabel': 'Ayarlar',
  'topbar.replayUnavailable': 'Kayıt yok — tekrar oynatma kullanılamıyor',
  'topbar.replayUnavailableHint':
    'Bu oturumda kayıt yok; sunucu Tekrar oynat isteğini reddetti (kapatma 1003). Grafik CANLI akışa yeniden abone oldu; kayıt oluşturmak için sembol değiştir, sonra Tekrar oynat’ı yeniden dene.',

  // --- SettingsDrawer ---
  'drawer.title': 'Ayarlar',
  'drawer.close': 'ayarları kapat',
  'drawer.sectionAppearance': 'Görünüm',
  'drawer.sectionDisplay': 'Ekran',
  'drawer.sectionTrades': 'İşlemler',
  'drawer.sectionView': 'Bakış',
  'drawer.sectionAlerts': 'Alarmlar',
  'drawer.sectionKeyboard': 'Klavye',
  'settings.colormap': 'Renk haritası',
  'settings.colormapHint':
    'Flow alanı koyu tutar, duvarlar sıcak altın tonunu kazanır; Inferno büyüklüğü renk tonuyla ayırır (çivit → kırmızı → altın); Classic eski mavi→camgöbeği→sarı rampasıdır. Sentetik derinlik her zaman amber kalır.',
  'settings.contrast': 'Kontrast',
  'settings.contrastHint':
    'Orta yoğunluk alanını en parlak duvarlara göre yükseltir — yükseldikçe daha vurucu olur.',
  'settings.tolerance': 'Tolerans',
  'settings.toleranceHint':
    'Siyah noktası: görünümün yoğunluk yüzdelik diliminin bu payının altındaki hücreleri gizler; böylece yalnızca okunmaya değer likidite boyanır. Sabit bir lot büyüklüğüne değil, ekranda olana görecelidir.',
  'settings.normalization': 'Normalleştirme',
  'settings.normalizationHint':
    'Beyaz noktası: tam parlaklığa eşlenen yoğunluk yüzdelik dilimi. Düşük değer (p80) alanı vurucu ve doygun yapar; yüksek değer (p100) daha soluk ama daha fazla pay bırakır.',
  'settings.tickGrouping': 'Tick gruplama',
  'settings.rowsPerCell': '{n} satır / hücre',
  'settings.rowsPerCellOne': '1 satır / hücre',
  'settings.bubble': 'Baloncuk eşiği',
  'settings.bubbleThreshold': 'Baloncuk boyut eşiği',
  'settings.allTrades': 'tüm işlemler',
  'settings.off': 'kapalı',
  'settings.bigTrade': 'Büyük işlem boyutu (USD, 0 = kapalı)',
  'settings.bigTradeLabel': 'Büyük işlem boyutu',
  'settings.bigTradeHint':
    'Kaset satırlarını bu nominalin (fiyat × miktar, USD) üzerinde vurgular. 0 vurguyu kapatır.',
  'settings.depthChannel': 'Derinlik kanalı',
  'settings.channel.sum': 'Toplam',
  'settings.channel.bid': 'Alış',
  'settings.channel.ask': 'Satış',
  'settings.channel.imbalance': 'Dengesizlik',
  'settings.channelHint.sum': 'Alış + satış yoğunluğu tek görünümde — varsayılan gösterim.',
  'settings.channelHint.bid': 'Yalnızca bekleyen ALIŞ miktarı — birikimi ve destek duvarlarını oku.',
  'settings.channelHint.ask': 'Yalnızca bekleyen SATIŞ miktarı — arzı ve direnç duvarlarını oku.',
  'settings.channelHint.imbalance':
    'Hücre başına işaretli (alış−satış)/(alış+satış): rampanın bir ucu alış ağırlıklı, diğeri satış ağırlıklı; tek taraflı duvarlar hemen öne çıkar. C ile döner.',
  'settings.hud': 'Performans HUD (H)',
  'settings.drawToolbar': 'Çizim araç çubuğu (D)',
  'settings.indicatorPicker': 'Gösterge seçici (I)',
  'settings.showOnboarding': 'Tanıtım turunu göster',
  'settings.follow': 'Takip',
  'settings.followLive': 'Canlı kenarı takip et (zaman)',
  'settings.followPrice': 'Fiyatı izle (yakınlaştırmanı korur)',
  'settings.rightRail': 'Sağ şerit (DOM + kaset)',
  'settings.priceRange': 'Fiyat aralığı',
  'settings.band.native': 'Standart',
  'settings.band.wide': '±50%',
  'settings.band.full': '−100/+1000%',
  'settings.band.deep': 'Derin',
  'settings.bandHint.native': 'En ince fiyat satırları, en dar kapsam — alım-satım varsayılanı.',
  'settings.bandHint.wide':
    'Yaklaşık 50 kat daha kaba satırlar; uzaktaki bekleyen büyüklük görünür olur.',
  'settings.bandHint.full':
    'Yalnızca aralık TARAMASI: satırlar öyle kabalaşır ki canlı defter birkaç satıra iner.',
  'settings.bandHint.deep':
    'Fiyatın yanında tam merdiven çözünürlüğü VE −99%/+1000% kapsama. Çerçeve oturum boyunca sabit kalır; kalıcı bir hareket, yeniden bağlanana kadar defteri kaba kanatlara taşır.',
  'settings.historyDepth': 'Açılışta geçmiş',
  'settings.history.off': 'Kapalı',
  'settings.history.1h': '1S',
  'settings.history.4h': '4S',
  'settings.history.1d': '1G',
  'settings.history.max': 'Maks',
  'settings.historyHint':
    'Bir sembol yüklendiğinde grafiğe ne kadar geçmiş verinin çekileceği. Sonraki sembol geçişinde veya yeniden yüklemede uygulanır. Sunucunun sakladığı veriyle sınırlıdır.',
  'settings.restoreDefaults': 'Varsayılanlara dön',
  'settings.alertSound': 'Alarm sesi',
  'settings.alertSoundHint': 'Bir fiyat alarmı tetiklendiğinde kısa bir ses çalar.',
  'settings.overlays': 'Katmanlar',
  'settings.theme': 'Tema',
  'settings.language': 'Dil',

  // --- banners (reconnect / closed) ---
  'banner.reconnecting': 'Yeniden bağlanıyor…',
  'banner.lostReconnecting': 'bağlantı koptu — {target} için yeniden bağlanılıyor · {reason}',
  'banner.theFeed': 'akış',
  'banner.attempt': 'deneme {attempts}',
  'banner.retryNow': 'Yeniden dene',
  'banner.retryNowHint': 'beklemeden hemen yeniden bağlan',
  'banner.reasonDropped': 'bağlantı koptu',
  'banner.reasonShutdown': 'sunucu kapatıldı',
  'banner.reasonSession': 'sunucu oturumu kapattı',
  'banner.reasonOverloaded': 'sunucu aşırı yüklü',
  'banner.reasonCode': 'sunucu kapattı (kod {code})',
  'banner.closed': 'PİYASA KAPALI',
  'banner.opensIn': '{time} sonra açılır',
  'banner.noFeed': 'AKIŞ YOK',
  'banner.noFeedDetail': 'bu piyasa için akış yok',

  // --- ShortcutsOverlay ---
  'shortcuts.title': 'Klavye kısayolları',
  'shortcuts.close': 'kısayolları kapat',
  'shortcuts.footerToggle': 'aç-kapat',
  'shortcuts.footerClose': 'kapat',

  // --- keysheet (shared by ShortcutsOverlay + SettingsDrawer) ---
  'keysheet.space': 'canlı kenarı takip et · tekrar oynatmada oynat/duraklat',
  'keysheet.slash': '⌘K / Ctrl-K — sembol arama',
  'keysheet.export': 'grafiği PNG olarak indir',
  'keysheet.measure': 'ölçüm aracı — grafikte sürükleyerek Δfiyat / Δzaman / Δderinlik',
  'keysheet.alert': 'crosshair fiyatına fiyat alarmı (liste: grafikteki zil düğmesi)',
  'keysheet.hud': 'performans HUD — fps / kare ms / yükleme / çizim / önbellek',
  'keysheet.channel': 'derinlik kanalını değiştir: toplam → alış → satış → dengesizlik',
  'keysheet.theme':
    'renk temasını değiştir: midnight → paper → swiss → amber → sea → paper-deut → contrast',
  'keysheet.draw': 'çizim araç çubuğunu aç-kapat (trend çizgisi · yatay çizgi · ışın · dikdörtgen · fib · metin)',
  'keysheet.indicator': 'gösterge seçiciyi aç-kapat',
  'keysheet.delete': 'seçili çizimi sil',
  'keysheet.undo': 'çizimleri geri al · Ctrl+Shift+Z / Ctrl+Y yinele',
  'keysheet.help': 'bu kısayol penceresini aç-kapat',
  'keysheet.pan': 'zaman / fiyat kaydır (grafik odaklıyken)',
  'keysheet.zoom': 'zamanı yakınlaştır (grafik odaklıyken)',
  'keysheet.follow': 'zaman takibini aç-kapat (grafik odaklıyken)',
  'keysheet.priceTrack': 'fiyat takibi aç-kapat · Shift+P yeniden sığdır',
  'keysheet.liveEdge': 'canlı kenara dön',
  'keysheet.escape':
    'pencereleri kapat (arama · ayarlar · bu pencere) · ölçüm sürüklemesini iptal et · çizimi iptal et / seçimi bırak',
  'keysheet.axis': 'fiyat yakınlaştırma / ölçekleme · çift tıkla yeniden sığdır',

  // --- OnboardingCard ---
  'onboarding.title': 'FlowMap’e hoş geldiniz',
  'onboarding.step.connect.title': 'Bir piyasa bağla',
  'onboarding.step.connect.body':
    'Üst çubuktan bir sembol ara ve Canlı ya da Tekrar oynat seç — o piyasanın derinlik ısı haritası akmaya başlar.',
  'onboarding.step.mouse.title': 'Fare ve tuşlar',
  'onboarding.step.mouse.body':
    'Sürükleme haritayı kaydırır, tekerlek zamanı yakınlaştırır. Ok tuşları görünümü ödünler; + / − fiyatı yakınlaştırır; F canlı kenarı takip eder.',
  'onboarding.step.shortcuts.title': 'Tüm kısayollar',
  'onboarding.step.shortcuts.body':
    'Tam kısayol listesi için istediğin an ? tuşuna bas; renk temaları için T tuşuna bas.',
  'onboarding.next': 'İleri',
  'onboarding.done': 'Tamam',
  'onboarding.skip': 'Atla',
  'onboarding.stepOf': 'Adım {current}/{total}',
  'onboarding.hint': 'Esc gizler; bir sonraki ziyaretinde yine gösterilir.',

  // --- Toaster ---
  'toast.dismiss': 'Bildirimi kapat',
};
