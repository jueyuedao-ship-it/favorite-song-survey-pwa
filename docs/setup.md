# 配備とPCミラーのセットアップ

セットアップはこのプロジェクトのルートから行います。本物のクラウド操作はローカル実装・レビューの確認後に行い、Worker・D1・GitHub Pagesの実動確認を別途記録します。

## 1. 秘密入力と事前確認

`.local/setup.json` はGit管理外です。ローカルのエディターで次の項目を入力します。以下は値を示さない構造例です。

```json
{
  "admin_password": "<人が選んだ管理者パスワード>",
  "groq_api_key": "<Groq Freeのキー>",
  "tavily_api_key": "<Tavily Researcher無料枠のキー>"
}
```

Tavilyの項目が空欄なら、プロセス環境変数、次にWindowsの現在ユーザーの環境変数 `TAVILY_API_KEY` を内部で参照します。値をチャットへ貼らず、PowerShellの引数にも渡さないでください。既存の `.dev.vars` と `.env.local` はローカル試験専用として保ち、本番へコピーしません。

```powershell
npm.cmd ci
npm.cmd run setup:check
```

`setup:check` は秘密値を表示せず、設定の完備・Cloudflare認証・対象リソースの有無・Workersプランを返します。Cloudflare OAuthはインストール済みWranglerのOSキーチェーンから内部で取得し、子プロセス出力は画面へ流さず、Wranglerのディスクログとテレメトリーも無効にします。セットアップは本物のGroq/Tavilyへのリクエストを発行しません。各サービスの無料アカウントとQwenモデル利用の確認は配備前の実確認が必要です。

Workersプランの取得には読み取り権限が必要です。成功したアカウント購読一覧が空の配列の場合は、有料Workersを含む購読がないため既定のFreeと判定します。欠けた行・不正なラベル・APIの権限不足は `workers_plan:unknown` とし、Freeとは扱いません。一覧をすべて確認し、有料Workersが1件でもあれば不明な行の位置にかかわらずPaidを優先します。Cloudflareダッシュボードで **Workers Free** を事前に確認できた場合だけ、次のcloud実行に `-- --confirm-workers-free` を付けられます。有料Workersプランを検出した場合は、この指定があっても停止します。ツールに課金・購読を変更する処理はありません。

## 2. 新しいクラウド環境

```powershell
npm.cmd run setup:cloud
```

対象はWorker `favorite-song-survey-api` とD1 `favorite-song-survey` のみです。同名リソースがある場合、現在のアカウント・作業フォルダーの `.local/cloud-state.json` によってこのプロジェクトの所有が確認できなければ変更を止めます。既存の無関係なアプリには配備しません。

この処理は次の順番で行います。

1. Freeの確認と対象名の衝突確認を行います。
2. 人が選んだパスワードから `pbkdf2$100000$<salt hex>$<key hex>` 形式の検証値を作ります。独立したランダム同期トークンはローカルに置き、WorkerへはSHA-256検証値だけ送ります。
3. 新しいD1を作成し、所有情報をすぐ記録します。既存の確認済みD1は再利用し、リトライ時に新しいDBを増やしません。
4. リモートマイグレーションを適用します。種データは50個のタグだけで、デモ参加者・回答・架空の調査結果はありません。
5. 本番の公開設定でWorkerを配備し、秘密JSONを標準入力でWranglerへ渡します。CORSは `https://jueyuedao-ship-it.github.io` のみです。
6. 本番ヘルスの設定フラグと、人が選んだパスワードによる管理者ログインを検証します。ローカル開発用・統合試験用パスワードが拒否されることも確認します。管理者セッション値は表示・保存しません。

本番設定は `.local/wrangler.production.json`、秘密値は `.local/worker-secrets.json` と `.local/credentials.json` に保存します。これらをGitへ追加しないでください。途中失敗は私的なCLI出力を伏せて報告します。同じコマンドで確認済みD1と同じ同期トークンを使って再開できます。パスワードを変更した場合は黙って認証を変えず、明示的な秘密値の更新手順が必要です。

調査cronは `* * * * *`、1分ごとです。1回の起動はキューの1段階だけを進め、共有リース・有限のリトライ・Tavilyの使用予約と上限を維持します。Web検索・抽出・推論・カタログ・複数の情報反映には数分以上かかる場合があります。PC同期の間隔は別の5分です。

## 3. 新しいGitHubリポジトリとPages

公開先は `jueyuedao-ship-it/favorite-song-survey-pwa` です。GitHub CLIでこの名前が未使用であることを確認して新規作成し、このプロジェクトの `main` を送ります。既に存在する場合はREADMEと `web/index.html` を確認し、他のアプリを上書きしません。初回pushの時点ではPagesワークフローはAPI変数がないため公開に進みません。

本番APIの検証後、次を実行します。

```powershell
npm.cmd run setup:github
```

このツールもリポジトリ所有者・名前・README・HTMLを確認してから、公開してよい `VITE_API_BASE_URL` をリポジトリ変数へ設定します。値は `https://favorite-song-survey-api.<subdomain>.workers.dev/api/v1` の完全な形です。GitHub Pagesのソースを **GitHub Actions** に設定し、`Publish favorite song survey` ワークフローを再実行します。

CIの `VITE_BASE_PATH` は `/favorite-song-survey-pwa/` です。秘密値はGitHubやブラウザへ渡しません。CIはAPI URLの検査、Nodeテスト、型検査、Webビルド後に `dist/web` を公開します。Workerの配備はCIでは行いません。

配備後はPagesの成功だけで終えず、本番サイトのAPI接続・初回起動・Service Worker・回答・保存後の再読込・オフライン回答の再送を確認します。本物の調査結果の正しさ・無料枠でのCPU動作は別の実受入確認です。スマートフォンで試していなければ未確認と記録します。

## 4. PCミラーの設定とWindows登録

```powershell
npm.cmd run setup:collector
npm.cmd run collector:once
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-collector.ps1 -PlanOnly
```

`setup:collector` は検証済みの本番APIと私的な同期トークンから `.local/collector.json` を作ります。`-PlanOnly` はタスクXMLを表示し、登録は行いません。秘密値はXMLや引数に含みません。

実行確認が済んだら、現在ユーザーで登録します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-collector.ps1
```

登録内容は **現在ユーザーがログオンしているときのみ、最小権限、ログオン時と5分ごと、ウィンドウ非表示** です。管理者権限・パスワードの入力は要求しません。絶対パス・プロジェクト内の設定/DB/バックアップ・Python 3.11以降と `pythonw.exe` を事前検査します。PCは受信用ポートを開きません。

複数起動はファイルロックとタスクのIgnoreNewで防ぎ、1回の処理上限は15分です。`.local/collector-task.json` にこのユーザーのタスク名を記録します。OSが登録を拒否した場合は、権限エラーを安全な文章で報告し、UACを回避しません。手動の `collector:once` / `collector:watch` は引き続き利用できます。

タスクは設定済みPythonと私的設定を使って非表示で起動します。前回の安全な出力は `.local/collector-last.stdout` と `.local/collector-last.stderr` にあります。解除は次で行い、保存済みDB・バックアップは残します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-collector.ps1 -Uninstall
```

## 5. SQLiteの整合性と保存

`data/mirror.sqlite` は全18業務テーブル、通常列を持つ `v_*` ビュー、曲・回答者・クレジット・タグの結合ビュー、変更イベントを持ちます。行JSONとイベントJSONは情報を削らず保存するため、任意の調査メタデータも残ります。認証・操作ID・管理者セッションのテーブルは収集しません。同期トークンは業務DBへ書きません。

feedの最初のページで上限カーソルを固定し、続きも同じ上限まで読みます。ページ境界が元の業務トランザクションを分割できるため、すべてのページを一時テーブルへ永続化し、**上限まで揃ってから1回のSQLiteトランザクションで業務行・イベント・確定カーソルを反映**します。通信中断後は一時テーブルの位置から再開します。スキーマ違い・カーソル後退・破損イベントではDBをリセットしません。

削除行は墓標として残り、元の監査と訂正イベントも残ります。JSONの全フィールドを保つ一方、テーブル名・ビュー列名はローカルの固定許可リストだけを使います。[SQL例](../collector/queries.sql) は読み取り専用の接続で実行してください。

ACKは確定済み位置に1回だけ送信します。そのACK自体が同期状況と監査イベントを作るため、追加の固定上限を1回取得して反映し、二度目のACKは送りません。これで自己生成イベントの無限ループを防ぎます。`mirror_meta.cursor` は最新のローカル確定位置、`ack_cursor` はAPIが認めた最終成功位置です。後者が数イベント遅れることは通常の動作です。各取得範囲は1,000ページを上限とし、上限到達時は次回へ持ち越します。

バックアップはJSTの日ごとに `backups/mirror-YYYY-MM-DD.sqlite` を初回だけ作り、最新30日分の取得日を保持します。同じ日のスナップショットは追記や上書きをしません。SQLite backup APIで一貫したスナップショットを作成し、検査後に名前を確定します。WALファイルだけをコピーする方式は使いません。通信・ACKに失敗した日でも、それまでのローカル確定データのバックアップを残します。PCが停止している日のファイルは作られません。

DBを復旧する場合は収集タスクを停止してから、バックアップを別名で開いて整合性とカーソルを確認してください。リモートへ戻す機能はありません。APIが過去より小さいカーソルを返した場合は、自動で消去せず原因を調べます。
