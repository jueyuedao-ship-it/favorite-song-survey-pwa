# 検証記録

更新日：2026年10月3日。ソース、検証用クラウド、本番データ、未確認の実機範囲を分けて記録します。

- 公開先: https://jueyuedao-ship-it.github.io/favorite-song-survey-pwa/
- 本番API: https://favorite-song-survey-api.tyabanspark.workers.dev/api/v1
- 最終統合コード: 7bf76bd。重要6件・軽微2件を1回の修正で対応し、限定再レビューは8/8解消・新規Critical/Important/Minor0。

## 自動検証とWindows実行

[GitHub Actions 37078747687](https://github.com/jueyuedao-ship-it/favorite-song-survey-pwa/actions/runs/37078747687)で10ファイル・250テスト、型検査、Webビルド、Pages配備が一括成功。WindowsのPython30件・型検査・Worker/Webビルドも成功。Windows Node全体は249件成功・1件失敗後、同時刻テスト入力を修正して対象1件が成功した記録を保持し、CIの250件一括成功を最終全体証拠に採用しました。

PowerShell5.1の設定パス省略PlanOnlyはexit0・LeastPrivilege・ログオン時/PT5M・非表示。既存タスクXMLと所有情報を変えず、標準入口が機能することを確認しました。

## 実クラウドと4曲の実解析

新規所有Worker/D1をWorkers Freeへ配備。healthのadmin/sync/groq/tavily/research_runnerは全true。本物の管理者パスワードのログインと開発用パスワードの拒否を確認。課金・購読・購入・追加権限の変更はありません。本番に検証用参加者・回答は入れていません。

通常1分cronの実Groq4要求・Tavily15クレジットで10確認済みクレジット、2確認済み歌声タグ、5出典、4解析結果を保存し、保持引用とnativeauthorを照合しました。

| 曲 | 保存した役割 | 確認済みタグ |
| --- | --- | --- |
| 風のたより | ボーカルisui、作曲tazuneru、投稿tayori | 人の歌声 |
| テレパシ | ボーカル初音ミク、投稿DECO*27 | なし |
| Overdose | 作曲natori、投稿なとり / natori | なし |
| スピカ | ボーカルNinjin、作曲Nayutan Seijin、投稿ロクデナシ | 人の歌声 |

全4ジョブは完了段階のneeds_review/UNCONFIRMED_CLAIMS。DECO*27の作曲、Overdoseの歌唱、発表名義・別表記、根拠不足のジャンル・雰囲気等を確認済みにしていません。部分情報を保持し、残る項目は管理者が根拠を確認して訂正できます。音源を聴いた推測は行っていません。

## 公開Chromeの実操作（独立した検証API）

同じGitHub Pagesオリジン・ベースパス・最終コードで、本人登録、保存、再読み込み/別タブ後の本人復元、本人編集/削除、特定済み版変更、任意期間、件数/割合選択を確認しました。別クライアントの記録日変更後は画面/条件/再読み込みを変えず集計0→1へ自動反映。2タグ100%+100%の入力は検証用手動データで、実音楽解析の証拠とは分けています。

API到達不能で送信待ち1を保存し再読み込みでも保持。閲覧名を別人へ変え、復旧後の次回起動で元の本人へ1件、閲覧名の人へ0件。再読み込みしても1件。さらに同版/同日2件+後続別版1件をqueue3にし、復旧後2成功/重複1保持。失敗情報は再読み込み後も残り、明示削除確認/取り消しを確認しました。重複原因を監査付きの論理削除で解消し、元の内容・本人・操作で明示再試行してqueue0。

管理者ログイン/ログアウト、参加者名/特定曲名の検索、曲名・操作者・JSTの変更履歴、旧Service Worker更新通知からの更新/再読み込みを確認しました。公開工程では接続先だけを本番へ切り替え、同じChromeで新アセット・旧Worker更新・API接続・検証用本人/queueの分離を照合し、公開SHA/アセットを最終受入報告に記録します。

## PCミラー・日次バックアップ

本番data/mirror.sqliteを固定watermark778と照合し、全18表/778イベントJSONが一致、integrity_check=ok。10credit/2tag/5source/4resultを結合ビューで読み取り、参加者/回答0を確認。現在ユーザー・最小権限・非表示・ログオン時/5分タスクは自動実行LastTaskResult0。10月2日/3日の実日次バックアップは両方整合性ok、2日の初回snapshotは上書きされていません。30取得日保持はPythonテストで確認。

検証専用APIでも24項目/49要求（本人権限、4記録/2支持者、単回招待/失効、再送/版競合、削除除外、元履歴+有効訂正）と上限0時の回答保持を確認。検証ミラーは18表/130rawイベント一致、中断cursor0→再開、反復ACK2イベントだけの進行、読み取り専用書込拒否、同日backup不変を確認しました。

## Free計測と未確認の範囲

GraphQLの実サンプルは検証69/本番143要求、runtime errors0。時刻バケット最大P99は42.427ms/36.998ms（microsecondsから換算）。10msを超えるサンプルもあり、全要求10ms以下を保証しません。イベント別CPUは範囲により403で、追加権限/有料設定は要求していません。

公開Chromeのqueue実験はAPI到達不能で、全インターネット切断ではありません。以前の実ローカルChromeでは所有確認済み配信元4173/API8791を両方停止し、SWから画面/本人/queueを復元し、両方復旧後HTTP1回答を確認しました。

Android Chrome/iPhone Safariの物理実機、PC Chrome標準インストールUI、長期ストレージ削除/バックグラウンド停止は未確認。レスポンシブ実装・manifest/icons/SW検査と区別します。