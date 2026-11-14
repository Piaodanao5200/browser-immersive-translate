import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32=ctypes.windll.user32
KEYUP=0x0002; UNICODE=0x0004
VK_CTRL,VK_A,VK_L,VK_RETURN,VK_MENU = 0x11,0x41,0x4C,0x0D,0x12

def gtext(h):
    n=u32.GetWindowTextLengthW(h); b=ctypes.create_unicode_buffer(n+1)
    u32.GetWindowTextW(h,b,n+1); return b.value
def find(pred):
    out=[]
    P=ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h,l):
        t=gtext(h)
        if t and pred(t) and u32.IsWindowVisible(h): out.append((h,t))
        return True
    u32.EnumWindows(P(cb),0); return out
def click(x,y):
    u32.SetCursorPos(int(x),int(y)); time.sleep(0.25)
    u32.mouse_event(0x0002,0,0,0,0); time.sleep(0.09)
    u32.mouse_event(0x0004,0,0,0,0); time.sleep(0.45)
def type_text(s):
    for ch in s:
        c=ord(ch)
        u32.keybd_event(0,c,UNICODE,0); u32.keybd_event(0,c,UNICODE|KEYUP,0)
        time.sleep(0.015)
def combo(mod,vk):
    u32.keybd_event(mod,0,0,0); time.sleep(0.04)
    u32.keybd_event(vk,0,0,0); u32.keybd_event(vk,0,KEYUP,0)
    u32.keybd_event(mod,0,KEYUP,0); time.sleep(0.25)
def tap(vk):
    u32.keybd_event(vk,0,0,0); u32.keybd_event(vk,0,KEYUP,0); time.sleep(0.06)

e=find(lambda t:'Edge' in t and 'DevTools' not in t)[0]
u32.ShowWindow(e[0],3); u32.SetForegroundWindow(e[0]); time.sleep(0.9)

combo(VK_CTRL, VK_L)
type_text('edge://extensions')
time.sleep(0.3); tap(VK_RETURN); time.sleep(3.0)

print('点击"加载解压缩的扩展"')
click(1393,350)
time.sleep(2.0)
dlg=find(lambda t:'选择扩展目录' in t)
if not dlg:
    print('对话框未出现'); ImageGrab.grab().save('test/ascii-fail1.png'); sys.exit(1)
u32.SetForegroundWindow(dlg[0][0]); time.sleep(0.6)
combo(VK_CTRL, VK_A)
combo(VK_CTRL, 0x56)  # Ctrl+V 以防 Ctrl+A 后残留
combo(VK_CTRL, VK_A)
type_text('D://st-test')
time.sleep(0.4)
tap(VK_RETURN); time.sleep(1.8)
ImageGrab.grab().save('test/ascii-dlg.png')
print('已输入路径并回车')
