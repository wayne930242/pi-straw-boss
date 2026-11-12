---
title: 快速開始
description: 四個步驟，看網運作起來。
---

1. **在 Herdr 分頁裡開 pi，並交給它工作。** 它會自己加入網。工作變多時，它會自己升任為該分頁的主智慧體，同時開出該工作區的塔台。輸入 `/boss` 可以由你自己接手成為該分頁的主智慧體。
2. **輸入 `/boss status`**，查看每個分頁的主智慧體與各座塔台。
3. **輸入 `/boss tower`**，開啟該工作區的塔台並查看它的儀表板。智慧體開始互相衝突時，它也會自己開。你不需要對它說話。
4. **在任何 session 輸入 `/boss gui`**，在瀏覽器裡看整張網。

![終端機裡塔台的儀表板：這張網的分頁、智慧體與子智慧體，以及其他塔台](/pi-straw-boss/docs/img/tower-dashboard.png)

## 塔台自己運作

sb server 的塔台服務預設是開的：它為事件醒來，並保管一份小小的記憶，所以你不必對它說話。
`/boss tower <prompt>` 會寫給它，`/boss memory` 會顯示它的記憶，在[設定](/pi-straw-boss/docs/zh-tw/reference/configuration/)裡設定 `towerModel` 可以給它較輕量的模型。
run 怎麼運作、交接筆記是什麼，見[塔台怎麼運作](/pi-straw-boss/docs/zh-tw/guide/concepts/#塔台怎麼運作)。

## 下一步

- [概念](/pi-straw-boss/docs/zh-tw/guide/concepts/)：誰是成員、主智慧體、塔台與主塔台，以及每一種智慧體與 run。
- [瀏覽器檢視](/pi-straw-boss/docs/zh-tw/guide/browser-view/)：地圖、通訊畫面、警示與禪檢視。
- [指令](/pi-straw-boss/docs/zh-tw/reference/commands/)：每個工具與 `/boss` 指令。
