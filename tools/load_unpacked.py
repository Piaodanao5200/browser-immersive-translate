import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32 = ctypes.windll.user32

def gtext(h):
    n=u32.GetWindowTextLengthW(h); b=ctypes.create_unicode_buffer(n+1)
    u32.GetWindowTextW(h,b,n+1); return b.value

def find(pred):
    out=[]
    P=ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h,l):
        t=gtext(h)
        if t and pred(t): out.append((h,t))
        return True
    u32.EnumWindows(P(cb),0); return out

def click(x,y):
    u32.SetCursorPos(int(x),int(y)); time.sleep(0.25)
    u32.mouse_event(0x0002,0,0,0,0); time.sleep(0.08)
    u32.mouse_event(0x0004,0,0,0,0); time.sleep(0.35)

ws=find(lambda t:'Edge' in t and 'DevTools' not in t)
if not ws: print('无 Edge'); sys.exit(1)
hwnd,title=ws[0]
u32.ShowWindow(hwnd,3); u32.SetForegroundWindow(hwnd); time.sleep(0.9)
print('Edge:',title[:60])

# "加载解压缩的扩展" 按钮
click(655,161)
time.sleep(2.0)
ImageGrab.grab().save('test/shot-filedialog.png')
dlg=find(lambda t:('选择' in t or '文件夹' in t or '浏览' in t))
print('对话框窗口:', [(h,t[:50]) for h,t in dlg])
print('已截图')
