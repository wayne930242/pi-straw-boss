---
title: 程序衛生
description: 工作者的 shell 啟動的東西，會在工作者結束時被停掉，worktree 也不會在有程序執行時被移除。
---

每個 pi 都會載入一個小擴充套件來標記它的環境，所以工作者的 bash 啟動的東西都帶著工作者的 id，即使 `timeout` 或 `setsid` 把它移到了自己的 process group 也一樣。

- **殘留的會被停掉。** pi-herdr-agents 的工作者會向 sb server 登記。工作者退出或它的 pane 關閉時，server 會停掉它留下的東西（SIGTERM，10 秒後 SIGKILL，每一步都用 pid 與啟動時間檢查），並記錄一行 `procs-reaped`。
- **有程序在跑時不移除 worktree。** 只要有程序在該 checkout 裡工作，`worktree_remove` 與 bash 的 `git worktree remove` 就會被拒絕。拒絕訊息會列出每個持有者的 pid、程式、CPU 與存活時間，以及停掉它們的指令：`node dist/server/cli.mjs procs reap --checkout <path>`。
- **`cli.mjs procs`** 列出 server 知道的工作者。

重型指令的 slot、Linux cgroup 與失控程序的防護，計畫在之後的版本推出。
規則與限制見[程序衛生與 slot](/pi-straw-boss/docs/zh-tw/reference/how-it-works/process-hygiene-and-slots/)。
