// PM2 ecosystem config for Monday — Slack knowledge assistant.
//
// Target: free-tier ARM Linux (Oracle Cloud A1 / equivalent), single long-running
// Node process. Memory ceiling leaves headroom for the local embedding model
// (@xenova/transformers) on a 1GB-RAM host.
//
// Usage:
//   npm run build
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup   # persist across reboots
//
// Required env vars (loaded from the shell or a .env file Monday reads at boot):
//   SLACK_BOT_TOKEN, SLACK_APP_TOKEN
// See README.md "Deployment" and .env.example for the full list.

module.exports = {
  apps: [
    {
      name: "monday",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      // Restart with backoff on repeated crashes — protects against env-var
      // misconfiguration churn (Monday exits non-zero with a friendly error
      // when SLACK_BOT_TOKEN / SLACK_APP_TOKEN are missing).
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 4000,
    },
  ],
};
