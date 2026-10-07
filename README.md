# Min-WLYT-Plus

CG / YouTube web app.  
「Min-wlyt-Plus」は、YouTube や動画視聴をより快適にするための Web アプリです。  
ブラウザからすぐにアクセスでき、PC・スマホ問わず軽量に動作することを目指しています。

---

## 特徴

- **軽量:** HTML + JavaScript ベースのシンプル構成
- **ホスティングしやすい:** Vercel / Render などの PaaS に対応しやすい構造（Railway は設定方式の確認が必要）
- **Node.js 対応:** Node.js 24.x を推奨。`index.js` + `Procfile` で起動可能
- **設定ファイル付き:** `render.yaml` / `railway.json` などのデプロイ設定ファイルを同梱

---

## デプロイ

デプロイボタンを用意しています。各PaaSの現在の仕様・利用規約を確認してから利用してください。

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/wl-unblock/MIN-wlyt-Plus)

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/wl-unblock/MIN-wlyt-Plus)

### Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?templateUrl=https://github.com/wl-unblock/MIN-wlyt-Plus)

---

## 必要要件

- **Node.js** (推奨: 24.x LTS)
- **npm**（`package-lock.json` を使用）

---

## ローカル開発

```bash
# 依存関係のインストール
npm ci

# 開発サーバー起動
npm start
# または
node index.js
```

### 安定性・デプロイの補足

- `npm ci` はコミット済みの `package-lock.json` に従って依存関係をインストールします。
- `npm test` で、ランタイム指定・ヘルスチェック・PWAの配信パスに関する静的テストを実行できます。
- ホスティングのヘルスチェックには `/healthz` を指定してください。このエンドポイントは外部APIに依存せず、HTTP 200を返します。
- Railwayの `railway.json` は従来のConfig-as-Code方式です。新規サービスでは使用できず、既存設定も2026年12月1日までに移行するよう案内されています。新規デプロイ前に[Railwayの現行設定ガイド](https://docs.railway.com/config-as-code/reference)を確認してください。

---

## 動画ページ（`/video/:id`）のストリーム取得

取得元は優先度（ティア）付きで、**上位ティアはすべて同時に**走らせます。

| ティア | 取得元 | 内容 |
| --- | --- | --- |
| 0（最優先） | `/api/video/:id`（Min-Tube API 一覧）、`/sia-dl/:id` | 直接再生できる googlevideo URL。1つでも成功した時点で即解決 |
| 1（予備） | `/rapid/:id` | 上位が 600ms 以内に答えなかった時だけ走る（回数制限対策） |
| 2（最終手段） | `/ai-fetch/:id` | 同上。埋め込み URL になることがある |

- 成功結果とコメントはメモリキャッシュするので、同じ動画への再訪問（戻る・関連動画の行き来）は即描画されます。
- コメントは取得できなくてもページは出します（打ち切り 2.5 秒）。取り直しを妨げないよう 0 件のときはキャッシュしません。
- プレイヤーは**サーバー側で描画**します。クライアントの `window.onload` や追加 fetch を待たないため、HTML の解析中にバッファリングが始まります。
- 選んだ動画サーバーは cookie(`playbackMode`) にも保存されるので、次に開く動画ページではそのモードのプレイヤーがそのまま描画されます。
- 上流 API の一覧 URL は環境変数 `MIN_TUBE_API_LIST` で差し替えられます（セルフホスト・テスト用）。

## メタデータ（検索 / トレンド / 関連動画 / コメント）の高速取得

ストリームとは別経路です。**`player` エンドポイントは一切叩きません。** 再生用 URL は従来どおり外部 API（Min-Tube API 一覧）から取得します。

従来は `youtube-search-api`（公開ページのスクレイピング）に頼っていて、関連動画を出すだけで最大3往復かかっていました。
`lib/yt-innertube.js` は YouTube の内部 API（`youtubei/v1`）を直接叩き、**1往復でまとめて**取ります。

| エンドポイント | 従来 | 追加後 |
| --- | --- | --- |
| `/api/search` | 公開ページ取得 + 解析 | `search` 1往復（2回目以降はキャッシュで0往復） |
| `/api/trending` | キーワード検索 × 2本 | `browse` 1往復 |
| `/api/recommendations` | キーワード検索 × 3本 | `next` 1往復（動画の関連動画をそのまま利用） |
| `/api/comments/:id` | 外部 API を順に試行 | `next` ＋継続トークン（壊れたトークンは送らない） |

高速化の要点（`lib/ttl-cache.js` と組み合わせて実現）:

1. **並列ヘッジ** — まず上位クライアントへ即発行し、400ms 以内に決着しなければ予備クライアントも並走させ、速い方を採用します（負けた経路は中断）。
2. **visitorData を待たない** — 未取得でもリクエストを止めず、裏で1本だけ取得して次回以降に使います。応答に含まれていればそこから回収するので追加往復はゼロです。
3. **キャッシュ + single-flight** — 同じキーの同時リクエストは1往復に束ね、結果を TTL で保持します。
4. **継続トークンの正規化** — YouTube が返す二重エンコード済みトークンを剥がし、壊れたトークンは上流へ送らず静かに終端扱いします（`400 → 続きが永遠に読めない` を構造的に防止）。

すべて**追加**であり、置き換えではありません。高速経路が失敗・0件のときは従来の取得処理へフォールバックします。

- 無効化: 環境変数 `YT_META=0`
- デバッグログ: `YT_META_DEBUG=1`（`[yt-meta]` ログと `/api/meta-stats` が有効になる）

**実機検証は必須です**（開発環境から YouTube へ到達できないため、単体テストはモック応答に対するものです）:

```bash
node scripts/verify-meta.js https://your-app.example.com
# 動画IDを指定する場合
node scripts/verify-meta.js https://your-app.example.com --video=dQw4w9WgXcQ
```

ログの読み方・症状別の対処・パーサ追従の直し方は [`docs/metadata-verification.md`](docs/metadata-verification.md) にまとめています。

### Service Worker / キャッシュの方針

動画ページ（`/video/*`）と `/api/*`、人間確認ページは `Cache-Control: no-store` で返し、Service Worker でも保存しません。
キャッシュすると「認証ページが保存されてリロードループになる」「失効したストリーム URL で再生できない」といった不具合になるためです。
静的アセット（JS / CSS / 画像 / プロキシのフロントエンド）はこれまで通りキャッシュ優先です。

---

## 更新履歴(min-wlyt-plus)
### ver1.0.7
 - ストリーム以外のメタデータ（検索 / トレンド / 関連動画 / コメント）に、`youtubei/v1` を直接叩く高速経路を追加（`lib/yt-innertube.js`）。関連動画が最大3往復→1往復。
 - TTL + LRU のキャッシュと single-flight を追加（`lib/ttl-cache.js`）。2回目以降は往復ゼロ。
 - visitorData を待たない設計（初回リクエストを1往復もブロックしない）と、400ms で予備クライアントを並走させる並列ヘッジを追加。
 - コメントの継続トークンを正規化し、二重エンコード由来の 400（続きが読めない）を構造的に防止。
 - 高速経路は「追加」であり、失敗・0件のときは従来の取得処理へフォールバックする。`YT_META=0` で無効化可能。
 - `public/home.html` のカード描画で、外部由来のタイトル・チャンネル名・アバターURLをエスケープ/検証するように修正。
 - `/api/search` が取得失敗時に 500 の HTML を返さず、0件の JSON を返すように修正。
 - メタデータ取得の単体テスト11件と、高速経路が player を叩かない／従来経路が残っていることを確認する静的テストを追加（`npm test`）。

### ver1.0.6
 - ストリーム取得を並列レース化し、最速の取得元が勝つように変更（旧実装の ai-fetch 2秒待ちと rapid の直列フォールバックを廃止）。
 - ストリーム・コメントのメモリキャッシュを追加し、同一動画の再訪問を高速化。
 - プレイヤーをサーバー側で描画する方式に戻し、`window.onload` 待ちと再生前の追加 fetch を廃止。
 - `/video/*` と `/api/*` の人間確認（5秒の認証ページ）を廃止し、動画ページへ直接遷移できるように修正。
 - Service Worker の cache-first を廃止（動画ページ / API / 認証ページは no-store）。認証ページがキャッシュされて遷移できなくなる不具合と、ハブ画面に差し替わる不具合を修正。
 - タイトル・説明・コメントの HTML/JS エスケープを追加し、上流データで動画ページが壊れないように修正。
 - ストリーム取得・動画ページ遷移の回帰テストを追加（`npm test`）。

### ver1.0.5
 - Elixir-network、stream-proxy、nodeproxyを修正。
 - index.jsからwispserverを建て、localhostへのリクエストも可能にする。
 - 依存関係の整理
 - `/healthz` を追加し、Render／Railwayのヘルスチェックを外部サービスに依存しないエンドポイントへ変更。
 - PWAのmanifest・Service Worker・アイコンの配信ルートを修正し、起動先を`/youtube-pro`に統一。オフライン時のフォールバックとキャッシュ更新範囲も見直し。
 - Node.js 24の指定を`package.json`・`.nvmrc`・Render／Railway設定で統一し、デプロイ時の依存関係インストールを`npm ci`に変更。
 - 起動・ヘルスチェック・PWA設定を確認する静的テスト5件を追加。
 - プロキシ／フィルター回避ロジックは変更なし。

### ver1.0.4
 - Elixir-networkでのnode errorを修正。
 - 漫画raw・anime・映画は著作権違反ページ（dmca）に転移するように修正。（これによりrenderやrailwayにデプロイした際にbanされるリスクが低くなります、あとねむいが作ったやつ普通に犯罪だからこっちgithubアカウントとかbanされたらだるい。minoには許可とった。）

### ver1.0.3
- Elixir-networkでの漫画、映画が確実に使えるように調整
- WOOLsite追加
- educationパラメーターの修正
- LICENSEを更新
- package.jsonなどでの名称をmin-wlyt-plusに更新。
- 偽造ページなどのURLをこのリポジトリ内に移動することで、別のリポジトリへの依存をできるだけ減らす。
- 一応typescriptとreactにも対応させた。

## 更新履歴(min-tube-pro)
### ver1.4.9
- Elixir-networkを利用した映画を修正、アプリを使えるように改良
### ver1.4.8
- gameのランキング微調整
- チャットを追加、ぶっ壊れる気しかせんがな(
### ver1.4.7
- webLLMを使用してAIをそのデバイスに建てて使えるように<br>
- ビデオ通話をできるように<br>
- Elixir-Networkを利用した漫画と映画鑑賞<br>
- gameの人気順の可視化
### ver1.4.2
- 人気ホラーゲーム「R.E.P.O」をはじめ、ブロスタ、ダダサバイバー、サンズ戦、ジオメトリーダッシュ、あつ森、クッキークリッカーなどの人気ゲームを追加(「R.E.P.O」が、壊れてるのは気のせい、そうだ気のせいだ）
- クオリティが極限まで高いゲームをその他10個ほど追加
- 動作しなかったゲームの修正
- 動画サーバー Elixir をスマートフォンからでも使えるように強化
- 新しいプロキシ「GUST」を追加

### ver1.4.1
- Claude が無料で使えるように変更（認証が必要です）
- Portable 版のマインクラフトを追加
- ショート動画の埋め込み視聴に対応し、ショートの閲覧が可能に
- 新動画サーバー Elixir-Network を追加。Wisp サーバーの最適化により動画の読み込みを高速化

### ver1.4.0
- Elixir-Network と統合（詳細は[Elixir-Network について](#elixir-network-について)を参照）

### ver1.3.5
- Abyss V5 と統合（詳細は[Abyss V5 について](#abyss-v5-について)を参照）
- アニメ視聴ページへのルートを修正

### ver1.3.0
**新機能**
- ホーム画面で「ホーム画面に追加」することで擬似アプリ化（Apple のみ）
- アニメ視聴ページを追加

**MINTube の変更点**
- サムネイル取得方法の切り替えが可能に
- ショート動画の視聴に対応（失敗することがあります）
- 検索候補を表示

**ゲーム関連の変更点**
- ゲームのサムネイルを追加（順次追加）
- 複数のゲームを追加
- ゲーム一覧の表示方法を切り替え可能に

### ver1.2.4
- ゲームを6つ追加
- ゲームを A〜Z 順で読み込むように変更

### ver1.2.3
**新機能**
- チャンネル登録機能を追加
- チャンネル登録や閲覧履歴からホームの動画が変わるように変更

**バグ修正**
- 設定で GoogleVideo 以外に設定したとき、再生時に一瞬読み込まれてしまう問題を修正
- アカウントページ以外でアカウント画像が表示されない問題を修正
- ホームで下スクロールしても新たなコンテンツが読み込まれない問題を修正

**変更点**
- ゲームを1つ追加

### ver1.2.2
- しあtube を追加
- 公式URL一覧に応答速度を表示

### ver1.2.1
- ゲームを3つ追加
- wista を追加

### ver1.2.0
- 視聴履歴を追加
- 高評価した動画の一覧を表示可能に
- 個人用の再生リストを追加
- デザインを YouTube 風に変更
- モバイル UI に対応（MIN-Tube-Pro のみ）
- チャンネル閲覧を強化
- ゲームを2つ追加

### ver1.1.1
- MIN-Tube-Pro でライト / ダークモードの切り替えが可能に
- 設定から再生方法を変更可能に
- チャンネル閲覧に対応（テスト段階）
- ゲームを6つ追加

### ver1.1.0
- 複数のゲームを追加
- MIN-Tube-Pro のホーム画面を見やすく変更

### ver1.0.4
- コメントが表示されないバグを修正
- Youtube-search-api で動画IDを検索し、タイトルとチャンネル名を取得する方式に変更

### ver1.0.3
- タイトルとチャンネル名の取得を自動化し、読み込みを高速化

### ver1.0.2
- siawaseok 様の API と MIN-Tube2 の API を `Promise.any()` で並列取得する方式に変更
- どちらかの API が落ちていても取得できるため、Invidious 依存を排除し、動画メタデータ取得の成功率が大幅に向上

### ver1.0.1
- YouTubeEducation の埋め込みパラメータを woolisbest 様と siawaseok 様の GitHub リポジトリから自動取得する方式に変更
- 手動管理が不要になり、常に最新の Education 用パラメータを反映可能に

---

## 技術詳細

### Elixir-Network について
rhenryw が作成した embeddr という静的なプロキシです。UV の bare サーバーは使わず、ランマーヘッドや Scamjet に近い Wisp というサーバーを使用しています。多くのサーバーを経由するため、今のところ落ちる心配がありません。

- サーバー: `wss://wisp.rhw.one/` に接続できた場合のみ YouTube 動画を再生可能
- エンドポイント: `/embed.html#URL` （`/proxy/embed.html#URL`）であらゆるウェブサイトの検閲を回避できます

#### 開発者向け 技術的な概要
静的なプロキシは多くの場合、コード内で直接ルートを指定し、そのままのパスでファイルへ接続します。そのため、自分のプロジェクトにプロキシを追加しようとすると `Cannot get error` が発生することがあります。これを回避するには、`index.js` 側でパスを書き換え、正しいディレクトリ内のファイルを返すように指示する必要があります。

MIN-Tube-Pro では以下のような技術を使用しています。

```js
const PROXY_ENDPOINTS = [
  'prxy',
  'baremux',
  'epoxy',
  'libcurl',
  'register-sw.mjs',
  'uv'
];
app.use('/proxy', express.static(PROXY_DIR));

app.use((req, res, next) => {
  const fileName = req.path.replace(/^\//, '');

  if (PROXY_ENDPOINTS.includes(fileName)) {
    const targetPath = path.join(PROXY_DIR, fileName);

    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile()) {
      return res.sendFile(targetPath);
    }
  }

  next();
});
```

エンドポイントを絞って関数を制限することで、サーバー負荷を減らせます。

### Abyss V5 について
もともとは jacksoncraft859 が作成した静的な UV プロキシです。bare サーバーが動かなくなっていたため、dinguschan-owo のサーバーを組み込んで再構成しました。デザインやバグ修正は MIN-Tube-Pro に搭載するために改変されています。  
このプロキシを単体で利用したい場合は、以下のリポジトリを推奨します。  
https://github.com/mino-hobby-pro/UV-Static_Netlify

---
## 開発メンバー

 - <a href="https://github.com/woolisbest-honke">woolisbest</a>  
 - <a href="https://github.com/mino-hobby-pro">mino</a>  
 - <a href="https://github.com/myproxy0108-prog">ねむい</a>  
 - <a href="https://github.com//raku-ringo">raku-ringo</a>  
 - <a href="https://github.com/Sou930">Sou930</a>  
 - <a href="https://github.com/KA1121Studio">KA1121Studio</a>  
 - kaki riki 

---

## 謝辞

以下の開発者・プロジェクトに感謝します。

- mino-hobby-pro
- dinguschan-owo
- jacksoncraft859
- siawaseok
- その他、本プロジェクトを支えてくださったすべての方々

---

<div align="center">

### Min-WLYT-Plus™

© 2026 <a href="https://github.com/woolisbest-honke">woolisbest</a>
All rights reserved.

</div>
