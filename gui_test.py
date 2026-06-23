#!/usr/bin/env python3
"""Auto-start simulation and capture actual widget screenshot."""
import sys, time, numpy as np
from PyQt6.QtWidgets import QApplication
from PyQt6.QtCore import QTimer
from flowmap.ui.main_window import MainWindow
from flowmap.ui.source_manager import DataSource

app = QApplication(sys.argv)
window = MainWindow()
window.resize(1400, 928)
window.move(100, 100)
window.show()
app.processEvents()

# Auto-start simulation after 500ms
def start_sim():
    if not window._source.running:
        window._source.toggle_simulation()
        print("Simulation started")
    else:
        print("Simulation already running")
    
    # Wait 20 seconds for data buildup, then capture
    def capture():
        print("Capturing screenshot...")
        pixmap = window.grab()
        pixmap.save("/Users/nazmi/flowmap/flowmap_gui_auto.png")
        print("Saved: /Users/nazmi/flowmap/flowmap_gui_auto.png")
        
        # Also capture just the heatmap widget
        hm_pixmap = window.heatmap.grab()
        hm_pixmap.save("/Users/nazmi/flowmap/flowmap_heatmap_widget.png")
        print(f"Heatmap widget: {hm_pixmap.width()}x{hm_pixmap.height()}")
        
        # Analyze
        from PyQt6.QtGui import QImage
        img = QImage("/Users/nazmi/flowmap/flowmap_gui_auto.png")
        w, h = img.width(), img.height()
        ptr = img.bits()
        ptr.setsize(w*h*4)
        arr = np.frombuffer(ptr, dtype=np.uint8).reshape(h, w, 4)
        
        # Heatmap widget position in window
        hm_pos = window.heatmap.mapTo(window, window.heatmap.rect().topLeft())
        hm_y = hm_pos.y()
        hm_h = window.heatmap.height()
        hm_x = hm_pos.x()
        hm_w = window.heatmap.width()
        print(f"Heatmap in window: x={hm_x} y={hm_y} w={hm_w} h={hm_h}")
        
        # Analyze heatmap area
        hm_arr = arr[hm_y:hm_y+hm_h, hm_x:hm_x+hm_w-70, :]  # -70 for price axis
        H, W = hm_arr.shape[:2]
        data = np.any(hm_arr[:,:,:3] > 8, axis=2)
        dark = (1 - np.sum(data)/(H*W)) * 100
        
        if np.sum(data) > 0:
            px = hm_arr[data]
            g = int(np.sum((px[:,1] > px[:,0]) & (px[:,1] > 50)))
            r = int(np.sum((px[:,0] > px[:,1]) & (px[:,0] > 50)))
            
            lines = 0; in_l = False
            for yb in range(H):
                c = int(np.sum(np.any(hm_arr[yb,:,:3] > 10, axis=1)))
                if c > 20 and not in_l: in_l = True; lines += 1
                elif c <= 5: in_l = False
            
            print(f"\n=== ACTUAL GUI HEATMAP ===")
            print(f"Dark: {dark:.1f}% | Lines: {lines} | Green: {g} | Red: {r}")
            
            # Color samples
            in_l = False; ln = 0
            for yb in range(H):
                row = hm_arr[yb,:,:3]
                c = int(np.sum(np.any(row > 10, axis=1)))
                if c > 20 and not in_l:
                    in_l = True; ln += 1
                    m = np.any(row > 10, axis=1); p = row[m]
                    avg = np.mean(p, axis=0)
                    dom = 'GREEN' if avg[1] > avg[0] and avg[1] > 50 else 'RED' if avg[0] > avg[1] and avg[0] > 50 else 'GRAY'
                    print(f"  L{ln}: y={yb:4d} {c:4d}px ({avg[0]:3.0f},{avg[1]:3.0f},{avg[2]:3.0f}) {dom}")
                    if ln >= 25: break
                elif c <= 5: in_l = False
            
            # Check for blue anomalies
            blue = int(np.sum((hm_arr[:,:,2] > hm_arr[:,:,0] + hm_arr[:,:,1]) & (hm_arr[:,:,2] > 30)))
            print(f"Blue anomalies (B>R+G): {blue}")
        
        app.quit()
    
    QTimer.singleShot(5000, capture)

QTimer.singleShot(500, start_sim)
app.exec()
