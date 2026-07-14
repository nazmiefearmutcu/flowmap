# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['run_flowmap.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'PyQt6',
        'PyQt6.QtCore',
        'PyQt6.QtGui',
        'PyQt6.QtWidgets',
        'PyQt6.QtOpenGLWidgets',
        'numpy',
        'sortedcontainers',
        'duckdb',
        'flowmap',
        'flowmap.main',
        'flowmap.ui.main_window',
        'flowmap.ui.heatmap_widget',
        'flowmap.data.crypcodile_live',
        'flowmap.data.crypcodile_replay',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='FlowMap',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # keep console so start-up errors are visible (FIND-P248-01)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='FlowMap',
)
app = BUNDLE(
    coll,
    name='FlowMap.app',
    icon=None,
    bundle_identifier='com.flowmap.app',
    info_plist={
        'CFBundleShortVersionString': '0.1.0',
        'CFBundleVersion': '0.1.0',
        'NSHighResolutionCapable': True,
    },
)
