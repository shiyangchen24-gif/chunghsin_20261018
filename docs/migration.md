# 舊資料盤點、映射與回復

## 為何使用 cs\_ 資料表

附件三份程式原本各有不同的 project URL，且舊打勾單使用巨型 key-value。尚未取得正式 schema introspection 結果前，直接修改既有 `customers` 或 `"Chunghsin_store"` 可能破壞仍在運作的舊站。因此新版以 `cs_` 業務分表及 RPC 做隔離導入，**不宣稱是既有 ERD 的原地遷移**。可重複執行的新 schema 已有本機測試，正式既有資料遷移仍須依盤點結果製作。

每張新版業務表每筆一份小型 `data`、獨立 `revision`、客戶代號與日期索引；報價明細一品項一列，不再把所有客戶報價放在首頁客戶 JSON。關聯的 `customer_code` 是 generated column 並有 FK；車輛 assignment 同樣有 FK。主檔代號不得依同名自動合併。

| 原有資料                                                                                  | 新版對應                                                     | 規則                                                       |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| customers.code / name / is_active                                                         | cs_customers.id / data.code / name / active                  | code 穩定；名稱只供顯示                                    |
| customers.quotation_settings                                                              | cs_profiles.data                                             | 先保留原備份，再拆設定                                     |
| quote_cycle / product_code_mode / notes / unit_category / quote_file_location             | cs_profiles.data.cycle / mode / notes / unit / file_location | cycle 轉為天數整數；未知值列待確認                         |
| mapping.dataStartRowIdx / columnMap                                                       | cs_profiles.data.mapping.start / columns                     | 0-based；舊 columnMap 可能是物件，須轉為完整欄位陣列並測試 |
| saved_records / quoted_prices.matched, unmatched                                          | cs_quote_items.data.item                                     | 逐筆保留中文鍵與原值；依 customer_code 關聯                |
| item_code_lookup                                                                          | cs_mappings                                                  | 每個客戶品名一列，不按全域同名合併                         |
| last*export*\* / export_status                                                            | cs*profiles.data.last_export*\* / exported                   | 匯出紀錄與日期保留；不根據檔名猜已成功匯出                 |
| master_items                                                                              | cs_master_items                                              | 料號穩定；未提供 spec_code 時不蓋空白                      |
| vehicles                                                                                  | cs_vehicles                                                  | id、car_no、notes；不自動合併疑似同一車輛                  |
| customer_aliases                                                                          | cs_aliases                                                   | id、customer_code、alias_name、created_at 全保留           |
| customer_vehicle_assignments                                                              | cs_assignments                                               | 有效起訖日、is_primary、vehicle_id                         |
| abnormal_reports.reason / issue_description                                               | cs_abnormal.data.reason                                      | 相同時採 reason，衝突時保留兩欄至人工確認                  |
| abnormal_reports.date / car_no / store / exchange_type / category / responsibility / note | cs_abnormal.data 同名鍵                                      | 原始店名／車號保留快照；不強制改舊文字日期型別             |
| handover_reports.content / handover_description                                           | cs_handover.data.content                                     | 有衝突不覆蓋；需確認                                       |
| zhongxin_v4 姓名 key                                                                      | cs_orders，每日＋customer_code                               | 用 code/alias 明確對應，未知或同名列待確認                 |
| zhongxin_hist_v4                                                                          | 舊資料完整歸檔＋逐日 cs_orders                               | records、editLog、clearedAt、未知欄位完整保留在歸檔        |
| zhongxin_order_v1                                                                         | cs_groups 的排序設定                                         | 原排序及群組清單須保留；本版尚未提供舊排序匯入器與拖曳 UI  |
| zhongxin_notices_v1                                                                       | cs_notices                                                   | 內容、作者、日期保留                                       |
| zhongxin_manual_v1                                                                        | cs_manual                                                    | 人工數據保留，不覆蓋真實叫貨事件                           |
| zhongxin_warn3_v1                                                                         | 原樣歸檔／待明確轉換                                         | 本版三天未叫是伺服器查詢推導；舊人工覆寫尚未自動套用       |
| zhongxin_store / Chunghsin_store                                                          | 原樣保留                                                     | 先查真正大小寫、來源，不 rename、不 drop                   |

## 執行步驟

1. 舊專案做資料庫備份，另匯出所有 key-value JSON（包含未知欄位），以唯讀位置保管；記錄匯出時間與各表精確筆數。
2. 執行 `00_inspect.sql`；核對資料型別、大小寫、舊日期格式、重複代號、失效關聯、同名客戶及 RLS。
3. 在測試專案部署 `01_workspace.sql`，建立測試成員；先載客戶、車輛，再 aliases／assignments，最後各業務資料。
4. 先 dry run 列出每一個姓名 key → code 的映射；不明確者不得寫入。CSV 客戶匯入只增加新代號，不覆蓋既有主檔，不能取代完整遷移。
5. 舊欄位與新欄位數值逐筆比對，對照紀錄含來源 project／table／key／row id；未知欄位保留完整原始 JSON。所有舊報價單需各選代表檔重跑，核對 Excel 13 欄及無貨號三表頭。
6. 新站使用新資料，舊站保留唯讀；不能讓舊站的全表輪詢／巨型寫入繼續影響新流程。新版目前不提供雙向回寫舊 schema；切換期間不得混用新舊站共同編輯。
7. 管理員確認筆數、金額、店家／車輛快照及歷史核對後再切換。

## 回復

因未改動舊表，切換驗收失敗時先停用新站寫入，保存新站增量事件與 `cs_` 全部資料備份，再回到舊站。新站上線後產生的資料不可直接丟棄，需依對照人工回補。不要以 DROP TABLE 作回復，不移除未知的 publication／policy。回復本身也需要核對新舊寫入分界。

## 尚未完成的舊版專用行為

- 舊版手動趨勢圖完整樣式、可拖曳群組排序、三天未叫人工清單、使用者圖示偏好，尚未逐項搬移；對應原始資料不能丟棄。
- 客戶別名可新增、刪除並參與候選搜尋；有效車輛關聯在客戶儲存時保留歷史，但尚未提供完整的配送歷史維護畫面。
- 已提供週期／單位篩選、到期日顯示、對照待設定篩選、批次修改、批次停用及清除報價紀錄；到期日範圍篩選與匯出歷史獨立清單尚未提供。批次停用保留資料，不做不可回溯的硬刪除。
- 異常／交接採列下展開並保留草稿；列印採已提供文字規格，尚無真實 Excel 範本可逐格目視對照。

這些差異是本版明確列出的後續整合項目，不應把此版說成全部舊版業務規格已完全驗收。
