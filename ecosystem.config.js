module.exports = {
  apps: [
    {
      name: 'atlas',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Log configuration
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/atlas-error.log',
      out_file: 'logs/atlas-out.log',
      merge_logs: true,
      // Restart behavior
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: '10s',
      // Graceful shutdown
      kill_timeout: 5000,
    },
  ],
};
