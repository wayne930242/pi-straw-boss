---
title: 程序衛生
description: 工作者的 shell 啟動的東西，會在工作者結束時被停掉，worktree 也不會在有程序執行時被移除。
---

每個 pi 都會載入一個小擴充套件來標記它的環境，所以工作者的 bash 啟動的東西都帶著工作者的 id，即使 `timeout` 或 `setsid` 把它移到了自己的 process group 也一樣。

- **殘留的會被停掉。** pi-herdr-agents 的工作者會向 sb server 登記。工作者退出或它的 pane 關閉時，server 會停掉它留下的東西（SIGTERM，10 秒後 SIGKILL，每一步都用 pid 與啟動時間檢查），並記錄一行 `procs-reaped`。
- **有程序在跑時不移除 worktree。** 只要有程序在該 checkout 裡工作，`worktree_remove` 與 bash 的 `git worktree remove` 就會被拒絕。拒絕訊息會列出每個持有者的 pid、程式、CPU 與存活時間，以及停掉它們的指令：`node dist/server/cli.mjs procs reap --checkout <path>`。
- **`cli.mjs procs`** 列出 server 知道的工作者。

## 停滯監看

pi session 有可能卡死：程序占滿一個核心、不收按鍵、從網裡消失，pane 看起來卻還活著。
sb server 每分鐘檢查每個 pane 裡的 pi，看起來卡死時就告訴該工作區的塔台。
它絕不停掉那個 session，也不對它送任何按鍵。

三個訊號，任何一個成立就通報：

- **滿載。** 程序連續 5 分鐘平均占用一個核心的 75% 以上，其中沒有任何一分鐘平靜下來，同時 session 檔沒有寫入。短暫的尖峰、還在寫入的 session 都不通報。
- **失聯。** 程序還活著，但 pi-intercom 已經 3 分鐘沒有列出這個 session。server 重啟後沒有回來的 session 也會被這個訊號抓到。
- **沉默。** pane 顯示工作中，session 檔 30 分鐘沒有寫入，也沒有進行中的工具呼叫。長時間的指令、建置或 subagent 都是進行中的呼叫，所以不會通報。

每個事件塔台只收到一則訊息，裡面有 pane、session、pid、CPU 分鐘數，以及處理步驟：先讀 pane，畫面不動才送 Esc，有交接檔或 boss 同意才停掉程序。
有新的訊號成立、session 恢復，或過了一小時還沒解決時，塔台會再收到一次。

門檻是 [`config.json`](/pi-straw-boss/docs/zh-tw/reference/configuration/#configjson) 裡的 `stallWatch`。

重型指令的 slot、Linux cgroup，以及會停掉失控工作者程序的看門狗，計畫在之後的版本推出。
規則與限制見[程序衛生與 slot](/pi-straw-boss/docs/zh-tw/reference/how-it-works/process-hygiene-and-slots/)。
