---
title: 安裝
description: 安裝 pi-straw-boss 與它需要的套件。
---

```bash
pi install npm:pi-straw-boss
```

這個擴充套件在 [Herdr](https://herdr.dev) 之外什麼都不做。
Herdr worktree 工作區裡的子智慧體與 session 不會加入網：由啟動它們的 session 代為發言。

## 需求

- **在 Herdr 0.9.4 或更新版本裡執行的 pi。**
- **Herdr 的 pi 整合**，即 `herdr integration install pi`。沒有它，Herdr 不會為 pane 裡的 pi session 命名，該 session 也就無法加入網。缺少這個整合時，每個 session 會在啟動 20 秒後警告一次。
- **[pi-intercom](https://www.npmjs.com/package/pi-intercom) 0.18.1 或更新版本。** 網的頻道與訊息、GUI 的對話框轉送，以及 sb server 的連線，都透過它進行。server 在啟動時檢查版本，並把過舊或缺少的 pi-intercom 寫進 `start-error.json` 與 `boss_server status`。
- **宣告了[合併火車契約](/pi-straw-boss/docs/zh-tw/guide/merge-train/#合併火車契約)的 skill**，只有[合併火車](/pi-straw-boss/docs/zh-tw/guide/merge-train/)需要。`integrating` 與 `deploying` skill 就是火車的程序，[pi-anchorloop](https://www.npmjs.com/package/pi-anchorloop) 2.11.0 或更新版本提供這兩個 skill。沒有它們，遇到車廂單的主智慧體或整合員會回報 `blocked` 並指名這份契約，且不會合併任何東西。

Windows 支援還在實驗階段。
有哪些不同，見 [Windows](/pi-straw-boss/docs/zh-tw/reference/how-it-works/windows/)。

## 搭配使用

以下每一項都是選用的。
裝了其中一項，Straw Boss 就會用上它；沒裝，其餘功能照舊運作。

| 套件 | Straw Boss 怎麼用它 |
| --- | --- |
| [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) | 子智慧體顯示在啟動它們的 session 底下，包括塔台儀表板、側邊欄與 GUI。派出子智慧體的成員會升任主智慧體，並開出它的塔台。 |
| [@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) 2.13 或更新版本 | `ask_user_question` 的問卷可以從 GUI 回答或取消，等待中的問卷會把它的單位標示為等待中。 |
| [pi-robot-hand](https://www.npmjs.com/package/pi-robot-hand) 0.3.0 或更新版本 | `robot_hand` 的選擇器可以從 GUI 回答。 |
| pi-code（hooks 擴充套件，含它的對話框事件） | 它的 hook 確認（「Allow bash?」）可以從 GUI 回答。 |
| [pi-herdr-doc-review](https://www.npmjs.com/package/pi-herdr-doc-review) 0.4.0 或更新版本 | session 展示的文件會開在它的通訊畫面旁：HTML 在沙箱 frame 裡，其表單的答案會送回智慧體，文字則為唯讀。 |
| [@juicesharp/rpiv-todo](https://www.npmjs.com/package/@juicesharp/rpiv-todo) 2.13 或更新版本 | session 的 todo 清單顯示在 GUI 的輸入框上方，內容讀自 session 檔。 |

任何擴充套件的 `select` 與 `confirm` 也都可以從 GUI 回答，不必改動那個擴充套件。
不論在 pi 或在 GUI 裡，先回答的算數。
`input`、`editor` 與 `custom` 對話框完全不碰：它們在 GUI 裡以唯讀顯示，點一下就能切到終端機。

## 選用的 Herdr 外掛

儲存庫附了兩個 Herdr 外掛：一個是 Herdr 側邊欄用的網檢視，一個是清理智慧體留在 worktree 工作區裡的 pane 與 checkout 的 reaper（清理外掛）。
見 [Herdr 外掛](/pi-straw-boss/docs/zh-tw/guide/herdr-plugins/)。
