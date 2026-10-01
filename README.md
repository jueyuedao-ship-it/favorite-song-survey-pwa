# 好きな曲アンケート / favorite-song-survey-pwa

好きな曲を1日ごとに回答し、みんなの人気曲と自分の音楽の傾向を調べる日本語PWAです。まず回答画面が開き、元の曲・カバー・リミックス、歌唱者・作曲者・公開名義・投稿者、根拠付きのタグを分けて記録します。

回答者は端末の秘密トークンで識別します。画面の名前を変えるだけでは他人の回答を編集できません。管理者だけがパスワードでログインし、招待・端末追加・失効・データ訂正・監査履歴を扱えます。新しい回答はオフラインでも端末に残り、次の起動で元の回答者として送信します。

ランキングは回答件数で集計します。たとえば同じ曲をAさんが3日、Bさんが1日回答した場合は4件・支持者2人です。日付は日本時間、週は月曜始まりです。

## ローカル開発

Node.js 24、Python 3.11以降、Windows PowerShell 5.1またはPowerShell 7を使用します。

```powershell
npm.cmd ci
npm.cmd run db:migrate:local
npm.cmd run dev:api -- --port 8791
```

別のターミナルで公開してよい開発用API URLを設定します。

```powershell
$env:VITE_API_BASE_URL = 'http://127.0.0.1:8791/api/v1'
npm.cmd run dev:web
```

ローカルAPIの設定は `.dev.vars.example` を参考に専用の `.dev.vars` へ書きます。既に設定がある場合は上書きしないでください。Web検索・AIの本物のキーがなければ調査待ちのままになり、架空の調査結果は生成しません。

## 検証

```powershell
npm.cmd test
npm.cmd run test:collector
npm.cmd run typecheck
npm.cmd run build
```

Worker/D1・フロントエンドのテストと、Python標準ライブラリで動くPCミラーのテストがあります。PCミラーはHTTPフィクスチャ、通信中断、SQLiteの再起動、削除・監査訂正、30日分のバックアップ、Windowsタスク設定の生成を検証します。これらは実際のクラウド配備や本物の調査精度の確認とは別です。

## 公開とPC保存

実際の配備手順は [docs/setup.md](docs/setup.md) を参照してください。Cloudflare Workers Free + D1、GitHub Pagesを使い、課金プランへの変更は行いません。GitHubのリポジトリ変数 `VITE_API_BASE_URL` に、本番Workerの完全な `/api/v1` URLを設定します。URLが未設定・ローカル用の場合、Pagesの公開ワークフローは失敗します。

本物のキー・管理者パスワードはGit管理外の `.local/setup.json` にのみ入力します。セットアップツールがソルト付き検証値を作成し、Workerには検証値だけを送ります。秘密キーを `VITE_` 変数やActionsへ渡さないでください。

PCミラーはクラウドから読み取り、一方向に `data/mirror.sqlite` へ保存します。Windowsのログオン時と5分ごとに同期し、日ごとのSQLiteバックアップを最新30日分保存します。SQLで分析する場合は読み取り専用で開き、[collector/queries.sql](collector/queries.sql) の例を使用できます。PC側からクラウドへのデータ編集や、PCへの受信用ポートはありません。

調査キューは1分ごとに1つの小さな段階を進めます。Web根拠の確認・AI推論・候補や情報の反映には複数回の実行が必要です。Tavilyの月間上限は初期800クレジットで、無料枠の確認と使用予約を行います。管理者の訂正は自動調査で上書きしません。

[API契約](docs/api-contract.md) と [検証記録](docs/verification.md) に仕様・検証範囲を記録しています。
