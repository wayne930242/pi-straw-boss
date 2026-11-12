---
title: 手機與遠端存取
description: 透過你的 tailnet 或同一個 Wi-Fi，用手機連到瀏覽器檢視，並保持配對。
---

瀏覽器檢視能在手機上使用：地圖、單位的通訊畫面、警示與禪都適應窄螢幕，手機回答智慧體等待的事，和桌機一樣。
手機有兩種方式連到頁面。

<p align="center"><img src="/pi-straw-boss/docs/img/gui-phone-map.png" width="220" alt="手機上的地圖，附標題列與各基地的 ⋯ 選單"> <img src="/pi-straw-boss/docs/img/gui-phone-comms.png" width="220" alt="手機上單位的通訊畫面：記錄占滿螢幕"> <img src="/pi-straw-boss/docs/img/gui-phone-zen-item.png" width="220" alt="手機上只有一個項目的禪檢視"></p>

## 透過你的 tailnet

`/boss gui remote` 用 `tailscale serve` 在你的 tailnet 上提供頁面，絕不使用 Funnel。
掃它印出的 QR code，就能配對手機。
遠端存取會在重新啟動後維持開啟，直到 `/boss gui remote off`。

**把它安裝成 app。**
頁面可以安裝成 app（加入主畫面，或 Chrome 的安裝），入口是 `https://<this machine>.<tailnet>.ts.net:8443/sb-app/`。
在沒有配對的情況下開啟時（換了新 token 之後，或在 iOS 上，因為 app 有自己的 cookie），app 會要求輸入 `/boss gui remote` 印在 QR code 下方的**配對碼**。
配對碼是 8 個字元，十分鐘內只能用一次，輸錯五次就作廢。

## 在同一個 Wi-Fi 上

`/boss gui lan` 讓同一個 Wi-Fi 上的手機不用 Tailscale 就能連到頁面。
在你開啟之前它是關的。

這台電腦會在告知你風險之後，自己產生憑證。

:::caution
任何人只要從這台電腦複製到憑證的金鑰，就能對你的手機冒充成私有網路的網站（你的路由器頁面、NAS），直到你從每支手機移除該憑證為止。
請在手機的熱點上使用，或在讓手機直接連到這台電腦的 Wi-Fi 上使用。
:::

1. 每支手機安裝一次憑證。
2. 用 QR code 或輸入配對碼配對。
3. 每支新手機都要由你在這台電腦上輸入它顯示的號碼來允許。

`/boss gui lan off` 關閉它；已配對的手機維持配對。
`/boss gui lan reset` 產生新憑證，並問你要怎麼處理配對；不論哪種，每支手機都要移除舊憑證並安裝新憑證：

| 選擇 | 何時 |
| --- | --- |
| 保留配對 | 舊憑證即將結束，或電腦改了名 |
| 解除每個 Wi-Fi 裝置的配對 | 金鑰或手機可能被偷了 |

## 配對與 token

頁面的位址帶著一個隨機 token。
token 在重新啟動、升級、當機與重新開機之後都會保留，所以開著沒關的頁面會自己重新連線，手機也維持配對（自最後一次使用起 90 天）。
新 token 只會來自 `/boss gui rotate`、遺失或損毀的 `gui-secrets.json`，或下次啟動時 port 已被占用；之後每支手機都要重新配對。

保留 token 是有代價的：在當機或重新啟動的空檔綁定該 port 的這台電腦上的另一個帳號，能看到開著的頁面送出的內容。
遇到你不信任的空檔之後，請輪替 token。

- `/boss gui devices` 列出已配對的手機；`/boss gui unpair <id|all>` 解除它們的配對。
- 設定頁的**手機與裝置**區塊做的是同一件事。

## 手機不能做什麼

已配對的手機可以回答問題、寫給 session，並開啟、關掉、收起與接回單位。
有些選擇只屬於這台電腦自己的頁面：允許新手機、決定 Straw Link 的加入請求、`/boss gui rotate`，以及所有祕密。
規則見[遠端存取](/pi-straw-boss/docs/zh-tw/reference/how-it-works/browser-view/)。
