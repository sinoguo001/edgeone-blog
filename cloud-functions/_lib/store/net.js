// ============================================================
// cloudflare:sockets 兼容层：用 Node 的 net / tls 造一个同接口的 connect()
//
// 为什么能这么省事：mail.js 的 SMTP 实现从一开始就把 connect 设计成「外部注入」
// （当初是为了让本地 Node 测试能塞假 socket），所以这里只要提供一个接口同形的
// 实现，SMTP 协议流程（EHLO / AUTH / DATA）一行都不用改。
//
// 必须对齐的契约（mail.js 依赖这些）：
//   connect({ hostname, port }, { secureTransport: 'on' | 'starttls' | 'off' })
//     -> { readable, writable, opened, close(), startTls() }
//   readable / writable 是 Web Streams（mail.js 用 getReader() / getWriter()）
//   opened 在连接就绪时 resolve、失败时 reject
//   startTls() 返回升级后的同类对象（587 的 STARTTLS 流程要用）
//
// ⚠️ 这里唯一真正的坑：STARTTLS 是「同一条连接的两个阶段」。升级前必须先把
//   明文阶段挂上的 data 监听摘掉，否则旧桥接会抢走本该交给 TLS 层的字节，
//   表现为升级后永远读不到 EHLO 响应、最后超时。detach() 就是干这个的。
// ============================================================
import net from 'node:net';
import tls from 'node:tls';

function bridge(sock) {
  let controller = null;
  let done = false;

  const readable = new ReadableStream({
    start(c) { controller = c; },
    // 刻意不销毁底层 socket：STARTTLS 还要接着复用它
    cancel() {},
  });

  const onData = (chunk) => {
    if (done || !controller) return;
    try { controller.enqueue(new Uint8Array(chunk)); } catch (e) { /* 流已关闭 */ }
  };
  const onEnd = () => {
    if (done || !controller) return;
    done = true;
    try { controller.close(); } catch (e) { /* ignore */ }
  };
  const onError = (e) => {
    if (done || !controller) return;
    done = true;
    try { controller.error(e); } catch (err) { /* ignore */ }
  };

  sock.on('data', onData);
  sock.once('end', onEnd);
  sock.once('close', onEnd);
  sock.once('error', onError);

  const writable = new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        sock.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
      });
    },
  });

  return {
    readable,
    writable,
    detach() {
      done = true;
      sock.removeListener('data', onData);
      sock.removeListener('end', onEnd);
      sock.removeListener('close', onEnd);
      sock.removeListener('error', onError);
    },
  };
}

function wrap(sock, host, eventName) {
  const opened = new Promise((resolve, reject) => {
    const ok = () => { off(); resolve(); };
    const bad = (e) => { off(); reject(e); };
    const off = () => {
      sock.removeListener(eventName, ok);
      sock.removeListener('error', bad);
    };
    sock.once(eventName, ok);
    sock.once('error', bad);
  });
  // 调用方可能还没来得及 await 就出错了，这里吞一次避免 unhandled rejection
  opened.catch(() => {});

  const b = bridge(sock);

  return {
    readable: b.readable,
    writable: b.writable,
    opened,
    close() {
      b.detach();
      try { sock.destroy(); } catch (e) { /* ignore */ }
    },
    startTls() {
      b.detach();   // 关键一步：先摘监听，再把连接交给 TLS
      const secure = tls.connect({ socket: sock, servername: host });
      return wrap(secure, host, 'secureConnect');
    },
  };
}

export function connect(address, options = {}) {
  const host = address.hostname || address.host;
  const port = Number(address.port) || 0;
  if (!host || !port) throw new Error('connect() 需要 hostname 与 port');

  const mode = options.secureTransport;
  const direct = mode === 'on' || mode === true;

  const sock = direct
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });

  return wrap(sock, host, direct ? 'secureConnect' : 'connect');
}
