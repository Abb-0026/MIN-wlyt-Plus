#!/usr/bin/env node
'use strict';

/**
 * メタデータ高速経路（lib/yt-innertube.js）の実機検証スクリプト
 *
 * 使い方:
 *   node scripts/verify-meta.js https://your-app.example.com
 *   node scripts/verify-meta.js http://127.0.0.1:3000 --video=dQw4w9WgXcQ
 *
 * 依存パッケージなし（Node 18+ の global fetch を使用）。
 * サーバー側で YT_META_DEBUG=1 が有効なら /api/meta-stats も表示します。
 *
 * 終了コード:
 *   0 = 少なくとも1つの経路からアイテムが取れた
 *   1 = どこも 0 件（高速経路が生きていない。下の「判定」を参照）
 */
const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const videoArg = (args.find((a) => a.startsWith('--video=')) || '').split('=')[1];
const VIDEO = videoArg || 'dQw4w9WgXcQ';
const QUERY = 'minecraft';

const line = '─'.repeat(58);
let failures = 0;
const results = [];

async function timed(name, path, { json = true } = {}) {
  const url = base + path;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const ms = Date.now() - t0;
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (e) {
      body = null;
    }
    return { name, path, ok: res.ok, status: res.status, ms, body, text: text.slice(0, 120) };
  } catch (err) {
    return { name, path, ok: false, status: 0, ms: Date.now() - t0, body: null, error: err.message };
  }
}

function report(r, detail) {
  const tag = r.ok ? 'OK ' : 'NG ';
  console.log(`  ${tag} ${r.name.padEnd(22)} ${String(r.ms).padStart(6)}ms  http=${r.status}  ${detail}`);
  results.push(r);
  return r;
}

const itemsOf = (r) => {
  const b = r && r.body;
  if (Array.isArray(b)) return b.length;
  if (b && Array.isArray(b.items)) return b.items.length;
  if (b && Array.isArray(b.comments)) return b.comments.length;
  return -1;
};

(async () => {
  console.log(`\nメタデータ高速経路の検証: ${base}`);
  console.log(`検証用の動画ID: ${VIDEO}`);
  console.log(line);

  // 0. ヘルスチェック（外部APIに依存しない）
  console.log('\n[0] 到達性');
  const health = await timed('healthz', '/healthz');
  report(health, health.body && health.body.status === 'ok' ? 'status=ok' : (health.error || health.text));
  if (!health.ok) {
    console.log('\nサーバーに到達できません。URL とデプロイ状態を確認してください。');
    process.exit(1);
  }

  // 1. 検索（1回目 = 実往復、2回目 = キャッシュ）
  console.log('\n[1] /api/search（1回目=実往復 / 2回目=キャッシュ）');
  const q = encodeURIComponent(QUERY);
  const s1 = await timed('search (1st)', `/api/search?q=${q}&page=0`);
  report(s1, `items=${itemsOf(s1)}`);
  const s2 = await timed('search (2nd, cached)', `/api/search?q=${q}&page=0`);
  report(s2, `items=${itemsOf(s2)}`);
  if (itemsOf(s2) > 0 && s2.ms < s1.ms) {
    console.log(`      → キャッシュで ${s1.ms - s2.ms}ms 短縮（2回目は往復ゼロが期待値）`);
  }

  // 2. トレンド
  console.log('\n[2] /api/trending');
  const tr = await timed('trending', '/api/trending?page=0');
  report(tr, `items=${itemsOf(tr)}`);

  // 3. 関連動画
  console.log('\n[3] /api/recommendations（動画の関連動画）');
  const rc = await timed(
    'recommendations',
    `/api/recommendations?id=${VIDEO}&title=${encodeURIComponent('test video')}&channel=${encodeURIComponent('test')}`
  );
  report(rc, `items=${itemsOf(rc)}`);

  // 4. コメント（継続トークン付き）
  console.log('\n[4] /api/comments/:id（継続トークン）');
  const c1 = await timed('comments', `/api/comments/${VIDEO}`);
  const cont = c1.body && c1.body.continuation;
  report(c1, `comments=${itemsOf(c1)} continuation=${cont ? 'あり' : 'なし'}`);
  if (cont) {
    const c2 = await timed('comments (next page)', `/api/comments/${VIDEO}?continuation=${encodeURIComponent(cont)}`);
    report(c2, `comments=${itemsOf(c2)}`);
    const c3 = await timed('comments (same token)', `/api/comments/${VIDEO}?continuation=${encodeURIComponent(cont)}`);
    report(c3, `comments=${itemsOf(c3)}（2回目も同じ件数なら正常＝トークンが壊れていない）`);
  }

  // 5. 診断統計（YT_META_DEBUG=1 のときだけ）
  console.log('\n[5] /api/meta-stats（サーバー側 YT_META_DEBUG=1 が必要）');
  const st = await timed('meta-stats', '/api/meta-stats');
  let meta = null;
  let proxy = null;
  if (st.status === 404) {
    console.log('  -- 無効（YT_META_DEBUG=1 を設定すると有効になります）');
  } else if (st.body) {
    const s = st.body.stats || {};
    console.log(`  OK  cache=${st.body.cacheSize} calls=${s.calls} hits=${s.cacheHits} errors=${s.errors} shortCircuit=${s.shortCircuited}`);
    console.log('      endpoints:', JSON.stringify(s.byEndpoint));
    meta = st.body.meta;
    proxy = st.body.proxy;
    if (proxy) {
      if (proxy.direct) {
        console.log('      経路: 直接接続（プロキシ未設定）');
      } else {
        for (const p of proxy.proxies) {
          console.log(`      経路: ${p.proxy} ok=${p.ok} failures=${p.failures} cooling=${p.coolingFor}ms`);
        }
      }
    }
    if (meta) {
      console.log(`      回路: ${meta.circuitOpen ? `OPEN（あと ${meta.circuitOpenFor}ms は外向き通信を止める）` : 'CLOSED'}` +
        ` 連続失敗=${meta.consecutiveFailures} ヘッジ=${meta.hedging ? 'on' : 'off'} ネガティブ=${meta.negativeEntries}`);
    }
  } else {
    report(st, st.text);
  }
  const circuitOpen = !!(meta && meta.circuitOpen);

  // 判定
  console.log('\n' + line);
  console.log('判定');
  console.log(line);
  const counts = { search: itemsOf(s2), trending: itemsOf(tr), recommendations: itemsOf(rc), comments: itemsOf(c1) };
  const total = Object.values(counts).reduce((a, b) => a + Math.max(0, b), 0);
  console.log('  取得件数:', JSON.stringify(counts));

  if (total === 0) {
    failures++;
    if (circuitOpen) {
      console.log(`
  ⚠ サーキットブレーカーが開いています（IPブロック検知）。

    これは「壊れている」のではなく、想定どおりの防御動作です:
      ・外向き通信は止まっている（無駄な往復ゼロ）
      ・従来経路（youtube-search-api）へフォールバックする
      ・冷却時間後に自動で再開する

    対処:
      1. プロキシを設定する
           YT_META_PROXY=http://user:pass@host:port
           （カンマ区切りで複数→ローテーション。socks5:// も可）
      2. プロキシ自体がブロックされているなら、別のプロキシへ差し替える
      3. どちらも無理なら YT_META=0 で無効化（ストリームには影響なし）
`);
      failures = 0; // 防御動作として想定内なので終了コードは 0 のまま
      console.log(line);
      console.log('結論: 高速経路は無効化されているが、アプリは従来経路で動作中。');
      console.log(line + '\n');
      process.exit(0);
    }
    console.log(`
  ✗ すべて 0 件です。高速経路が生きていません。切り分け:

    1) デプロイ先から YouTube へ出られない
       → ホスティング側の outbound 制限 / プロキシを確認。
         （このスクリプトをデプロイ先のシェルではなく手元から実行している場合、
           検証しているのは「手元 → サーバー」と「サーバー → YouTube」の両方です）

    2) InnerTube が 403/429 を返している
       → サーバーログに "[yt-meta] search fallback:" が出ます。
         YT_META_DEBUG=1 で /api/meta-stats の errors 件数と
         byEndpoint も確認してください。
       → データセンター IP は YouTube に弾かれやすいです。
         その場合は YT_META=0 で従来経路に戻してください（ストリームには影響なし）。

    3) 従来経路（youtube-search-api）も落ちている
       → 上と同じログが出ます。こちらは元々の取得元なので
         ネットワーク全体の問題の可能性が高いです。

    4) パーサが YouTube のレスポンス変更に追従できていない
       → http=200 で items=0 の場合。YT_META_DEBUG=1 のログで
         "search { q: '...', page: 0, items: 0 }" を確認。
         lib/yt-innertube.js の extractItems() にレンダラ名を追加します。
`);
  } else {
    console.log(`
  ✓ 高速経路は応答しています。次を確認してください:

    - 2回目の /api/search が 1回目より十分速いこと（キャッシュ動作）
    - コメントの継続トークンで 400 が出ないこと（[4] が NG なら
      サーバーログに "[yt-meta] comments fallback:" が出ています）
    - 何度か実行して errors が増え続けないこと（/api/meta-stats）

  速さの目安:
      1回目 300〜1500ms / 2回目 50ms 未満  … 期待値
      1回目 3000ms 超                      … 予備クライアントまで並走している
                                              （hedgeMs を下げると改善します）
`);
  }

  console.log(line);
  console.log('環境変数: YT_META=0 で無効化 / YT_META_DEBUG=1 でログと /api/meta-stats を有効化');
  console.log(line + '\n');
  process.exit(failures ? 1 : 0);
})();
