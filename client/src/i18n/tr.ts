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

  // --- SettingsDrawer ---
  'drawer.title': 'Ayarlar',
  'drawer.close': 'ayarları kapat',
  'settings.colormap': 'Renk haritası',
  'settings.contrast': 'Kontrast',
  'settings.tolerance': 'Tolerans',
  'settings.normalization': 'Normalleştirme',
  'settings.tickGrouping': 'Tick gruplama',
  'settings.bubbleThreshold': 'Baloncuk boyut eşiği',
  'settings.bigTrade': 'Büyük işlem boyutu (USD, 0 = kapalı)',
  'settings.priceRange': 'Fiyat aralığı',
  'settings.historyDepth': 'Açılışta geçmiş',
  'settings.overlays': 'Katmanlar',
  'settings.follow': 'Takip',
  'settings.theme': 'Tema',
  'settings.language': 'Dil',

  // --- banners (reconnect / closed) ---
  'banner.reconnecting': 'Yeniden bağlanıyor…',
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
