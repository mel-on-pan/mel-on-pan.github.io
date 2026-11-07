/*
 * 観客スマホ向け中継サーバーの URL (運営パネル・観客ビューア共通)
 * worker/ を Cloudflare にデプロイしたときに表示される URL を wss:// に置き換えて書く。
 * 例: 'wss://abc-reboot-relay.<あなたのサブドメイン>.workers.dev'
 */
window.QB_CONFIG = {
  relayUrl: 'wss://abc-reboot-relay.abc-reboot-relay.workers.dev',
};
