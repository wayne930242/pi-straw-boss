---
title: Straw Link
description: "跨電腦的塔台：由隊友的電腦組成團隊，透過 relay 端對端加密。"
---

Straw Link 把做同一個專案的隊友電腦上的塔台連起來。
塔台可以寫給隊友電腦上的塔台（附 `device` 的 `tower_send`）、讀隊友的工作看板，並在頁面上看到他們的基地與自己的並排。
訊息經過 relay（[straw-relay](https://github.com/wayne930242/straw-relay)），由發送的裝置簽章，並用團隊的金鑰加密。

在每台電腦上，由 sb server 持有連線，所以不需要讓任何 pi session 一直開著。

## 團隊

1. **設定。** 在頁面上，設定 → 團隊 → **設定 Straw Link**，或在 pi 裡用 `/boss link on`。
2. **建立團隊**，對應一個專案資料夾，需要 relay 的 origin 與它的一次性團隊 token：設定 → 團隊 → 建立，或 `/boss link create <relay> <dir>`。
3. **邀請**隊友：頁面以 QR code 與文字顯示邀請，10 分鐘內有效；在 pi 裡用 `/boss link invite <team>`，文字顯示在私密畫面上。
4. **加入**，在隊友的電腦上：貼上邀請（或 `/boss link join @file`）並選專案資料夾。頁面會顯示四個安全字；邀請者要從一堆誘餌中挑出相符的那一組，才算核准加入。

管理員可以移除裝置、變更角色與輪替團隊金鑰；任何人都可以離開團隊。它們都在同一個「設定 → 團隊」頁面上；在 pi 裡輸入時，每個都會先在這台電腦上詢問：

| 動作 | 在 pi 裡 |
| --- | --- |
| 變更裝置的信任等級 | `/boss link trust <device> <level>` |
| 變更角色 | `/boss link role <team> <device> admin\|member` |
| 移除裝置 | `/boss link remove <team> <device>` |
| 輪替團隊金鑰 | `/boss link rotate <team>` |

## 信任

每台電腦依裝置決定要信任隊友的訊息到什麼程度（[設定](/pi-straw-boss/docs/zh-tw/reference/configuration/)裡的 `link.trust`，或頁面上的名單）：

| 等級 | 隊友的訊息在這裡啟動的 turn 可以做什麼 |
| --- | --- |
| `reply`（預設） | 讀專案已追蹤的檔案、在專案內搜尋、讀塔台清單與工作看板，並回覆發送者。任何其他工具呼叫都會在這台電腦上開一個 confirm，在終端機或頁面上。 |
| `forward` | 同上，而且發送者的電腦也可以回答那個 confirm。 |
| `dispatch` | 什麼都不攔：塔台用它完整的工具處理請求。 |

在 `reply` 與 `forward`，指名憑證路徑（`~/.ssh`、`~/.aws`、`.env*`、金鑰）的呼叫會直接拒絕，不會要求確認。
`link_request` 在每個等級都被封鎖。

隊友的訊息絕不是老闆的指示：之後的本機 turn 會看到它被標示為同儕的請求。
`link_request`（create、invite、join、trust 等等）是智慧體對其中某個動作的請求；它絕不會未經詢問就執行，老闆要在對話框裡核准。

## 無人值守裝置

**無人值守裝置**是沒有人坐在前面的電腦（建置機、伺服器），透過 Straw Link 從隊友的電腦接工作。
它執行持有連線的 sb server，沒有開機時啟動的 pi session，由控制端從頁面邀請它。
在好幾位開發者共用的盒子上，單位的問題與通知只會送給派它出去的控制端與團隊的管理員。

控制端也可以**操作**盒子：盒子的塔台、主智慧體與工作者會以基地的形式顯示在控制端的頁面上，附它們的即時終端機，可以打字、按 Escape、停掉主智慧體，範圍以盒子自己的政策為限。

盒子的卡片用本機頁面的字詞，稱呼它的每個主智慧體的種類與它的塔台的 run（見[概念](/pi-straw-boss/docs/zh-tw/guide/concepts/#種類)）；已結束的塔台 run 收在一個預設收合的「塔的執行」裡。

見[設定無人值守裝置](/pi-straw-boss/docs/zh-tw/guide/unattended-device/)。

## 在 pi 裡

`/boss link` 列出這台電腦的團隊、成員與等待中的加入請求；其他 `/boss link` 行則回答 confirm 與轉送來的問題、建立、顯示並取消邀請、執行上述管理動作，以及停掉盒子上的單位。
見[指令](/pi-straw-boss/docs/zh-tw/reference/commands/#straw-link)。

規則見 [Straw Link](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/#straw-link跨電腦的塔台連線持有者) 與 [Straw Link operate](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/#straw-link-operate有人看管的電腦操作無人值守的盒子)。
