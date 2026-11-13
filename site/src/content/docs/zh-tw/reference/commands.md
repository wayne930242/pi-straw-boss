---
title: 指令
description: pi-straw-boss 給智慧體的每個工具，以及每個 /boss 指令。
---

智慧體呼叫**工具**；你在 Herdr 裡任何 pi session 輸入 **`/boss` 指令**。
`/boss` 指令只屬於老闆親自輸入：塔台 run、隊友 run 或已配對裝置的輸入框都不能輸入，除非某一列另有說明。
`/boss` 與 `boss_promote` 在子工作區裡無法使用。

「誰有」欄指 session 的種類，定義見[概念](/pi-straw-boss/docs/zh-tw/guide/concepts/)：

- **已加入的 session**：每個加入分頁的網的 pi（成員與主智慧體）。
- **塔台**：塔台的 run；列上有寫時，也包括主塔台的。
- **本機塔台 run**：塔台在這台電腦上的 [run](/pi-straw-boss/docs/zh-tw/guide/concepts/#塔台怎麼運作)，不含隊友的「隊友 run」。

## 工具

| 工具 | 誰有 | 做什麼 |
| --- | --- | --- |
| `boss_promote` | 已加入的 session | 成為這個分頁的主智慧體；分頁已有存活的主智慧體時會被拒絕。 |
| `boss_status` | 已加入的 session 與塔台 | 每個分頁的主智慧體與它的種類、這個工作區的塔台、主塔台與其他塔台。 |
| `boss_duty` | 分頁的主智慧體 | 附理由設定它的種類：`coordinator`、`integrator` 或 `standing`。種類就是它執行的 prompt，並顯示在頁面上。 |
| `boss_rename` | 已加入的 session | 用一句短語為 session 命名它目前的工作；主智慧體的分頁以它為標籤。角色標籤（塔台的圖示、`train <MMDDx>`）會被拒絕。 |
| `call_tower` | 已加入的 session 與塔台 | 在標頭之下發訊息給這個工作區的塔台，或另一個工作區的塔台。`why` 是 `milestone`、`shared` 或 `blocked`；通知用 `reply: false`。 |
| `boss_broadcast` | 已加入的 session 與塔台 | 發訊息給一個分頁、一個工作區、所有塔台或所有 session，標頭會列出每位收件者。 |
| `board_set` | 分頁的主智慧體 | 覆寫它自己的工作看板項目（一行與最多 8 個清單項目）；`auto: true` 交還給自動填入，`clear: true` 刪除它。 |
| `boss_server` | 已加入的 session | sb server 的 `status`（server 沒在跑時也可用）、它的 `logs`（最多 200 行），或附理由 `restart`。老闆停掉 server 時會被拒絕，每分鐘最多一次，且在遠端 turn 中絕不可用。 |
| `link_request` | 有人看管的電腦上的每個 session，以及本機塔台 run | 附理由請求一個 Straw Link 動作（create、invite、join、trust、leave、remove、role、rotate）。它絕不會未經詢問就執行：老闆要在對話框裡核准。 |
| `boss_open_main` | 塔台 | 為沒有 session 負責的請求，開一個帶新主智慧體的分頁。`role: "train"` 開一列火車；`role: "integrator"` 把車廂單送給專案唯一的整合員，沒有在跑的就開一個。`duty: "standing"` 開一個值守種類的主智慧體（預設為協調者）。見[合併火車](/pi-straw-boss/docs/zh-tw/guide/merge-train/)。 |
| `boss_close_main` | 塔台 | 等它裡面沒有東西在跑，關掉這座塔台開的主智慧體。 |
| `tower_list` | 塔台 | 每個工作區的塔台、發給它的訊息會送到誰、它的狀態，以及它的分頁在做什麼（每個分頁的主智慧體及其種類）。 |
| `tower_send` | 塔台 | 發訊息給另一座塔台（用工作區 id 或標籤）或全部；附 `device` 則發給隊友電腦上的塔台。 |
| `board_read` | 塔台 | 工作看板：每位主智慧體在做什麼、做到哪裡，包括這裡與隊友的電腦。 |
| `tower_memory` | 本機塔台 run | 保存 run 結束後還要留著的內容：引用自老闆自己訊息的長期指示或決定，以及塔台的等待事項，包括對老闆的等待（以卡片呈現）。 |
| `tower_reply` | 塔台 run，不含主塔台的 | 用 intercom 名稱或 session id 回答一個本機 session（主智慧體或成員），掛在塔台的標頭之下。`forward` 把車廂單的事件 id 轉給整合員。 |
| `tower_done` | 塔台 run | 附一份交接筆記（一項一行，最多 1,200 字元）結束這次 run，留給下一次 run；`wakeAfter`（5 到 240 分鐘，僅限本機 run）要求稍後再跑一次。事件仍在等這次 run 時會被拒絕。 |
| `boss_auto` | 主塔台 | 依老闆自己的話，在它回答的那個 turn 裡開始或結束[自動模式](/pi-straw-boss/docs/zh-tw/guide/auto-mode/)。 |
| `train_car` | 整合員與火車 | 設定車廂的狀態（`received`、`returned`、`dropped`、`landed`）；sb server 會通知該車廂的協調者。它的 `car` 是車廂的第一張票；車廂單的 `car:`（或 `app:`）指名 app。 |

完整的表格與每個參數，見[工具](/pi-straw-boss/docs/zh-tw/reference/how-it-works/tools/)。

## 角色與狀態

| 指令 | 做什麼 |
| --- | --- |
| `/boss` | 接手成為這個分頁的主智慧體，即使它已經有一位。 |
| `/boss status` | 每個分頁的主智慧體與各座塔台。 |
| `/boss tower` | 這個工作區沒有塔台在跑就開一座，並聚焦它的分頁。 |
| `/boss tower <prompt>` | 寫給這個工作區的塔台。 |
| `/boss tower -w <workspace\|head> <子指令>` | 對另一個工作區的塔台操作，如同塔台的卡片與輸入框所做的。寫給另一座塔台會先詢問。 |
| `/boss tower … status`、`parked`、`leave`、`new` | 塔台的狀態、被擱置的事件、讓對話帶著交接筆記結束、開新對話。 |
| `/boss tower … retry`、`deliver <id>`、`drop <id>` | 重試、送出或丟棄一個被擱置的事件。 |
| `/boss tower … [--answers W3] <message>` | 寫一則訊息；`--answers W3` 標記某個對你的等待在塔台收下訊息後即算已回答。 |
| `/boss head [status\|leave\|new\|close\|<message>]` | 與[主塔台](/pi-straw-boss/docs/zh-tw/guide/head-tower/)對話。單獨的 `/boss head` 會建立它的工作區並聚焦它的分頁。 |
| `/boss head retry`、`parked`、`deliver <id>`、`drop <id>` | 主塔台的通知與被擱置的事件。 |
| `/boss head --answers W3 <message>` | 回答某個等待的訊息。 |

## 與 session 對話

| 指令 | 做什麼 |
| --- | --- |
| `/boss send <name\|key> [--after] <text>` | 以老闆的身分寫給網上任何 session，如同頁面的輸入框所做的。`--after` 讓它排到該 session 閒下來時。名稱有空格要加引號：`/boss send "fix login" hi`。 |
| `/boss stop <name\|key>` | 在 session 裡按 Esc，如同頁面的停止（會先在 pi 裡詢問）。 |
| `/boss answer` | 列出其他 session 正在等的對話框（select、confirm 或問卷，附編號的選項）。 |
| `/boss answer <name\|key> [<choice number \| text> \| --cancel]` | 回答其中一個，如同頁面所做的，經過同樣的 server 檢查。沒有輸入選項時，pi 會問。祕密絕不從這裡回答：請在那個 session 的終端機輸入。 |

## 記憶與自動模式

| 指令 | 做什麼 |
| --- | --- |
| `/boss memory [-w workspace]` | 讀塔台的記憶：長期指示、決定、等待事項，以及等你處理的提案。 |
| `/boss memory confirm P1`、`reject P1` | 確認或拒絕塔台的提案。 |
| `/boss memory add standing\|decision <text>`、`edit S1 <text>`、`delete D1`、`resolve W1` | 自己修改記憶。 |
| `/boss memory done\|choose\|decline W<n>` | 處理一個等待事項，例如被自動模式擱置的那種。 |
| `/boss wait [-w workspace \| label \| head]` | 列出等你處理的等待卡片，並按下其中一張：完成、選一個選項、略過、回覆塔台，或開始輸入機密。它送出頁面本身的 press。塔台的常駐 pane 用 `/wait` 做同樣的事。 |
| `/boss auto` | 顯示自動模式的狀態與上一份回來清單。 |
| `/boss auto on`、`/boss auto confirm`、`/boss auto off` | 請求自動模式並在終端機確認；確認主塔台擬好的請求；結束它並印出回來清單。 |

GUI 的記憶面板做的和 `/boss memory` 一樣。見[塔台記憶](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#塔台記憶)。

## 開啟、關閉與收起

| 指令 | 做什麼 |
| --- | --- |
| `/boss open base <dir> [label]` | 頁面的＋新基地：在 `<dir>` 開一個有一位成員的基地。 |
| `/boss open member [dir]` | 在這個 session 旁，或在 `<dir>` 裡自己的分頁，開一位成員。 |
| `/boss open main <dir> [prompt]` | 在這個基地的新分頁開一位主智慧體，以 prompt 作為它的第一則訊息。 |
| `/boss close` | 退出這個 session 並關閉它的 pane。 |
| `/boss close <name\|key>` | 確認後退出另一個單位、一個小隊或一個基地。在名稱前加 `unit:`、`squad:` 或 `base:`，可以限縮符合不只一個的名稱。 |
| `/boss close all [<workspace>]` | 退出一個基地的塔台、主智慧體與成員並關閉它，不收起。任何會因此遺失的執行中內容都會讓它什麼都不關，並列出每個原因。 |
| `/boss stash [name] [--workspace <label\|id>]` | 把這個基地（或確認後另一個基地）收起來並關閉。 |
| `/boss pop [name]` | 重新開啟已收起的基地，每個 pi 都從自己的 session 檔以原來的角色接續。 |
| `/boss dismiss [all\|<name>]` | 從網上隱藏已完成的子智慧體。 |

`<dir>` 相對於這個 session 的資料夾（`~` 是家目錄；有空格的路徑要加引號）；server 只接受家目錄底下的資料夾。

## sb server

| 指令 | 做什麼 |
| --- | --- |
| `/boss server` | 顯示 sb server，沒在跑就啟動它。 |
| `/boss server stop` | 確認後刻意停掉它。除了老闆的指令，沒有東西會再把它啟動。 |
| `/boss server restart [reason]` | 確認後在同一個 port 重新啟動它。開著的頁面會自己重新連線。 |
| `/boss server logs [n]` | 它的 log 最後 `n` 行（預設與上限都是 200）。 |

## 瀏覽器檢視

| 指令 | 做什麼 |
| --- | --- |
| `/boss gui` | 從任何 session 在瀏覽器裡開啟網；沒有 sb server 在跑就啟動它，並印出 URL。 |
| `/boss gui stop` | 停掉 GUI，直到下一次 `/boss gui`。 |
| `/boss gui rotate` | 確認後給 GUI 一個新 token：每支手機都解除配對，舊位址回應 403。 |
| `/boss gui view`、`/boss gui view auto\|standard\|geek\|zen\|raven` | 顯示或設定設成自動的裝置的預設檢視。只有這個指令能設定。 |
| `/boss gui remote`、`/boss gui remote off` | 透過你的 tailnet 用手機連到 GUI。見[手機與遠端存取](/pi-straw-boss/docs/zh-tw/guide/phone/)。 |
| `/boss gui lan`、`/boss gui lan off`、`/boss gui lan reset` | 讓同一個 Wi-Fi 上的手機不用 Tailscale 就能連到 GUI。 |
| `/boss gui devices`、`/boss gui unpair <id\|all>` | 列出已配對的手機；解除其中一支或全部的配對。 |

## Straw Link

| 指令 | 做什麼 |
| --- | --- |
| `/boss link on` | 在這台電腦設定 Straw Link，如同頁面的設定按鈕所做的。 |
| `/boss link [status]` | 這台電腦的團隊與成員，以及等待中的加入請求。 |
| `/boss link decide <id> approve\|refuse` | 核准或拒絕加入請求。核准有人看管的裝置時，會請你選出新電腦顯示的安全字。 |
| `/boss link create <relay> <dir> [--share status\|presence] [--label x]` | 為專案資料夾建立團隊。relay 的 token 會在遮蔽的畫面上詢問。 |
| `/boss link join <invite \| @file> [--project <dir>] [--share …] [--label x]` | 加入團隊；印出給邀請者的四個安全字。 |
| `/boss link invite <team> [unattended <device id>]` | 確認後建立邀請，就像頁面的「邀請」與「邀請無人值守裝置」。邀請文字畫在自己的畫面上，絕不進入聊天。 |
| `/boss link invite show\|cancel <hash>`、`link join cancel` | 在自己的畫面上顯示一個開著的邀請、取消它，或取消進行中的加入。 |
| `/boss link leave <team> [--force]` | 確認後離開團隊。 |
| `/boss link trust <device> reply\|forward\|dispatch` | 確認後設定隊友裝置送來的訊息能做什麼；確認會說明各等級讓它能做什麼。 |
| `/boss link role <team> <device> admin\|member` | 確認後讓團隊的某部裝置成為管理員或成員（管理員的操作）。 |
| `/boss link remove <team> <device>` | 把裝置移出團隊（管理員的操作）。確認會說明該裝置不能再讀或送，團隊金鑰也會為留下來的裝置更換。 |
| `/boss link rotate <team>` | 確認後為每部裝置更換團隊的金鑰（管理員的操作）。 |
| `/boss link confirms`、`link confirm <id> allow\|deny` | 隊友的塔台正在等的 confirm，以及對它們的回答。 |
| `/boss link asks`、`link answer <id> <number \| text>` | 無人值守裝置轉送來的問題，以及對它們的回答。 |
| `/boss link units [box]`、`link stop <box> <main \| handle start> [--interrupt] [reason]` | 無人值守的盒子回報的單位，以及請盒子停掉一位主智慧體。 |
| `/boss link operate`、`/boss link operate off` | 這台電腦為操作無人值守的盒子而開的 session；結束它們全部並保持操作關閉。 |

## 從 shell

在套件資料夾裡執行 `node dist/server/cli.mjs`，會執行 sb server 自己的指令：

| 指令 | 做什麼 |
| --- | --- |
| `cli.mjs status`、`cli.mjs logs` | server 的狀態與它的 log。 |
| `cli.mjs up`、`cli.mjs stop`、`cli.mjs restart` | 在 server 與 GUI 沒在跑時啟動它們；停止或重新啟動 server。 |
| `cli.mjs serve` | 在前景執行 server，作為[無人值守裝置](/pi-straw-boss/docs/zh-tw/guide/unattended-device/)的連線持有者。 |
| `cli.mjs up --dir <folder> --label <name>` | 桌面模式，給自己顯示頁面的 shell 用：需要 `STRAW_BOSS_DESK=1`。見[桌面模式](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#桌面模式up---dir)。 |
| `cli.mjs procs`、`cli.mjs procs reap --checkout <path>` | server 知道的工作者；停掉持有某個 checkout 的程序。 |
| `cli.mjs train status\|check\|gate\|clear\|notices` | [合併火車](/pi-straw-boss/docs/zh-tw/guide/merge-train/)的火車、車廂單、關卡與車廂通知。 |

見 [sb server](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/)，以及從一般 shell 讀網的 [從 shell](/pi-straw-boss/docs/zh-tw/reference/how-it-works/from-a-shell/)。
