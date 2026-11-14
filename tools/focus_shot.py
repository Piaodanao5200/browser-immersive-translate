import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab

u32 = ctypes.windll.user32
EnumWindows = u32.EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

def text(h):
    n = u32.GetWindowTextLengthW(h)
    b = ctypes.create_unicode_buffer(n + 1)
    u32.GetWindowTextW(h, b, n + 1)
    return b.value

targets = []
def cb(h, l):
    t = text(h)
    if t and ('Edge' in t or 'ego' in t.lower()):
        targets.append((h, t))
    return True

EnumWindows(EnumWindowsProc(cb), 0)
for h, t in targets:
    print('HWND', h, '|', t[:90])

if not targets:
    print('未找到浏览器窗口'); sys.exit(1)

hwnd, title = targets[0]
SW_RESTORE = 9
u32.ShowWindow(hwnd, SW_RESTORE)
u32.SetForegroundWindow(hwnd)
u32.BringWindowToTop(hwnd)
time.sleep(1.3)
ImageGrab.grab().save('test/shot-edge.png')
print('已激活并截图:', title[:60])
