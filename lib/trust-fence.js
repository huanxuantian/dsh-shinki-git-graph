/**
 * Browser-trust fence for the /shinki-git routes: only loopback sockets with
 * a loopback (or --trusted-host listed) Host header may reach the git
 * service, so a LAN-exposed dsh web can never run git against arbitrary
 * paths. Mirrors the approach of dsh-better-sidebar's trust fence and the
 * upstream git-graph plugin's `isGitAllowed`.
 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Whether a socket remote address is a loopback address. */
export function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(address);
}

/** Whether a Host header value names a loopback host. */
export function isLoopbackHost(hostHeader) {
  const hostname = hostnameOf(hostHeader);
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** Extract the hostname from a Host header (strips port / brackets). */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * Build the fence bound to a host context.
 * @param {{webRuntime?: {trustedHosts?: readonly string[]}}} ctx
 */
export function createFence(ctx) {
  const trusted = () => {
  // DSH 0.2.1 移除了 webRuntime 服务：直接读 ctx.webRuntime 会抛异常（cordis 未注入访问）
  // 之前每次请求都在 fence 里抛 ⇒ 路由统一 500。这里改为逐层 try/catch，拿不到就用空列表（仅回环可访问）。
  try { const w = ctx && ctx.web; if (w && Array.isArray(w.trustedHosts)) return w.trustedHosts; } catch { /* 未注入 */ }
  try { const r = ctx && ctx.webRuntime; if (r && Array.isArray(r.trustedHosts)) return r.trustedHosts; } catch { /* 0.2.1 已移除 */ }
  return [];
};
  return {
    /**
     * Check one request.
     * @returns {{ok: true} | {ok: false, code: string, message: string}}
     */
    check(req) {
      const address = req.socket?.remoteAddress;
      if (typeof address === 'string' && isLoopbackAddress(address)) {
        return { ok: true };
      }
      // Non-loopback client: must carry a trusted Host header.
      const host = hostnameOf(req.headers?.host);
      if (host !== '' && trusted().includes(host)) return { ok: true };
      return {
        ok: false,
        code: 'forbidden',
        message: '非受信任客户端（需回环连接或 --trusted-host 白名单）',
      };
    },
  };
}
