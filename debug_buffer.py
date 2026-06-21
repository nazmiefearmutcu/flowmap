#!/usr/bin/env python3
"""Debug: dump raw buffer pixels from GUI render."""
import sys, time, numpy as np
from PyQt6.QtWidgets import QApplication
from PyQt6.QtCore import QTimer
from flowmap.ui.main_window import MainWindow

app = QApplication(sys.argv)
window = MainWindow()
window.resize(1400, 928)
window.move(100, 100)
window.show()
app.processEvents()

def start_and_dump():
    window._source.toggle_simulation()
    print("Simulation started", flush=True)
    
    def dump():
        buf = window.heatmap._engine.get_buffer()
        bh, bw = buf.shape[:2]
        print(f"Buffer: {buf.shape}, dtype={buf.dtype}", flush=True)
        
        # Dump specific pixels
        for label, row in [("row_0(top_ask)", 0), ("row_54(ask)", 54), 
                           ("row_83(bid)", 83), ("row_146(bot_bid)", 146)]:
            if 0 <= row < bh:
                px = buf[row, -1, :]  # rightmost column
                print(f"  {label}: R={px[0]} G={px[1]} B={px[2]} A={px[3]}", flush=True)
        
        # Check ask vs bid rows
        print("\nAsk rows (0, 9, 18, ...):", flush=True)
        for i in range(min(8, 150//9)):
            row = i * 9
            if 0 <= row < bh:
                px = buf[row, -1, :]
                dom = "RED" if px[0] > px[1] else "GREEN" if px[1] > px[0] else "BLACK"
                print(f"  row={row}: ({px[0]},{px[1]},{px[2]},{px[3]}) {dom}", flush=True)
        
        # Start from bh - 1 instead of 146
        print(f"\nBid rows ({bh - 1}, {bh - 10}, ...):", flush=True)
        for i in range(min(8, 150//9)):
            row = (bh - 1) - i * 9
            if 0 <= row < bh:
                px = buf[row, -1, :]
                dom = "RED" if px[0] > px[1] else "GREEN" if px[1] > px[0] else "BLACK"
                print(f"  row={row}: ({px[0]},{px[1]},{px[2]},{px[3]}) {dom}", flush=True)
        
        print(f"\nBG_COLOR from engine: {window.heatmap._engine.get_buffer()[1,-1]}", flush=True)
        
        app.quit()
    
    QTimer.singleShot(15000, dump)

QTimer.singleShot(500, start_and_dump)
app.exec()

