# pi-straw-boss

[English](README.md) | 繁體中文

**很多個 pi 做同一個專案，也不會互相踩到。** [Herdr](https://herdr.dev) 是給智慧體用的終端機工作區管理器；pi-straw-boss 讓你在 Herdr 各個分頁（tab）裡跑的智慧體（agent）有一條輕量的指揮鏈：每個分頁一個主智慧體（main agent），每個工作區（workspace）一座塔台（tower），還有一張即時的畫面，看得到誰在做什麼。

**[說明文件](https://wayne930242.github.io/pi-straw-boss/docs/zh-tw/)** · **[直接在瀏覽器試用](https://wayne930242.github.io/pi-straw-boss/)**（用假資料跑的展示頁，不用安裝任何東西）

![標準檢視下瀏覽器裡的稻草網：各座基地的塔台、智慧體和子智慧體，狀態即時更新，頂端有各項計數和等待中的單位](docs/straw-net-gui.png)

![展開對話中的待辦清單，任務旁會顯示點數](docs/gui-todo.png)

<p align="center"><img src="docs/gui-plan-board.png" width="57%" alt="主塔台頁面工作板上的主智慧體計畫：未完成的 todo 依依賴分成步驟，每項寫出狀態、負責者（附連結和「切過去」）、接在哪些之後，以及在等誰、等到何時"> <img src="docs/gui-plan-session.png" width="41%" alt="同一份計畫畫在 session 頁面的 todo 區，完整清單收合在圖下方：已完成的任務和點數，以及每項的驗收條件和最近一次執行紀錄"></p>

<p align="center"><img src="docs/gui-board-capacity.png" width="49%" alt="標準檢視的戰況板：裝置預算畫成每格 1 點的補給格，每個已部署的單位橫跨它的點數，旁邊是空格、放待命工作的兵營，以及每位指揮官的單位與可接件數"> <img src="docs/gui-board-raven.png" width="49%" alt="鴉閣檢視的同一張板：已部署的蝙蝠點亮燭火墓位，空墓泛霧，閣門前有待命的蝙蝠，額度停機是合上的棺木，停滯的主智慧體上方群鴉盤旋"></p>

<p align="center"><img src="docs/gui-storybook-day.png" width="80%" alt="白天的繪本地圖，每張紙卡上都有代表角色的動物圖示"></p>

<p align="center"><img src="docs/gui-comms.png" width="49%" alt="單位的通訊畫面：即時的對話紀錄、排隊等下一輪的訊息、待辦清單、背景 Monitor，以及單位檔案"> <img src="docs/gui-zen-item.png" width="49%" alt="禪檢視裡的一件待辦：墨色畫面上是一個 robot_hand 問題，選項是一行行的字"></p>

<p align="center"><img src="docs/gui-car-card.png" width="34%" alt="主代理單位卡上的車廂：一節在第二次全檢查、畫在 app 關卡的梯子上，一節在等另一班火車占用的負載，一節已落地並附版本號，每張都有「看這班火車」"> <img src="docs/gui-car-yard.png" width="64%" alt="從車廂小卡打開的調車場，捲到那節車廂的火車並加上標示：步驟畫成膠囊、需要的負載，以及每節車廂的驗收與通知"></p>

![工作區頁上等老闆回答的問題：每個發問者的圓牌上有金色計數，清單列出每題的編號、種類、主旨、發問者、位置、卡住的 todo、時間，以及「終端機」](docs/gui-asks.png)

## 為什麼需要它

同一個專案跑上幾個智慧體，它們很快就會互相干擾：兩個 dev server 搶同一個 port、兩條分支改同一個 migration，而且沒有一個智慧體知道其他智慧體存在。
pi-straw-boss 讓它們能找到彼此、互相協調，不需要排程器，也不用另外部署服務。

- **每個人都會加入。** Herdr 裡的每個 pi 一啟動就加入所在分頁的網。工作變多（步驟變多、要派工作者、涉及不只一個 app）的智慧體會升任為分頁的**主智慧體**；你，也就是老闆，可以用 `/boss` 接手。
- **每個工作區一座塔台**：它是一個在自己分頁裡的智慧體，在智慧體開始互相干擾時開起來（成員派出子智慧體，或有智慧體升任）。它協調各個主智慧體和其他塔台；沒有 session 負責的工作，它會開一個分頁、啟動新的主智慧體來處理。你不用跟它說話。
- **你自己的主塔台**，和你保持一場長對話，把你交代的每件事轉給該處理的工作區。
- **瀏覽器畫面** `/boss gui`：即時看到每個工作區、智慧體和子智慧體，它們在等你回答的問題，可以直接在桌面或已配對的手機上回答。選「繪本」會看到隨日夜換色的手帳；按頁首的「禪」，就能一次只看一件事。
- **合併火車**：專案可以把審查過的分支整批合併，重型檢查（lint、build、完整測試）每列火車只跑一次，不必每條分支各跑一次。
- **Straw Link** 連起隊友電腦上的塔台，無人值守的建置機也能接隊友送來的工作。
- **自動模式**：跟主塔台說你要去睡了，在你回來之前，沒有智慧體會等你。智慧體照常工作，需要你的事等你回來時退回給提出的智慧體，由它再問你一次。

## 安裝

```bash
pi install npm:pi-straw-boss
```

需要在 [Herdr](https://herdr.dev) 0.9.4 以上的版本裡執行 pi、安裝 Herdr 的 pi 整合（`herdr integration install pi`），以及 [pi-intercom](https://www.npmjs.com/package/pi-intercom) 0.18.1 以上；sb server 需要它，安裝時不會一併裝上（`pi install npm:pi-intercom`）。安裝也會一併帶來子代理派工（`subagent`、`subagent_cancel`、`subagent_resume`、`subagents_list`），由 sb 以 Maestro 引擎當宿主，任何 pi session 都能用，沒有 pi-intercom 也能運作。若同時裝了 pi-herdr-agents，sb 的宿主會退讓：兩者擇一保留（[子代理宿主](https://wayne930242.github.io/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-subagent-host/)）。合併火車另外需要宣告了[合併火車契約](https://wayne930242.github.io/pi-straw-boss/docs/zh-tw/guide/merge-train/#合併火車契約)的 `integrating` 與 `deploying` skill。Windows 支援仍屬實驗性質。sb 隨附它的智慧體所用的 pi-herdr-agents 角色（`worker`、`scout`、`planner`、`reviewer`、`visual-tester`、`adversarial-reviewer`）；請解除安裝 pi-herdr-roles，它的同名角色會互相衝突。可搭配的選用套件見[安裝](https://wayne930242.github.io/pi-straw-boss/docs/zh-tw/guide/install/)。

## 快速開始

**你只和自己所在分頁的主智慧體說話，不和其他任何人說話。** 它規劃工作、派出子智慧體、替你和塔台溝通，只有屬於你的決定才回來找你。一件工作，一個分頁：每件新工作都開一個新的 Herdr 分頁。塔台、成員與子智慧體都不需要你理會；選用的主塔台接收跨工作區的指示。見[你怎麼使用它](https://wayne930242.github.io/pi-straw-boss/docs/zh-tw/guide/quick-start/#你怎麼使用它)，各圖示代表什麼見[圖示](https://wayne930242.github.io/pi-straw-boss/docs/zh-tw/guide/icons/)。

1. 在 Herdr 分頁裡開 pi，交給它工作。它會自己加入網；工作變多時升任為分頁的主智慧體，工作區的塔台也會跟著開起來。
2. `/boss status` 列出每個分頁的主智慧體和各座塔台。
3. `/boss tower` 打開工作區的塔台和它的儀表板。
4. `/boss gui` 在瀏覽器看整張網。

## 常用指令

| 指令 | 作用 |
| --- | --- |
| `/boss` | 接手成為這個分頁的主智慧體。 |
| `/boss status`、`/boss tower` | 列出主智慧體和塔台；打開塔台。 |
| `/boss head <訊息>` | 和主塔台說話。 |
| `/boss gui` | 在瀏覽器打開整張網。`/boss gui remote` 讓手機透過 tailnet 配對。 |
| `/boss send <名稱> <文字>`、`/boss answer` | 以老闆身分寫給任何 session；回答其他 session 正在等的對話框。 |
| `/boss memory` | 塔台的長期指示、決定和等待事項。 |
| `/boss auto on`、`/boss auto off` | 自動模式，你不在時用。 |
| `/boss stash`、`/boss pop` | 把整個工作區（塔台、主智慧體和成員）收起來，之後再接回。 |
| `/boss server` | sb server：每台電腦一個的背景程序，負責執行塔台和提供網頁。 |
| `/boss roles-check [資料夾]` | 把每個角色 `tools:` 列的工具名稱，和這個 session 的工具比對。 |

所有工具和指令見[指令](https://wayne930242.github.io/pi-straw-boss/docs/zh-tw/reference/commands/)。

## 說明文件

[說明文件網站](https://wayne930242.github.io/pi-straw-boss/docs/zh-tw/)有正體中文和[英文](https://wayne930242.github.io/pi-straw-boss/docs/)版：概念、瀏覽器畫面、手機、主塔台、自動模式、合併火車、Straw Link、無人值守裝置、Herdr 外掛、設定，以及版本紀錄。
[docs/how-it-works.zh-TW.md](docs/how-it-works.zh-TW.md) 是完整的行為說明（[English](docs/how-it-works.md)）。

## 授權

MIT。瀏覽器畫面的圖示來自 [game-icons.net](https://game-icons.net)（Lorc 與 Delapouite，[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)）；見 [gui/ICONS.md](gui/ICONS.md)。標準、鴉閣與繪本使用的錄音不屬 MIT，依 Casper 音效庫的授權使用；見 [NOTICE.md](NOTICE.md)。
