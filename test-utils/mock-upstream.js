'use strict';

/**
 * テスト用の上流モック。
 * 実ネットワークに依存せず、旧実装と新実装の「ストリーム取得にかかる時間」を比較するために使う。
 *
 *   node test/mock-upstream.js [port]
 */
const http = require('http');

const PORT = Number(process.argv[2] || 4100);

// 取得元ごとの応答遅延(ms)。実際の観測値に近い想定。
const LATENCY = {
  apiList: 50,
  videoFast: 250, // Min-Tube API（速い）
  videoSlow: 1800, // Min-Tube API（遅いインスタンス）
  comments: 900,
  siaDl: 1200, // siawaseok メタ + /360
  aiFetch: 2200, // aijimy + noembed + /360
  rapid: 700,
};

const VIDEO = (id, tag) => ({
  stream_url: `https://rr1---sn-mock.googlevideo.com/videoplayback?id=${id}&src=${tag}`,
  highstreamUrl: `https://rr1---sn-mock.googlevideo.com/videoplayback?id=${id}&src=${tag}&itag=137`,
  audioUrl: '',
  videoId: id,
  channelId: 'UCmock',
  channelName: 'Mock Channel',
  channelImage: '',
  videoTitle: `モック動画 "quote" 'single' </script><script>window.__XSS=1</script> ${id}`,
  videoDes: '説明 " と \'引用\' と </script> 混在\n2行目',
  videoViews: 12345,
  likeCount: 678,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const delay = (ms, body, type = 'application/json') =>
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    }, ms);

  if (path === '/min-tube-api.json') {
    return delay(LATENCY.apiList, [`http://127.0.0.1:${PORT}/fast`, `http://127.0.0.1:${PORT}/slow`]);
  }
  if (path.startsWith('/fast/api/video/')) {
    return delay(LATENCY.videoFast, VIDEO(path.split('/').pop(), 'fast'));
  }
  if (path.startsWith('/slow/api/video/')) {
    return delay(LATENCY.videoSlow, VIDEO(path.split('/').pop(), 'slow'));
  }
  if (path.startsWith('/fast/api/comments/')) {
    return delay(LATENCY.comments, { commentCount: 2, comments: [{ author: 'a', content: 'b' }] });
  }
  if (path.startsWith('/slow/api/comments/')) {
    return delay(LATENCY.comments + 1500, { commentCount: 2, comments: [{ author: 'a', content: 'b' }] });
  }
  res.writeHead(404);
  res.end('{}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock upstream listening on http://127.0.0.1:${PORT}`);
  console.log(JSON.stringify(LATENCY, null, 2));
});

module.exports = { LATENCY, PORT };
