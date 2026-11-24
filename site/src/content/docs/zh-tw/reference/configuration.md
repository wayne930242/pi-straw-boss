---
title: 設定
description: 設定檔、專案的 apps.json，以及 pi-straw-boss 讀取的環境變數。
---

pi-straw-boss 不需要任何設定就能運作。
以下所有項目都是選用的。

## `config.json`

設定檔是 `<agentDir>/straw-boss/config.json`，其中 `<agentDir>` 是 `PI_CODING_AGENT_DIR`，否則是 `~/.pi/agent`。

```json
{
  "towerModel": "provider/model-id",
  "headModel": "provider/model-id",
  "towerRuns": { "enabled": true, "max": 4 },
  "integration": "on",
  "locale": "zh-TW",
  "stallWatch": { "cpuMinutes": 5, "silentMinutes": 30 },
  "capacity": { "budget": 20 },
  "link": {
    "relay": "https://relay.example",
    "trust": { "<device id>": "forward" }
  }
}
```

| 鍵 | 預設 | 做什麼 |
| --- | --- | --- |
| `towerModel` | pi 的預設模型 | 塔台 run 的模型。塔台只負責轉送與協調，所以可以用比較輕量的模型。每次塔台啟動時讀取。 |
| `headModel` | `towerModel` | [主塔台](/pi-straw-boss/docs/zh-tw/guide/head-tower/)執行的模型。 |
| `towerRuns.enabled` | `true` | 塔台服務：塔台是一次因事件而醒來、結束時留下交接筆記的執行。`false` 則保留常駐的塔台。讀不到或無法解析的檔案也視為開啟，server 會在它的 log 裡說明。 |
| `towerRuns.max` | 4 | 同時跑的 pi 執行上限。 |
| `towerRuns.headless` | `false` | 每個塔台 run 都是 sb server 的 `pi --mode rpc` 子行程，不佔窗格；塔台的分頁是只打一次字的 viewer。關閉時就是 0.84.0 的行為。見[無介面的 run](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#無介面的-run)。 |
| `towerRuns.pi` | 無 | 無介面 run 用的 pi CLI 檔案，用在 server `PATH` 上的 `pi` 不是要用的那個時。 |
| `integration` | `on`（在 `STRAW_BOSS_DESK=1` 下為 `off`） | `off` 會在這台電腦上關掉[合併火車](/pi-straw-boss/docs/zh-tw/guide/merge-train/)。開啟是 `on`、`true`、`1` 或 `yes`；關閉是 `off`、`false`、`0` 或 `no`。任何其他值，以及讀不到的檔案，都會把它關掉並發出通知。 |
| `locale` | 取自環境變數 | sb 的語言，`zh-TW` 或 `en`：替身、主塔台的名稱、塔台提示、執行寫的卡片，以及 `/boss` 指令。沒有設定時由 `LC_ALL`、`LC_MESSAGES` 或 `LANG` 決定，否則用系統語言。用 `/boss locale` 設定。見[語言](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#語言)。 |
| `stallWatch.enabled` | `true` | [停滯監看](/pi-straw-boss/docs/zh-tw/guide/process-hygiene/#停滯監看)：pi session 看起來卡死時，sb server 會告訴該工作區的塔台，但絕不停掉那個 session。`false` 關閉。`stallWatch` 的每個鍵每分鐘讀一次，改了不必重啟。 |
| `stallWatch.cpuPercent` | 75 | 占用單一核心多少算是滿載，10 到 100，以 `cpuMinutes` 內的平均計算。某一分鐘低於它的一半就算平靜，計數重新開始。歷史很長的正常 session 工作時，某一分鐘也可能超過這個值（實測兩個分別是 73 和 83）；它和卡死的差別在於還在寫 session 檔，所以調低這個值幫助不大，還可能誤報。 |
| `stallWatch.cpuMinutes` | 5 | pi 連續幾分鐘都不平靜、平均達到 `cpuPercent` 以上，session 檔又沒有寫入，才通報。其中某一分鐘略低於門檻不會讓計數重新開始。`0` 關閉這個訊號。 |
| `stallWatch.silentMinutes` | 30 | pane 顯示工作中，但 session 檔沒有寫入、也沒有進行中的工具呼叫，最多容許連續幾分鐘。session 有了回應並開始工具呼叫，就算恢復。`0` 關閉這個訊號。 |
| `stallWatch.missingMinutes` | 3 | 還活著的 pi 最多可以連續幾分鐘不在 pi-intercom 的清單裡；server 重啟後的寬限也是這個數字。`0` 關閉這個訊號。 |
| `stallWatch.remindMinutes` | 60 | 事件通報後多久發第一次提醒；之後每次等待加倍，最長 8 小時。訊號消失期間不發提醒。`0` 不提醒。 |
| `capacity.budget` | 無 | 這台裝置的產能點數（大於 0，至多 1000），供工作看板上的[裝置產能](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/#裝置產能)使用：sb server 拿主智慧體執行中工作所用的點數（todo 的 `metadata.points`）和最小的可接 todo 跟它比，空位持續 10 分鐘就通知塔台。沒設時照樣顯示數字，只是不標產能閒置。每分鐘讀一次。在無人值守的裝置上，它也依點數放行 `worker` 子智慧體，每次派出時重讀，所以改了立即生效；沒設就不擋。有人值守的裝置從不擋工作者。 |
| `link.relay` | 無 | 新的 [Straw Link](/pi-straw-boss/docs/zh-tw/guide/straw-link/) 團隊預設使用的 relay。 |
| `link.trust` | 每個裝置都是 `reply` | 這台電腦對每位隊友裝置的信任程度：`reply`、`forward` 或 `dispatch`。 |

頁面與 `/boss link` 指令會自己寫入 `link` 區段的 `teams`；只有要修復時才手動編輯。
在無人值守裝置上，改由 root 擁有的 `/etc/straw-link/policy.json` 提供團隊與信任，`link` 區段會被忽略。

## 專案的 `apps.json`

專案在 git 根目錄的 `.straw-boss/apps.json`（第一個不存在時用 `.claude/straw-boss/apps.json`）描述它的 app。
主智慧體依 app 拆分工作時會讀它，合併火車則讀它的 `integration` 欄位。
沒有這個檔案時，只含一個程式碼庫的儲存庫自己就是唯一的 app。

```json
{
  "integration": { "skill": "integrate", "maxCars": 4, "maxWaitMin": 60 },
  "apps": [
    {
      "name": "api",
      "dir": "apps/api",
      "match": ["backend", "rest api"],
      "integration": { "base": "develop", "stages": ["merge", "deploy"], "accept": ["e2e"], "targets": { "test-env": "auto" } }
    }
  ]
}
```

[`prompts/apps-config.md`](https://github.com/wayne930242/pi-straw-boss/blob/main/prompts/apps-config.md) 說明每個欄位。

## 環境變數

在 `herdr server` 與它啟動的 session 的環境裡設定這些。

| 變數 | 做什麼 |
| --- | --- |
| `PI_CODING_AGENT_DIR` | pi 的 agent 資料夾，狀態資料夾 `straw-boss/` 就在裡面。預設 `~/.pi/agent`。 |
| `STRAW_BOSS_INTEGRATION` | `off` 或 `on`：合併火車的開關。非空值優先於 `config.json` 裡的 `integration`。 |
| `STRAW_BOSS_DESK` | `1` 表示自己顯示頁面的桌面 shell：GUI 不開瀏覽器，合併火車除非你設為開啟，否則是關的。見[桌面模式](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#桌面模式up---dir)。 |
| `STRAW_BOSS_ASCII` | `1` 讓塔台的常駐 pane 只用 ASCII 繪製。`NO_COLOR` 與 `TERM=dumb` 會去掉它的顏色。 |

## 其他檔案

- **禪的音樂：** 音訊檔放在 `~/.pi/agent/straw-boss-music/`。見[瀏覽器檢視](/pi-straw-boss/docs/zh-tw/guide/browser-view/#禪)。
- **擴充套件寫入什麼：** 見[它寫入什麼](/pi-straw-boss/docs/zh-tw/reference/how-it-works/what-it-writes/)。
