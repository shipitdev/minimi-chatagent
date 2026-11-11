export function proxyArguments(env) {
  const args = []
  if (env.MINIMI_PUBLIC_URL) {
    const url = new URL(env.MINIMI_PUBLIC_URL)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('MINIMI_PUBLIC_URL must be an HTTPS origin without credentials, path, query, or fragment')
    }
    args.push('--public-url', url.href, '--trusted-host', url.host)
  }
  if (Boolean(env.MINIMI_TLS_CERT) !== Boolean(env.MINIMI_TLS_KEY)) throw new Error('Provide both MINIMI_TLS_CERT and MINIMI_TLS_KEY')
  if (env.MINIMI_TLS_CERT) args.push('--tls-cert', env.MINIMI_TLS_CERT, '--tls-key', env.MINIMI_TLS_KEY)
  return args
}
