# メタデータ高速経路の実機検証

`lib/yt-innertube.js`（`youtubei/v1` 直結）は、**開発環境から YouTube へ到達できないため実機での動作確認が必須**です。
この手順で「効いているか」「ブロックされていないか」を判定します。

**ストリームには影響しません。** 再生用 URL は従来どおり外部 API から取得します。
検証対象は 検索 / トレンド / 関連動画 / コメント だけです。

---

## 1. 準備

デプロイ先の環境変数に次を追加します（検証が終わったら外して構いません）。

```
YT_META_DEBUG=1
```

| 環境変数 | 既定 | 説明 |
| --- | --- | --- |
| `YT_META` | `1` | `0` で高速経路を完全に無効化（従来経路のみ） |
| `YT_META_DEBUG` | 未設定 | `1` で `[yt-meta]` ログと `/api/meta-stats` を有効化 |
| `YT_META_PROXY` | 未設定 | プロキシを**手動**指定（カンマ区切りで複数 → ローテーション）。`http://` `https://` `socks5://` 可 |
| `YT_META_PROXY_AUTO` | `1` | `0` で無料プロキシリストの**自動取得を止める**（手動指定があるときは自動で動きません） |
| `YT_META_PROXY_SOURCES` | 既定の公開リスト10件 | リストの取得元（カンマ区切り）。自前のリスト配信に差し替えられる |
| `YT_META_PROXY_ALLOW_PRIVATE` | `0` | `1` で 127.0.0.1 / 私有IP のプロキシも使う（**ローカル検証専用**） |
| `YT_META_HOST` | `https://www.youtube.com` | 接続先（ローカルのモック検証用。本番では触らない） |
| `YT_META_TLS_REJECT` | `1` | `0` で証明書検証を無効化（**ローカル検証用。本番では絶対に使わない**） |
| `YT_SUGGEST_URLS` | Google / clients6 の2系統 | 検索候補（`/api/suggest`）の取得元（カンマ区切り） |
| `YT_LEGACY_TIMEOUT` | `4000` | 従来経路（`youtube-search-api`）の打ち切り時間 ms（最小 300） |

`/api/meta-stats` は `YT_META_DEBUG=1` のときだけ応答します。既定では 404 なので、
本番で不用意にキャッシュ統計や visitorId を外部へ出すことはありません。

### プロキシの指定例

```bash
# 1本
YT_META_PROXY=http://user:pass@proxy.example.com:8080

# 複数（ラウンドロビン。死んだものは自動で一定時間外れる）
YT_META_PROXY=http://a.example.com:8080,http://b.example.com:8080

# SOCKS5
YT_META_PROXY=socks5://user:pass@proxy.example.com:1080

# youtube-search-api（axios）も同じプロキシを通したいなら、HTTPS_PROXY だけで両方カバーできる
HTTPS_PROXY=http://user:pass@proxy.example.com:8080
```

TLS はプロキシを**貫通**します（CONNECT トンネルの上で end-to-end に TLS）。
プロキシ事業者には暗号化されたストリームしか見えません。
実装は `lib/proxy-tunnel.js`（undici / https-proxy-agent などの依存は追加していません）。

### プロキシを設定しない場合（既定）

`YT_META_PROXY` を設定しなければ、**無料プロキシのリストを自動取得して使います**（`lib/proxy-sources.js`）。

- 起動時に裏でリストを取りに行きます（**起動はブロックしません**。取れる前のリクエストは従来経路へ）
- 以後 15 分ごと、または「使えるプロキシが尽きかけた」ときに取り直します
- 取得元は**既定で10件**。1つ死んでも他が生きていれば成立します。**全部失敗したら前回のリストを捨てません**
- 取り込むのは最大 300 本。プライベート/ループバックは除外します
- **事前の生死確認はしません**。数百本すべてに CONNECT を打つほうが重いので、実際に使って失敗したものから冷却して外します

```
[yt-proxy] refresh: 4 proxies from 1/1 sources { total: 4, ms: 31, kept: false }
```

⚠ **無料プロキシは第三者が運用しています。** TLS は end-to-end なので中身は見えませんが、
接続先ホスト名（`www.youtube.com`）は見えます。証明書検証は既定で有効（`YT_META_TLS_REJECT` は触らない）なので、MITM は失敗します。
信頼できない経路を使いたくなければ `YT_META_PROXY_AUTO=0` で止めて、自分のプロキシを `YT_META_PROXY` に設定してください。

既定の取得元（到達可否は環境によります。`YT_META_PROXY_SOURCES` で丸ごと差し替えられます）:

```
https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt
https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt
https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt
https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt
https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt
https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt
https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all
https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=all
https://www.proxy-list.download/api/v1/get?type=http
https://spys.me/proxy.txt
```

> これらの URL は開発環境から到達できないため、**実際に取得できるかは本番で確認してください**。
> `/api/meta-stats` の `proxySources.sources[]` に、取得元ごとの `ok` / `count` / `ms` / `error` が出ます。

---

## 2. 検証スクリプトを実行する

```bash
# 手元からデプロイ先へ
node scripts/verify-meta.js https://your-app.example.com

# 動画IDを指定する場合
node scripts/verify-meta.js https://your-app.example.com --video=dQw4w9WgXcQ
```

依存パッケージは不要です（Node 18+ の `fetch`）。終了コードは
`0 = どこかから取れた` / `1 = すべて 0 件` です。

チェックする内容:

| # | 対象 | 期待値 |
| --- | --- | --- |
| 0 | `/healthz` | `http=200`（外部 API 非依存） |
| 1 | `/api/search` を2回 | 2回目が明らかに速い（キャッシュ動作） |
| 2 | `/api/trending` | items が 0 より大きい |
| 3 | `/api/recommendations` | items が 0 より大きい |
| 4 | `/api/comments/:id` | 継続トークンで 2 回叩いても 400 にならない |
| 5 | `/api/meta-stats` | `errors` が増え続けない |

---

## 3. ログの読み方

`YT_META_DEBUG=1` のとき、サーバーログに `[yt-meta]` が出ます。

```
[yt-meta] search { q: 'minecraft', page: 0, items: 20 }        ← 成功（何件取れたか）
[yt-meta] meta dQw4w9WgXcQ { title: '...', related: 18 }        ← 動画メタ＋関連動画の件数
[yt-meta] trending { page: 0, items: 24 }
[yt-meta] channel { id: 'UC...', items: 12 }
[yt-meta] search fallback: search fast-path timeout            ← 高速経路が失敗 → 従来経路へ
[yt-meta] comments fallback: next failed (WEB: HTTP 429 | ...)  ← ← これが本命の診断情報
```

**`fallback:` の行が本命です。** 右側に失敗理由が並びます。

- `HTTP 429` / `HTTP 403` … **YouTube に弾かれています**（データセンター IP は特に弾かれやすい）
- `fast-path timeout` … 3.5 秒以内に決着しなかった（応答は遅いが拒否はされていない）
- `fast-path empty` … 応答は来たが 0 件（**パーサがレスポンス変更に追従できていない**可能性）
- `Client network socket disconnected` / `ENOTFOUND` … そもそも YouTube へ出られていない

---

## 4. `/api/meta-stats` の見方

```jsonc
{
  "enabled": true,
  "hasVisitorId": true,          // visitorData を取得できているか
  "cacheSize": 42,               // キャッシュ済みエントリ数
  "stats": {
    "calls": 130,                // callApi の呼び出し回数（＝実往復ではない。下記参照）
    "hedges": 96,                // 予備クライアントを並走させた回数
    "errors": 3,                 // 全経路が失敗した回数
    "cacheHits": 88,             // キャッシュで往復ゼロだった回数
    "byEndpoint": { "search": 70, "browse": 40, "next": 20 }
  }
}
```

見るべきは **`cacheHits / calls` の比率** と **`errors` の増え方** です。

- `cacheHits` が伸びている → キャッシュが効いている（2回目以降の往復が消えている）
- `errors` が増え続ける → 上流に拒否されている。[3] の `fallback:` 行で理由を確認
- `hedges` が `calls` とほぼ同数 → 毎回予備クライアントまで走っている＝**上位クライアントが 400ms 以内に答えていない**。`hedgeMs` を上げるか、遅い経路を外す
- `shortCircuited` が増えている → サーキットブレーカー／ネガティブキャッシュが働いて**外向き通信を止めている**（下記）

> `calls` は `callApi()` の呼び出し数で、**1回の呼び出しが最大3クライアントへ並走**します（並列ヘッジ）。
> `byEndpoint` はエンドポイント別の内訳です。`player` は**絶対に現れません**（現れたらバグです）。

### IP ブロック時の防御動作（サーキットブレーカー）

`meta` / `proxy` は「今どう止まっているか」を示します。

```jsonc
"meta":  { "circuitOpen": true, "circuitOpenFor": 59762, "consecutiveFailures": 3,
           "hedging": false, "negativeEntries": 3 },
"proxy": { "direct": false, "count": 1,
           "proxies": [{ "proxy": "http://127.0.0.1:42559", "failures": 5, "coolingFor": 479922 }] }
```

| 項目 | 意味 |
| --- | --- |
| `meta.circuitOpen` | `true` の間は外向き通信を**一切しない**（即座にフォールバック） |
| `meta.hedging` | 失敗中は `false`。予備クライアントを並走させず往復を 1/3 にする |
| `meta.negativeEntries` | 「このリクエストは直近失敗した」と覚えている数（30秒で再挑戦） |
| `proxy.proxies[].coolingFor` | そのプロキシを次に使うまでの残り待ち時間（失敗ごとに倍増、最大10分） |
| `proxySources.lastAdded` | 最後の自動取得で取り込んだ本数 |
| `proxySources.sources[]` | 取得元ごとの成否（`ok` / `count` / `ms` / `error`） |

**失敗は2種類に分けて数えます**（ここが要点）:

| 種類 | 例 | 扱い |
| --- | --- | --- |
| **拒否**（systemic） | YouTube 本体が **HTTP 429 / 403** を返した | IPブロックの兆候。3回で回路を開き、30秒そのリクエストを覚える |
| **不通**（transport） | プロキシが CONNECT を拒否、タイムアウト、接続不能 | **プロキシが悪いだけ**。12回までは即座に別のプロキシで再挑戦する |

「プロキシが 403 を返した」文字列は両方に現れるので、**実際に origin から返った HTTP ステータス**だけで判定しています
（`proxy refused CONNECT: HTTP 403` は誤判定しません）。

動き:

1. 連続 **3 回**失敗 → 回路を開き、**60 秒**は外向き通信を止める（失敗が続くと 2 分 → 4 分 … 最大 10 分）
2. その間は `fastMeta()` が即座に従来経路へフォールバックする（待ち時間ほぼゼロ）
3. 同じリクエストは **30 秒**ネガティブキャッシュして、再挑戦を遅らせる
4. 冷却が明けたら 1 本だけ試し、成功すれば回路を閉じて通常（ヘッジ有り）に戻る

> **「サーキットが開いていて 0 件」は正常な防御動作です。**
> `verify-meta.js` はこの場合、終了コード 0（＝アプリは従来経路で動作中）を返します。

---

## 5. 症状 → 原因 → 対処

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| すべて 0 件、`fallback:` に `HTTP 429/403` | IP が弾かれている | **まず `YT_META_PROXY` でプロキシを設定する**。それでも弾かれるなら `YT_META=0`（ストリームはそのまま動く） |
| すべて 0 件、`fallback:` にネットワークエラー | ホスティングが外向き通信を制限 | 同上 |
| `meta.circuitOpen: false` なのに 0 件 | プロキシ到達不可 / 認証失敗 | `proxy refused CONNECT: HTTP 407` は認証エラー。ユーザー名・パスワードを確認（パスワードの `#` `@` は URL エンコードが必要） |
| プロキシを通しているのに `proxy.direct: true` | 環境変数が読めていない | 値が空文字になっていないか確認。`YT_META_PROXY` 未設定なら `HTTPS_PROXY` を見る |
| `http=200` なのに items=0、`fallback: fast-path empty` | YouTube のレスポンス形式が変わった | `lib/yt-innertube.js` の `extractItems()` に新しいレンダラ名を追加 |
| 1回目が 3 秒前後かかる | 予備クライアントまで並走している | `ytMeta` 生成時の `hedgeMs` を上げる（`index.js`） |
| 同じ検索が毎回遅い | キャッシュが効いていない | 複数インスタンス構成ならインスタンスごとにキャッシュが乗るだけ。TTL は既定10分 |
| コメントの「続きを読む」が 400 | 継続トークンの二重エンコード | 既に正規化済み。出た場合は `/api/comments/:id?continuation=` に渡す値を確認 |

---

### 検索が0件になる / 埋まるまで遅い

1. `/api/search?q=...` の応答の `source` を見る
   - `innertube` … 高速経路で取れた
   - `innertube-retry` … 1回目はプロキシが悪く、再挑戦で取れた（一時的に遅くなるが正常）
   - `mixed` … 高速経路の分が少なかったので従来経路で補った
   - `legacy` … 従来経路だけで返した
   - `none` / `error` … どちらも0件
2. `YT_META_DEBUG=1` で `[legacy] dead for a while` が出ていたら、従来経路は冷却中（5分）。
   ブロック環境では直アクセスを増やさないための**正常な動作**です。
3. ずっと `legacy` から戻らない場合は `/api/meta-stats` の `meta.circuitOpen` を確認。
   `true` なら YouTube 本体に拒否されているので、プロキシの自動取得が効いているか
   （`proxySources.lastAdded`）を見てください。

### 検索候補（サジェスト）が出ない

- サーバ側の `/api/suggest?q=...` を直接叩いて `source` を見る
  - `remote` … 取れた
  - `cache` … キャッシュ（10分）
  - `none` … どの候補元にも届かなかった。画面は端末の検索履歴から候補を出します
- 候補元を変えたい場合は `YT_SUGGEST_URLS` を指定する

## 6. 手元で「IPブロック環境」を再現する

本物の YouTube に出られない開発環境でも、モックで実機相当の検証ができます。

```bash
# ターミナル1: 偽YouTube + プロキシ3種を起動
node scripts/mock-youtube.js
# → 偽YouTube / 通すプロキシ / 403を返すプロキシ(=ブロック済みIP相当) / SOCKS5 のURLが出る

# ターミナル2: プロキシ経由で動かす
YT_META_HOST=<偽YouTubeのURL> \
YT_META_PROXY=<通すプロキシのURL> \
YT_META_TLS_REJECT=0 YT_META_DEBUG=1 \
PORT=3000 node index.js

node scripts/verify-meta.js http://127.0.0.1:3000
# → 経路: <プロキシURL> ok=N と出て、items が 1 以上になれば成功

# ターミナル2を 403プロキシ に差し替えて再起動すると、回路が開く挙動を確認できる
# → 回路: OPEN / shortCircuit が増えても CONNECT 回数が増えない
```

実測（このリポジトリの `scripts/mock-youtube.js` での検証結果）:

| シナリオ | 外向き CONNECT | `/api/search` 応答 |
| --- | --- | --- |
| 手動でプロキシ指定（通る） | リクエストごとに 1〜3（ヘッジ） | 初回 13ms / 2回目 3ms（キャッシュ） |
| 手動でプロキシ指定（403＝ブロック済み） | **最初の 5 回で打ち止め**、以降は 0 | 10ms 前後（＝待ち時間なしでフォールバック） |
| **リスト自動取得**（4本中3本が死んでいる） | 死んだ3本は1回ずつ試して冷却、以降は生きている1本だけ | 1回目 447ms（死んだプロキシに当たる→従来経路）→ **2回目 12ms で items=1** |

自動取得は「最初の数回は外れを引く」前提で、**外れたプロキシを即座に冷却して次へ回す**ので、
数リクエストで自然に生きているプロキシに落ち着きます。

## 7. 撤退手順（安全第一）

高速経路は**追加**なので、外してもアプリは動きます。

```bash
YT_META=0     # 従来の youtube-search-api 経路だけになる
```

元に戻すときは `YT_META=0` を消すだけです。

---

## 8. パーサが追従できていないときの直し方

YouTube はレンダラ名（`videoRenderer` / `lockupViewModel` / `shortsLockupViewModel` …）を
予告なく変えます。`items=0` で `http=200` ならこれが原因です。

1. `YT_META_DEBUG=1` で該当エンドポイントのログ（`items: 0`）を確認
2. 実レスポンスの形を確認して、`lib/yt-innertube.js` の `extractItems()` に分岐を追加
   ```js
   if (node.新しいレンダラ名) return push('video', parseNew(node.新しいレンダラ名));
   ```
3. `test/yt-innertube.test.js` にフィクスチャを追加して `npm test`

解析は **`deepFind()` でキー名を掘る**方針にしてあるので、階層の変更には強いです。
壊れるのは「レンダラ名そのもの」が変わったときだけです。
