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
| `integration` | `on`（在 `STRAW_BOSS_DESK=1` 下為 `off`） | `off` 會在這台電腦上關掉[合併火車](/pi-straw-boss/docs/zh-tw/guide/merge-train/)。開啟是 `on`、`true`、`1` 或 `yes`；關閉是 `off`、`false`、`0` 或 `no`。任何其他值，以及讀不到的檔案，都會把它關掉並發出通知。 |
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
