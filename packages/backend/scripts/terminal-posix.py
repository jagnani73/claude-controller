"""Linux PTY supervisor: session leader + subreaper + pidfd-owned cleanup.

No stale PID signals. A private FIFO held by the PTY host triggers cleanup on
EOF, even when that host crashes. Requires Python 3.9+ and Linux pidfds.
"""
import ctypes
import os
import select
import signal
import sys
import time

fifo, shell, *args = sys.argv[1:]
probe = os.pidfd_open(os.getpid())  # fail BEFORE user code on unsupported hosts
os.close(probe)
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError("Cannot own terminal descendants")
for sig in (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU):
    signal.signal(sig, signal.SIG_IGN)
fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)

def stat_of(pid):
    with open(f"/proc/{pid}/stat", encoding="utf8") as file:
        return file.read().rsplit(")", 1)[1].split()

def cleanup():
    # Walk ONLY children of living, stopped owned parents. The root is us.
    # Descendants orphaned before the walk are adopted here by subreaping.
    # Acquire a pidfd BEFORE checking ppid, then signal that stable handle.
    handles = {}
    while True:
        added = 0
        for parent in [os.getpid(), *handles]:
            if parent in handles and select.select([handles[parent]], [], [], 0)[0]:
                continue  # exited parent: never enumerate a reused pid
            try:
                tasks = os.listdir(f"/proc/{parent}/task")
                children = set()
                for task in tasks:
                    with open(f"/proc/{parent}/task/{task}/children", encoding="utf8") as file:
                        children.update(map(int, file.read().split()))
                for pid in children - handles.keys():
                    handle = None
                    try:
                        handle = os.pidfd_open(pid)
                        if int(stat_of(pid)[1]) != parent:
                            os.close(handle)
                            continue
                        signal.pidfd_send_signal(handle, signal.SIGSTOP)
                        handles[pid] = handle
                        added += 1
                        # Parent must be stopped before we inspect its children.
                        while not select.select([handle], [], [], 0)[0]:
                            if stat_of(pid)[0] in ("T", "t", "Z"):
                                break
                            time.sleep(0.001)
                    except (ProcessLookupError, FileNotFoundError):
                        if handle is not None and pid not in handles:
                            os.close(handle)
            except (ProcessLookupError, FileNotFoundError):
                pass
        if not added:
            break
    for handle in handles.values():
        try:
            signal.pidfd_send_signal(handle, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(handle)
    os.close(fd)

for sig in (signal.SIGHUP, signal.SIGTERM):
    signal.signal(sig, lambda *_: (cleanup(), os._exit(0)))
pid = os.fork()
if pid == 0:
    os.close(fd)
    os.setpgid(0, 0)
    for sig in (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU, signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, signal.SIG_DFL)
    os.execv(shell, [shell, *args])
try:
    os.setpgid(pid, pid)
except (ProcessLookupError, PermissionError):
    pass
os.tcsetpgrp(0, pid)
status = 0
while True:
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        break
    readable, _, _ = select.select([fd], [], [], 0.1)
    if readable and not os.read(fd, 1024):
        break
cleanup()
os._exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 1)
