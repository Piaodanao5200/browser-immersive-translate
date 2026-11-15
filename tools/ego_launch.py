import subprocess, time, os, sys
EGO = r"C:/Program Files/Citro Labs/ego lite/Application/ego.exe"
EXT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 先关闭
subprocess.run(['taskkill','/IM','ego.exe'], capture_output=True)
time.sleep(6)
DETACHED = 0x00000008
NEWGRP   = 0x00000200
p = subprocess.Popen([EGO, f'--load-extension={EXT}', '--restore-last-session'],
                     creationflags=DETACHED|NEWGRP, close_fds=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print('已启动 PID', p.pid)
time.sleep(9)
