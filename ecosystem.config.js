module.exports = {
  apps: [
    {
      name: "whatsapp-api",
      script: "./index.js",         // your main entry file
      instances: 1,                  // or "max" for multi-core
      autorestart: true,             // restart on crash/exit
      watch: false,                  // set true for dev auto-reload
      max_memory_restart: "500M",    // restart if memory > 500MB
      env: {
        NODE_ENV: "development",
        PORT: 5002
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 5002
      },
      error_file: "./logs/error.log",  // error logs
      out_file: "./logs/output.log",   // standard logs
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      time: true
    }
  ]
};
