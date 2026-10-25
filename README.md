# Motor Starter Cloud Server 🚜

Cloud Heartbeat Monitor, Daily Scheduler, and Telegram Controller for L&T MK1 3-Phase DOL Motor Starter with ESP32.

## Features
- **Interactive Telegram Bot**: Control with Start (No Limit), Timers (30m, 1h, 1.5h, 2h, 2.5h, 3h), Stop, Live Status, and Daily Schedule.
- **ESP32 Heartbeat Watchdog**: Detects power loss or network drop within 45 seconds and alerts Telegram.
- **Safety Reconnect Reset**: Automatically triggers STOP pulse when power returns after an unexpected outage during an active run.
- **Web Dashboard**: Real-time status page at root URL.

## Deployment on Render
1. Connect this repository to **Render.com**.
2. Select **Web Service** with Node runtime.
3. Build Command: `npm install`
4. Start Command: `node server.js`
