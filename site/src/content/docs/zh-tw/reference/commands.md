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
| `call_peer` | 成員、任何種類的主智慧體、列車（從它的回合開始啟用） | 在標頭之下發訊息給 sb net 裡的同伴；sb 在呼叫當下找出對方，已交接的對象會送到接班者。`to`：`sender`（最後寫給你的人）、`caller`（開啟你的人：開啟者、接班者的舊 main、整合員的塔台、列車的整合員）、`main`（你分頁的主智慧體；帶 `of` 時，以精確名稱、待辦項目鍵或分頁 id／標籤找另一個活著的主智慧體）、`integrator`（你 checkout 所屬專案唯一的整合員）。找不到或多個相符時拒絕，並說出找到了什麼（至多五個候選）。`ask: true` 會標上 `reply=expected`，回覆以 intercom 訊息送來。主智慧體不帶 `of` 呼叫 `main` 會被拒絕（那就是自己）；塔台用 `tower_send`／`tower_reply`。 |
| `boss_watch` | 分頁的主智慧體與火車（塔台執行開啟時） | 請 sb server 盯著網裡的一個單位（`key`、`quiet`、`idle`、`until`、`stop`；不給鍵就列出你的盯守），每有變化就用一行字叫醒你：每個盯守每分鐘最多一則、只送最新狀態、每小時 12 則，你在工作時等這一輪結束再送。見[用 boss_watch 盯著一件事](/pi-straw-boss/docs/zh-tw/guide/concepts/#用-boss_watch-盯著一件事)。 |
| `boss_pair` | 分頁的主智慧體與火車 | 派工前把一個 worker 和一個 reviewer 配到審查串 `T<n>` 上（`worker`、`reviewer`：你交給 `subagent` 的名稱；`rounds` 1 到 3，預設 3；`item` 可選：這一對處理的 todo uid 或 `<session8>#<id>`，記在串上與 sb 的事件帳本裡）；兩者的任務都放一行 `Thread: T<n>`，你只在串關閉時被它們的兩份結果叫醒。見[用 boss_pair 開審查串](/pi-straw-boss/docs/zh-tw/guide/concepts/#用-boss_pair-開審查串)。 |
| `thread_post`、`thread_wait` | 主智慧體配成對的子智慧體（從第一次執行起啟用） | 在審查串上貼文（`to`、`tag`：`review`、`fix`、`done`、`blocked` 或 `note`；`text`；`refs`），以及等待點名你的貼文或串的關閉。 |
| `boss_duty` | 分頁的主智慧體 | 附理由設定它的種類：`coordinator`、`integrator` 或 `standing`。這個種類的 prompt 以訊息送給主智慧體，它的 system prompt 保持不變；種類也會顯示在頁面上。 |
| `boss_rename` | 已加入的 session | 用一句短語為 session 命名它目前的工作；主智慧體的分頁以它為標籤。角色標籤（塔台的圖示、`train <MMDDx>`）會被拒絕。 |
| `call_tower` | 已加入的 session 與塔台 | 在標頭之下發訊息給這個工作區的塔台，或另一個工作區的塔台。`why` 是 `milestone`、`shared` 或 `blocked`；通知用 `reply: false`。sb 把 `milestone` 記進塔台的帳本，只在它回應塔台的請求時喚醒塔台；`shared` 報備也記下，只在它和另一則仍有效的報備或某個主智慧體的看板重疊時喚醒塔台，否則回答「recorded, no clash seen」（[帳本](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#帳本)）。`blocked` 附 `waitsOn {device, owner?, what}` 表示在等隊友的裝置（`milestone` 附 `cancel: true` 撤回）；`linkWait {id, state}` 認領、回覆或婉拒隊友對本機的等待，在它的討論串裡送一則註記給那邊在等的主智慧體（`note`，等待不關閉），以老闆代理人的身分核准隊友要給它老闆的卡片（`done`），或交回那位老闆（`escalated`，搭配 `blocked`）；`standing {device, what?}` 把訊息改送那台裝置的值守主智慧體，不經塔台：`blocked` 是提問（回覆會回來），`milestone` 是通知。`worker {device, branch, base?, model?, points?, label?}` 把訊息當作隊友 box 上一個工作者的完整任務說明送出（那台 box 的 caps 要列出 `tower.worker`，並以 `dispatch` 信任你）：box 在它自己的 worktree 裡開啟它，它的最終報告或 box 的拒絕以 `link_reply` 回到你這裡（[為裝置開啟的工作者](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#為裝置開啟的工作者)）。`worker {device, resume: "<uuid>", branch?, model?, points?}` 把訊息當作已結束工作者的後續工作送出：完整的 session id 就是它的收據上 `Session:` 那一行寫的（保留 7 天），而且那台 box 要列出 `tower.worker.resume`。`blocked` 附 `boss {question, options?}` 是只有你能做的決定：自動模式關著時，sb 在那個主智慧體自己的面板裡和 GUI 上問你（在哪裡都能選一個選項或自己打答案），你的回答回給主智慧體，不送塔台；自動模式開著時它送給塔台，擱置到你回來。見[主智慧體呼叫塔台時](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#主智慧體呼叫塔台時)與[裝置之間的等待](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/#裝置之間的等待)。 |
| `boss_broadcast` | 已加入的 session 與塔台 | 發訊息給一個分頁、一個工作區、所有塔台或所有 session，標頭會列出每位收件者。 |
| `board_set` | 分頁的主智慧體 | 覆寫它自己的工作看板項目（一行與最多 8 個清單項目）；`auto: true` 交還給自動填入，`clear: true` 刪除它；`snooze: {why, for?, watch?, todo?}` 把它的停滯提醒延後一段時間（`30m`），或延到它某個 `boss_watch` 看守下一次有變化，對象是整個主智慧體或其中一項 todo。 |
| `ledger_sweep` | 只限收到排程通知的主塔台 | 執行伺服器清理和設定好的 ledger janitor，回傳主塔台該轉交的項目。不接受參數。 |
| `boss_server` | 已加入的 session | sb server 的 `status`（server 沒在跑時也可用）、它的 `logs`（最多 200 行），或附理由 `restart`。老闆停掉 server 或有火車在跑時會被拒絕，每分鐘最多一次，且在遠端 turn 中絕不可用。 |
| `sb_doctor` | 已加入的 session 和塔台 | 這個 session 自己的工具和載入：預期的工具（`subagent*`、`intercom`、`todo`、`MonitorCreate`）有沒有註冊和啟用、是哪個子代理宿主註冊的（sb 自己的、為 pi-herdr-agents 退讓及原因，或關閉）與它的 Maestro 版本、是不是最新版，以及該做什麼：H1（什麼都沒載入：交接）、H2（未啟用：`/boss doctor fix`）、過期（reload 或交接）。斷定工具不見之前先呼叫它；見[診斷（doctor）](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-doctor/)。 |
| `subagent` | 每個 pi session，加入網與否、有沒有 todo 都可以 | 在 Herdr 分割窗格派出一個 worker：`name`、`task`，以及可選的 `agent`（角色）、`model`（精確 id、備援清單或 `task:<category>`）、`thinking`、`cwd`、`item`（它處理的 todo；臨時的 scout 不需要）、`solutionSpace`、`systemPrompt`、`skills`、`tools`、`fork`、`interactive`。它只跑一件任務，做完就結束，結果以訊息送回；不要輪詢。帶 `persistent`、`notify`、`worktree`、`accept` 的呼叫會被拒絕，並說明改用什麼做法。見[子代理宿主](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-subagent-host/)。 |
| `subagent_cancel` | 派出該 worker 的 session | 結束一個執行中的 worker（`id` 或 `name`）；之後會送回一則 `cancelled` 結果，也不會改用備援模型。 |
| `subagent_resume` | 每個 pi session | 在新窗格接續一個已存的 worker session（`sessionPath`、`name`、`message`、`autoExit`）：回覆它的 `caller_ping`、追加工作，或接手一個沒有結果就結束的 worker。 |
| `subagents_list` | 每個 pi session | 可以派出的角色，以及各自的來源。 |
| `sb_ward` | 分頁的主智慧體（塔台執行開啟時） | 看守跑在一般 pane 裡的 worker（`pane`、`item`、`until`、`stop`），取代 Herdr 監看：它做完（向你報告，或它那一輪結束、一分鐘內沒有任何東西在跑）、被擋住（對話框，或 Herdr 顯示被擋住）或死掉（pane 不見、pi 離開）時，sb server 叫醒你一次；它在自己的監看或迴圈還在跑時閒著，不會叫醒你。唯讀。見[看守一般 pane](/pi-straw-boss/docs/zh-tw/reference/how-it-works/process-hygiene-and-slots/#看守一般-pane)。 |
| `link_request` | 設好 Straw Link、有人看管的電腦上的每個 session，以及本機塔台 run | 附理由請求一個 Straw Link 動作（create、invite、join、trust、leave、remove、role、rotate、hold）。它絕不會未經詢問就執行：老闆要在對話框裡核准。解除自己對某台盒子的接管（`release`）不經對話框（[接管隊友的機器](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/#接管隊友的機器)）。 |
| `boss_open_main` | 塔台 | 為沒有 session 負責的請求，開一個帶新主智慧體的分頁。`role: "train"` 開一列火車；`role: "integrator"` 把車廂單送給專案唯一的整合員，沒有在跑的就開一個。`duty: "standing"` 開一個值守種類的主智慧體（預設為協調者）。在 `dispatch` 的隊友 run 裡，`role: "worker"` 依那個 run 的裝置送來的 `worker:` 單據開啟一個工作者，續接單據也一樣（有好幾張時以 `branch` 指定）；不論成敗，sb 伺服器都會回覆那台裝置。見[合併火車](/pi-straw-boss/docs/zh-tw/guide/merge-train/)。 |
| `boss_close_main` | 塔台 | 等它裡面沒有東西在跑，關掉這座塔台開的主智慧體，或交接過、接班者已活著的主智慧體；沒有交接的值守主智慧體與老闆開的主智慧體不會被關，只有老闆能關。帶 `pane` 時關掉死掉的智慧體窗格（pi 不在、停在空的 shell）；不帶參數時列出這些窗格。 |
| `boss_revive_main` | 塔台（pi 塔台與本機塔台執行） | `list` 列出工作區裡死掉與已退出的主智慧體；`revive` 附理由把其中一個救回成它自己（同一個 session、新分頁，帶著它的角色、種類、名稱、看板、待辦與等待）。成員、塔台、隊友裝置開的主智慧體與活著的 session 會被拒絕。 |
| `boss_handover` | 分頁的主智慧體 | 為 session 輪替開出自己的接班者：新分頁沿用舊主智慧體的名稱與種類，一次只開一個。第一則提示會列出 `handoff` 交接檔；若匯出了待辦，也會請接班者匯入同目錄下的 `.todos.json`。清單保留已完成的任務與驗證紀錄，略過已刪除的任務。工作區的塔台會收到通知。接班者告訴舊主智慧體它已接手、而舊主智慧體沒有任何東西在跑時，sb 就關掉舊主智慧體和它的窗格，auto 模式下也一樣；這段期間送到舊主智慧體的子智慧體結果，會轉給接班者。替隊友裝置開的主智慧體會被拒絕。 |
| `boss_wrap` | 分頁的主智慧體（常駐主智慧體、火車、塔台、替隊友裝置開的主智慧體與隊友的回合除外） | 工作做完時收工（`summary`，一段話）：在主智慧體自己的面板裡問你，所以 Herdr 顯示它在等待；你同意後，它把摘要當作里程碑送給工作區的塔台（若是塔台替某個 session 開的主智慧體，也送給那個 session），清掉它的工作看板，再像 `/boss close` 一樣結束這個 session 並只關掉它自己的面板、絕不關分頁：旁邊的面板和分頁都留著，分頁沒有面板時由 Herdr 關掉。還有未完成的待辦，或還有監看、迴圈、`boss_watch`、子智慧體在跑，以及自動模式開著時，都會拒絕。協調者或整合者主智慧體閒置 30 分鐘後，sb 會叫醒它一次，問它工作是否做完；自動模式開著時不叫。 |
| `tower_list` | 塔台 | 每個工作區的塔台、發給它的訊息會送到誰、它的狀態，以及它的分頁在做什麼（每個分頁的主智慧體及其種類）。 |
| `tower_send` | 塔台 | 發訊息給另一座塔台（用工作區 id 或標籤）或全部；附 `device` 則發給隊友電腦上的塔台：不給 `reply` 時綁定這次 run 裡唯一等回覆的主智慧體，`reply: false` 是通知，`waitsOn: {event}` 轉送主智慧體對那台裝置的等待，`standing: "question"` 或 `"notice"`（在 run 裡）改送那台裝置的值守主智慧體；隊友 run 只能送通知。 |
| `board_read` | 塔台、主智慧體；成員只拿到 `towers` | 工作看板：每位主智慧體在做什麼、做到哪裡，包括這裡與隊友的電腦，本機與隊友裝置之間未結的等待（`waits`），`towers`：每個分頁的主智慧體與它的種類、這個工作區的塔台、主塔台與其他塔台（0.83.0 之前是 `boss_status`），以及 `logbook`：sb 最近一天為這個工作區的塔台記下的里程碑與報備，和其他工作區仍有效的報備；對主智慧體還有它的審查串 `threads`，帶 `thread` 時是一個串的貼文。每位主智慧體的列與 `capacity` 區段帶著[裝置產能](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/#裝置產能)：使用中點數、預算、負載、可接的工作與停機中的主智慧體。 |
| `tower_memory` | 本機塔台 run | 保存 run 結束後還要留著的內容：引用自老闆自己訊息的長期指示或決定，以及塔台的等待事項，包括對老闆的等待（以卡片呈現）。裝置指定了老闆的代理人時（config.json 的 `link.delegate`，無人看守裝置則是政策檔的 `delegate`），卡片會先交給代理人，除非標了 `bossOnly`、是秘密卡，或由列車或整合員發起。 |
| `boss_wait_ask` | 主智慧體、本機塔台 run、主塔台 | 讓 sb 在終端機裡把開著的等待卡片一張接一張拿給你看：`ids`（1 到 4 個 `W<n>`），或不指名，代表它範圍內每一張開著的卡片（主智慧體是它提出的，塔台 run 是它那座塔台的，主塔台是任何一張）。sb 照 `/boss wait` 的畫法畫每一張卡片；智慧體不寫字也不選，只有你的按鍵能按。自動模式開著、無人值守的裝置、沒有畫面時都被拒絕；在塔台 run 裡，只有你在這個 run 裡最後說的話來自它的 pane 才會畫。 |
| `tower_reply` | 塔台 run，不含主塔台的 | 用 intercom 名稱或 session id 回答一個本機 session（主智慧體或成員），掛在塔台的標頭之下。`forward` 把車廂單的事件 id 轉給整合員。 |
| `tower_done` | 塔台 run | 附一份交接筆記（一項一行，最多 1,200 字元）結束這次 run，留給下一次 run；`wakeAfter`（5 到 240 分鐘，僅限本機 run）要求稍後再跑一次。事件仍在等這次 run，或主智慧體對裝置的等待既未轉送也未回覆時，會被拒絕。 |
| `ally_escalate` | 盟友 run | 把寄件者訊息裡的一項（在等這裡的某人、點名的本機主智慧體、沒有本機主智慧體負責的工作、一起事故）交給等待路由器，由它通知主智慧體或放上老闆的清單。任何層級都可用；每次 run 最多 5 項。 |
| `boss_auto` | 主塔台 | 依老闆自己的話（server 自己讀），在它回答的那個 turn 裡直接開始或結束[自動模式](/pi-straw-boss/docs/zh-tw/guide/auto-mode/)，不需確認。 |
| `train_car` | 整合員與火車（火車一定有；其他 session 要在專案的 apps.json 有帶 `integration` 的 app 時才有） | 設定車廂的狀態（`received`、`returned`、`dropped`、`landed`）；sb server 會通知該車廂的協調者。它的 `car` 是車廂的第一張票；車廂單的 `car:`（或 `app:`）指名 app；同一張票在兩節車廂上時，用 `app` 或 `head`（40 個十六進位字元）指定其中一節。火車設定自己車廂的 `returned`、`dropped`、`landed`；整合員在收件時設定 `received` 或 `returned`，而它收下的車廂，等那列火車已不在了，也可以由它設定 `returned`、`dropped` 或 `landed`。 |

完整的表格與每個參數，見[工具](/pi-straw-boss/docs/zh-tw/reference/how-it-works/tools/)。

## 角色與狀態

| 指令 | 做什麼 |
| --- | --- |
| `/boss` | 接手成為這個分頁的主智慧體，即使它已經有一位。 |
| `/boss status` | 每個分頁的主智慧體與各座塔台。 |
| `/boss asks` | 這台電腦上在等你回答的問題：`call_tower` 的 boss 問題、開著的等待卡、隊友送到你這裡的等待，以及在等 `ask_user_question` 的單位，每題顯示為 `Q3 · 7m · 發問者 · 位置 · 主旨`，並寫出它卡住的 todo；這個 session 和它的子代理排前面。todo 面板透過 `straw-boss:ask-rows:v1` 畫的是同樣的列；見[等你回答的問題](/pi-straw-boss/docs/zh-tw/reference/how-it-works/browser-view/#等你回答的問題)。 |
| `/boss board` | 以文字顯示工作看板：每個主智慧體的那一行、完成數與更新時間、過時與已結束的條目（只限這台電腦）。 |
| `/boss board log` | 帳本：sb 最近一天為這台電腦每個塔台記下的里程碑與報備，各附寄件者、報備的結束時間，以及它有沒有喚醒塔台。 |
| `/boss cars` | 這個 session 的車廂在哪裡：每節掛在它的 todo 底下（或「其他車廂」；調度員的火車在「火車」），顯示為 `📮 已送出`、帶發車規則的等發車、在火車的哪一關（`🚂 1127l ▰▰▰▱▱▱▱ merge 12m · 等 1127j`，關卡用火車自己的名字），或 30 分鐘內結束。和 todo 面板透過 `straw-boss:car-rows:v1` 畫的是同樣的列；見[車廂列](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/#車廂列)。 |
| `/boss tower` | 這個工作區沒有塔台在跑就開一座，並聚焦它的分頁。 |
| `/boss tower <prompt>` | 寫給這個工作區的塔台。 |
| `/boss tower -w <workspace\|head> <子指令>` | 對另一個工作區的塔台操作，如同塔台的卡片與輸入框所做的。寫給另一座塔台會先詢問。 |
| `/boss tower … status`、`parked`、`leave`、`new` | 塔台的狀態、被擱置的事件、讓對話帶著交接筆記結束、開新對話。 |
| `/boss tower … retry`、`deliver <id>`、`drop <id>` | 重試、送出或丟棄一個被擱置的事件。 |
| `/boss tower … [--answers W3] <message>` | 寫一則訊息；`--answers W3` 標記某個對你的等待在塔台收下訊息後即算已回答。 |
| 在塔台的 viewer 裡（`towerRuns.headless`） | 一行訊息送給塔台。單獨打一行時：`/stop` 讓 run 停下這一輪；`@<workspace> <text>` 把你的話直接送到那個塔台；`/yes N`、`/no N`、`/pick N <選項>` 回答 run 的對話框。貼上的文字不算以上任何一種。見[無介面的 run](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#無介面的-run)。 |
| `/boss head [status\|leave\|new\|close\|<message>]` | 與[主塔台](/pi-straw-boss/docs/zh-tw/guide/head-tower/)對話。單獨的 `/boss head` 會建立它的工作區並聚焦它的分頁。 |
| `/boss head retry`、`parked`、`deliver <id>`、`drop <id>` | 主塔台的通知與被擱置的事件。 |
| `/boss head --answers W3 <message>` | 回答某個等待的訊息。 |

## 與 session 對話

| 指令 | 做什麼 |
| --- | --- |
| `/boss send <name\|key\|#todo> [--after] <text>` | 以老闆的身分寫給網上任何 session，如同頁面的輸入框所做的。`#63` 或 todo uid 寫給這個 session 清單中那項 todo 的負責者；子智慧體照 Herdr 顯示的名稱指名。`--after` 讓它排到該 session 閒下來時。名稱有空格要加引號：`/boss send "fix login" hi`。 |
| `/boss stop <name\|key>` | 在 session 裡按 Esc，如同頁面的停止（會先在 pi 裡詢問）。 |
| `/boss answer` | 列出其他 session 正在等的對話框（select、confirm 或問卷，附編號的選項）。 |
| `/boss answer <name\|key> [<choice number \| text> \| --cancel]` | 回答其中一個，如同頁面所做的，經過同樣的 server 檢查。沒有輸入選項時，pi 會問。祕密絕不從這裡回答：請在那個 session 的終端機輸入。 |

## 記憶與自動模式

| 指令 | 做什麼 |
| --- | --- |
| `/boss memory [-w workspace]` | 讀塔台的記憶：長期指示、決定、等待事項，以及等你處理的提案。 |
| `/boss memory confirm P1`、`reject P1` | 確認或拒絕塔台的提案。 |
| `/boss memory add standing\|decision <text>`、`edit S1 <text>`、`delete D1`、`resolve W1` | 自己修改記憶。 |
| `/boss memory done\|choose\|decline W<n>` | 處理一個等待事項。被自動模式擱置的卡片在自動模式結束時已退回給提出它的一方，不在這裡。 |
| `/boss wait [-w workspace \| label \| head]` | 列出等你處理的等待卡片，並按下其中一張：完成、選一個選項、略過、回覆塔台，或開始輸入機密。它送出頁面本身的 press，按下、略過或回覆之後直接開下一張還在等的卡片（卡片的動作裡有**下一張**與**全部卡片**）。塔台的常駐 pane 會自己把卡片一張接一張畫出來：↑↓ 或數字標記一列，Enter 按下，←→ 換張，Esc 把按鍵還給訊息列，`/wait` 把卡片叫回來；你回答的期間不會啟動塔台 run（到最後一個卡片按鍵之後約一分鐘為止，總共最多 5 分鐘）。不回報按鍵的地方（管線、`TERM=dumb`、Windows），`/wait` 是數字選擇器。 |
| `/boss auto` | 顯示自動模式的狀態與上一份回來清單。 |
| `/boss auto on`、`/boss auto confirm`、`/boss auto off` | 請求自動模式並在終端機確認；確認一個等你確認的請求；結束它，把每張被擱置的卡片退回給提出它的一方，並印出回來清單。 |

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
| `/boss server restart [reason]` | 確認後在同一個 port 重新啟動它，確認會指名正在跑的火車。開著的頁面會自己重新連線。 |
| `/boss server logs [n]` | 它的 log 最後 `n` 行（預設與上限都是 200）。 |
| `/boss locale` | 顯示 sb 的語言（英文或繁體中文）與它的來源：`config.json` 的 `locale`，否則取自環境變數。 |
| `/boss locale zh-TW` · `en` · `auto` | 寫進 `config.json`，或改回取自環境變數（`auto`）。server 與 `/boss` 指令立即生效，塔台提示在下次啟動時生效；已寫好的卡片保留原本的語言。見[語言](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#語言)。 |

## 角色

| 指令 | 做什麼 |
| --- | --- |
| `/boss roles-check [資料夾]` | 把每個角色 `tools:` 列的名稱，和這個 session 的工具、以及只有子智慧體才有的名稱（`caller_ping`、`subagent_done`、`thread_post`、`thread_wait`）比對。這個 session 沒有的名稱，或只有上層才有的名稱（sb 自己的工具、pi-herdr-agents 的 worktree 工具），都算失敗。不給資料夾時讀 sb 自己的 `roles/`；發版前請指名 checkout 裡的 `roles/`。它不啟動任何東西；以 `--tools` 或 `--exclude-tools` 啟動的 session 會拒絕執行。 |
| `/boss doctor`、`/boss doctor fix` | 這個 session 的 doctor 報告；`fix` 讓已註冊但未啟用的預期工具重新啟用。每次 session 開始也會檢查一次，缺少預期工具時發出警告。 |

見[角色包](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-role-pack/)。

## 瀏覽器檢視

| 指令 | 做什麼 |
| --- | --- |
| `/boss gui` | 從任何 session 在瀏覽器裡開啟網；沒有 sb server 在跑就啟動它，並印出 URL。 |
| `/boss gui stop` | 停掉 GUI，直到下一次 `/boss gui`。 |
| `/boss gui rotate` | 確認後給 GUI 一個新 token：每支手機都解除配對，舊位址回應 403。 |
| `/boss gui view`、`/boss gui view auto\|standard\|geek\|raven\|storybook` | 顯示或設定設成自動的裝置的預設檢視。只有這個指令能設定。禪是模式，用頁面頁首的禪按鈕進入，所以 `zen` 會被拒絕。 |
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
| `/boss link hold <box> [--main <name\|key>] [--hours n]`、`link release <box>`、`link holds` | 為這裡的主智慧體接管隊友的無人值守盒子（先確認；除非 `--main` 指名另一個，否則是這個 session）、解除接管，以及列出這台電腦的接管與每台盒子是否認可。 |
| `/boss link held`、`link held end` | 在被接管的盒子上：哪位隊友接管它，以及在這裡結束接管（先確認；會通知那部裝置）。 |
| `/boss link operate`、`/boss link operate off` | 這台電腦為操作無人值守的盒子而開的 session；結束它們全部並保持操作關閉。 |

## 從 shell

在套件資料夾裡執行 `node dist/server/cli.mjs`，會執行 sb server 自己的指令：

| 指令 | 做什麼 |
| --- | --- |
| `cli.mjs status`、`cli.mjs logs` | server 的狀態與它的 log。 |
| `cli.mjs prune --dry-run` | 預先計算會清除多少過期角色紀錄、已結束火車檔和消失工作區的塔台資料夾。不寫入資料目錄。 |
| `cli.mjs up`、`cli.mjs stop`、`cli.mjs restart` | 在 server 與 GUI 沒在跑時啟動它們；停止或重新啟動 server。有火車在跑時，`restart` 以及 `up` 的升級或桌面開關重啟都會被拒絕；帶 `--reason` 的 `--force` 照樣重啟。 |
| `cli.mjs serve` | 在前景執行 server，作為[無人值守裝置](/pi-straw-boss/docs/zh-tw/guide/unattended-device/)的連線持有者。 |
| `cli.mjs up --dir <folder> --label <name>` | 桌面模式，給自己顯示頁面的 shell 用：需要 `STRAW_BOSS_DESK=1`。見[桌面模式](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#桌面模式up---dir)。 |
| `cli.mjs watch <key> [--idle 20m] [--quiet 30m] [--deadline <ms>]` | 單位、主智慧體或隊友裝置 `link:` 鍵每有變化就印一行 JSON，給 `MonitorCreate` 用；遇到 `gone` 或 `expired` 結束。 |
| `cli.mjs procs`、`cli.mjs procs reap --checkout <path>` | server 知道的工作者；停掉持有某個 checkout 的程序。 |
| `cli.mjs pane close <pane> [--checkout <root>] [--force]` | 關掉這個工作區裡一個死掉的智慧體 pane（由 `boss_close_main` 用的那張表決定；其他 pane 只有老闆能用 `--force` 關），並確認它真的不見了（Herdr 還列著同一個 terminal 就再關，最多關三次），再停掉它留下的東西：它的 shell 底下的行程樹，一次一個確認過的行程，加上 `--checkout`（linked worktree 的根目錄）時在那裡工作的程序，絕不包括這個指令本身。印出一行 JSON，列出還留著的 `left`；pane 還在或有東西留下時結束碼為 1。見[確認過的 pane 關閉](/pi-straw-boss/docs/zh-tw/reference/how-it-works/process-hygiene-and-slots/#確認過的-pane-關閉)。 |
| `cli.mjs ward <pane>` | 已退役：拒絕並指向 `sb_ward`（結束碼 1）。看守只能由主智慧體自己的 pi 行程設定、列出和停止，它帶著登記密鑰；shell 沒有。見[看守一般 pane](/pi-straw-boss/docs/zh-tw/reference/how-it-works/process-hygiene-and-slots/#看守一般-pane)。 |
| `cli.mjs doctor --session <id\|prefix\|pane> [--json]` | 從外部替另一個 session 診斷：用 pi 的 loader 重新載入一次、它的 session 檔被拒絕的工具、它的 pi 啟動時間對照安裝時間。有故障時結束碼為 1。 |
| `cli.mjs train status\|check\|gate\|clear\|end\|notices` | [合併火車](/pi-straw-boss/docs/zh-tw/guide/merge-train/)的火車、車廂單、關卡與車廂通知。`status --state live,stale,ended,unreadable` 只留下這些狀態的列。`status --watch [--every <seconds>]` 每 60 秒（或指定的秒數，10 到 2147483）再看一次，每看一次印一行 JSONL 的 `progress`，不論有沒有變化，所以開在它上面的 `MonitorCreate` 不會在沒有變化時逾時；stdout 關閉時以結束碼 1 結束。`check` 可以在專案或其中任何資料夾執行，沒有 `--app-accept` 時要求 app 的 `integration.accept`，並檢查車廂單的 `head:` 是認得的 commit、且是它的分支在 origin 上的頂端。`end --project P --train CODE --outcome landed --commit SHA`（或 `--outcome none`）`--reason TEXT --evidence TEXT` 結束一列過時的火車（仍持有部署目標的，先清掉那個目標）。 |

見 [sb server](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/)，以及從一般 shell 讀網的 [從 shell](/pi-straw-boss/docs/zh-tw/reference/how-it-works/from-a-shell/)。
