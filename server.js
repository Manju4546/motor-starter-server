import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN || '8678851675:AAHpsXBNVAGKLMb2IQlcNVJnyOfdVCWtO1U';
const AUTH_CHAT_ID = String(process.env.AUTH_CHAT_ID || '6044496806');
const PORT = process.env.PORT || 3000;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- System State ---
let espState = {
  isOnline: false,
  lastSeen: 0,
  motorState: 'STOPPED', // 'STOPPED' or 'RUNNING'
  remainingSeconds: 0,
  activeTimerLabel: 'None',
  wasRunningBeforeDisconnect: false,
  totalPings: 0,
  wifiRssi: 0
};

let pendingCommand = null; // { action: 'START' | 'STOP', timerMs: number, label: string, timestamp: number }

let dailySchedule = {
  enabled: false,
  onTime: '06:00',
  offTime: '09:00',
  onDoneToday: false,
  offDoneToday: false,
  lastDay: ''
};

// Helper: Get Current Time in Indian Standard Time (IST, UTC+5:30)
function getIST() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const istDate = new Date(utc + (3600000 * 5.5));
  const hh = String(istDate.getHours()).padStart(2, '0');
  const mm = String(istDate.getMinutes()).padStart(2, '0');
  const dateStr = `${istDate.getFullYear()}-${String(istDate.getMonth()+1).padStart(2, '0')}-${String(istDate.getDate()).padStart(2, '0')}`;
  return { time: `${hh}:${mm}`, date: dateStr, istDate };
}

// --- Telegram API Helpers ---
async function sendTelegramMessage(text, replyMarkup = null) {
  try {
    const payload = {
      chat_id: AUTH_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error('Error sending Telegram message:', err.message);
  }
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text })
    });
  } catch (err) {
    console.error('Error answering callback query:', err.message);
  }
}

// --- Keyboards ---
function getMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '▶️ Start (No Limit)', callback_data: 'cmd_start_nolimit' },
        { text: '⏱️ Timed Runs...', callback_data: 'menu_timers' }
      ],
      [
        { text: '⏹️ Stop Motor', callback_data: 'cmd_stop' },
        { text: '📊 Live Status', callback_data: 'cmd_status' }
      ],
      [
        { text: '📅 Daily Schedule', callback_data: 'menu_schedule' }
      ]
    ]
  };
}

function getTimersKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⏱️ 30 Mins', callback_data: 'timer_30m' },
        { text: '⏱️ 1 Hour', callback_data: 'timer_1h' }
      ],
      [
        { text: '⏱️ 1.5 Hours', callback_data: 'timer_1.5h' },
        { text: '⏱️ 2 Hours', callback_data: 'timer_2h' }
      ],
      [
        { text: '⏱️ 2.5 Hours', callback_data: 'timer_2.5h' },
        { text: '⏱️ 3 Hours', callback_data: 'timer_3h' }
      ],
      [
        { text: '🔙 Back to Menu', callback_data: 'menu_main' }
      ]
    ]
  };
}

function getScheduleKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: dailySchedule.enabled ? '🔔 Schedule: ACTIVE (Turn OFF)' : '🔕 Schedule: OFF (Turn ON)',
          callback_data: 'toggle_schedule'
        }
      ],
      [
        { text: '🔙 Back to Menu', callback_data: 'menu_main' }
      ]
    ]
  };
}

// Format seconds into "Xh Ym Zs"
function formatDuration(sec) {
  if (!sec || sec <= 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  let res = [];
  if (h > 0) res.push(`${h}h`);
  if (m > 0 || h > 0) res.push(`${m}m`);
  res.push(`${s}s`);
  return res.join(' ');
}

// Generate Status Text
function getStatusText() {
  const ist = getIST();
  const espAgeSec = espState.lastSeen ? Math.round((Date.now() - espState.lastSeen) / 1000) : null;
  const statusIcon = espState.isOnline ? '🟢 ONLINE' : '🔴 OFFLINE';
  const motorIcon = espState.motorState === 'RUNNING' ? '⚡ RUNNING' : '⚪ STOPPED';
  
  let msg = `<b>📊 L&T MK1 Starter Dashboard</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📡 <b>ESP32 Controller:</b> ${statusIcon}\n`;
  if (espState.isOnline) {
    msg += `⏱️ <b>Heartbeat:</b> ${espAgeSec}s ago (RSSI: ${espState.wifiRssi || -60} dBm)\n`;
  }
  msg += `⚙️ <b>Motor State:</b> ${motorIcon}\n`;
  if (espState.motorState === 'RUNNING') {
    msg += `⏳ <b>Mode:</b> ${espState.activeTimerLabel}\n`;
    if (espState.remainingSeconds > 0) {
      msg += `⏳ <b>Time Remaining:</b> ${formatDuration(espState.remainingSeconds)}\n`;
    } else {
      msg += `⏳ <b>Time Remaining:</b> Continuous (No Limit)\n`;
    }
  }
  msg += `📅 <b>Schedule:</b> ${dailySchedule.enabled ? `✅ ON (${dailySchedule.onTime} - ${dailySchedule.offTime})` : '❌ Disabled'}\n`;
  msg += `🕒 <b>Current IST:</b> ${ist.time} (${ist.date})\n`;
  return msg;
}

// --- Telegram Polling Engine ---
let lastUpdateId = 0;
async function pollTelegram() {
  while (true) {
    try {
      const res = await fetch(`${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`);
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          lastUpdateId = update.update_id;
          await handleTelegramUpdate(update);
        }
      }
    } catch (err) {
      // Back off slightly on network error
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function handleTelegramUpdate(update) {
  // 1. Text Messages
  if (update.message) {
    const chatId = String(update.message.chat.id);
    const text = (update.message.text || '').trim();

    if (chatId !== AUTH_CHAT_ID) {
      await sendTelegramMessage(`⛔ Unauthorized access denied (Chat ID: ${chatId}).`);
      return;
    }

    if (text === '/start' || text === '/menu') {
      await sendTelegramMessage(
        `🚜 <b>Agricultural Starter Control Panel</b>\nChoose an action below:`,
        getMainMenuKeyboard()
      );
    } else if (text === '/status') {
      await sendTelegramMessage(getStatusText(), getMainMenuKeyboard());
    } else if (text === '/stop') {
      queueCommand('STOP', 0, 'Manual Stop');
      await sendTelegramMessage(`⏹️ <b>STOP command queued!</b> Relay 2 will pulse to release contactor.`);
    } else if (text.startsWith('/schedule')) {
      // E.g. /schedule 06:30 09:30
      const parts = text.split(/\s+/);
      if (parts.length === 3) {
        dailySchedule.onTime = parts[1];
        dailySchedule.offTime = parts[2];
        dailySchedule.enabled = true;
        await sendTelegramMessage(
          `✅ <b>Schedule Updated & Enabled!</b>\n⏰ ON: <b>${dailySchedule.onTime} IST</b>\n⏰ OFF: <b>${dailySchedule.offTime} IST</b>`,
          getMainMenuKeyboard()
        );
      } else {
        await sendTelegramMessage(`ℹ️ Use format: <code>/schedule HH:MM HH:MM</code>\nExample: <code>/schedule 06:00 09:00</code>`);
      }
    }
  }

  // 2. Inline Callback Buttons
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = String(cb.message.chat.id);
    const data = cb.data;

    if (chatId !== AUTH_CHAT_ID) {
      await answerCallbackQuery(cb.id, 'Unauthorized');
      return;
    }

    await answerCallbackQuery(cb.id);

    if (data === 'menu_main') {
      await sendTelegramMessage(`🚜 <b>Control Panel</b>:`, getMainMenuKeyboard());
    } else if (data === 'menu_timers') {
      await sendTelegramMessage(`⏱️ <b>Select Duration:</b>\nThe motor will automatically shut off when time elapses.`, getTimersKeyboard());
    } else if (data === 'menu_schedule') {
      const schInfo = `📅 <b>Daily Schedule Settings</b>\n━━━━━━━━━━━━━━━━━━━━━\nStatus: <b>${dailySchedule.enabled ? '🟢 Enabled' : '🔴 Disabled'}</b>\nStart Time: <b>${dailySchedule.onTime} IST</b>\nStop Time: <b>${dailySchedule.offTime} IST</b>\n\nTo change times, send:\n<code>/schedule 06:00 09:00</code>`;
      await sendTelegramMessage(schInfo, getScheduleKeyboard());
    } else if (data === 'toggle_schedule') {
      dailySchedule.enabled = !dailySchedule.enabled;
      const stateStr = dailySchedule.enabled ? '🟢 ENABLED' : '🔴 DISABLED';
      await sendTelegramMessage(`📅 Schedule is now <b>${stateStr}</b>.`, getMainMenuKeyboard());
    } else if (data === 'cmd_status') {
      await sendTelegramMessage(getStatusText(), getMainMenuKeyboard());
    } else if (data === 'cmd_stop') {
      queueCommand('STOP', 0, 'Manual Stop');
      await sendTelegramMessage(`⏹️ <b>STOP command queued!</b> Opening Relay 2 NC circuit...`, getMainMenuKeyboard());
    } else if (data === 'cmd_start_nolimit') {
      if (!espState.isOnline) {
        await sendTelegramMessage(`❌ <b>Cannot Start:</b> ESP32 is OFFLINE! Check starter power & Wi-Fi.`);
        return;
      }
      queueCommand('START', 0, 'No Limit');
      await sendTelegramMessage(`⚡ <b>Starting Motor (No Limit)!</b>\nPulse sent to Relay 1. Motor will run until manual/scheduled STOP.`, getMainMenuKeyboard());
    } else if (data.startsWith('timer_')) {
      if (!espState.isOnline) {
        await sendTelegramMessage(`❌ <b>Cannot Start:</b> ESP32 is OFFLINE! Check starter power & Wi-Fi.`);
        return;
      }
      const timerMap = {
        'timer_30m':  { ms: 30 * 60 * 1000, label: '30 Mins' },
        'timer_1h':   { ms: 60 * 60 * 1000, label: '1 Hour' },
        'timer_1.5h': { ms: 90 * 60 * 1000, label: '1.5 Hours' },
        'timer_2h':   { ms: 120 * 60 * 1000, label: '2 Hours' },
        'timer_2.5h': { ms: 150 * 60 * 1000, label: '2.5 Hours' },
        'timer_3h':   { ms: 180 * 60 * 1000, label: '3 Hours' }
      };
      const selected = timerMap[data];
      if (selected) {
        queueCommand('START', selected.ms, selected.label);
        const finishTime = new Date(Date.now() + selected.ms + (3600000 * 5.5));
        const hh = String(finishTime.getUTCHours()).padStart(2, '0');
        const mm = String(finishTime.getUTCMinutes()).padStart(2, '0');
        await sendTelegramMessage(
          `⏱️ <b>Motor Started for ${selected.label}!</b>\n` +
          `• Local ESP32 timer armed.\n` +
          `• Scheduled auto-stop at: <b>${hh}:${mm} IST</b>.`,
          getMainMenuKeyboard()
        );
      }
    }
  }
}

function queueCommand(action, timerMs = 0, label = '') {
  pendingCommand = {
    action: action,
    timerMs: timerMs,
    label: label,
    timestamp: Date.now()
  };
  if (action === 'START') {
    espState.activeTimerLabel = label || 'Active';
  } else if (action === 'STOP') {
    espState.activeTimerLabel = 'None';
  }
}

// --- REST API for ESP32 ---

// ESP32 Heartbeat endpoint
app.post('/api/heartbeat', (req, res) => {
  const { motorState, remainingSeconds, wifiRssi } = req.body;

  const wasOffline = !espState.isOnline;
  espState.lastSeen = Date.now();
  espState.isOnline = true;
  espState.totalPings++;
  if (wifiRssi) espState.wifiRssi = wifiRssi;

  // SAFETY RECONNECT RULE: If motor was running when connection dropped
  if (wasOffline && espState.wasRunningBeforeDisconnect) {
    console.log('SAFETY TRIGGER: ESP32 reconnected after drop while running. Commanding STOP.');
    queueCommand('STOP', 0, 'Safety Power Restoration Stop');
    espState.wasRunningBeforeDisconnect = false;
    sendTelegramMessage(
      `🚨 <b>SAFETY RESET: Power / Network Restored!</b>\n` +
      `The motor was running when connection was lost.\n` +
      `To prevent unattended operation or hazard, an automatic <b>STOP pulse</b> has been sent.\n` +
      `Starter is in safe idle state.`,
      getMainMenuKeyboard()
    );
  } else if (wasOffline) {
    sendTelegramMessage(`🟢 <b>ESP32 Connected:</b> Back online and ready.`);
  }

  if (motorState) espState.motorState = motorState;
  if (typeof remainingSeconds === 'number') espState.remainingSeconds = remainingSeconds;

  // Deliver pending command if any
  let cmdToDeliver = 'NONE';
  let timerMsToDeliver = 0;
  if (pendingCommand) {
    cmdToDeliver = pendingCommand.action;
    timerMsToDeliver = pendingCommand.timerMs || 0;
    pendingCommand = null; // Cleared once delivered
  }

  res.json({
    status: 'OK',
    command: cmdToDeliver,
    timerMs: timerMsToDeliver,
    serverTimeIST: getIST().time
  });
});

// GET status for browser or diagnostics
app.get('/api/status', (req, res) => {
  res.json({
    espState: {
      ...espState,
      secondsSinceLastSeen: espState.lastSeen ? Math.round((Date.now() - espState.lastSeen) / 1000) : null
    },
    dailySchedule,
    ist: getIST()
  });
});

// HTML Web Dashboard
app.get('/', (req, res) => {
  const ist = getIST();
  const espAgeSec = espState.lastSeen ? Math.round((Date.now() - espState.lastSeen) / 1000) : 'Never';
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>L&T MK1 Starter - Cloud Server</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; margin: 0; }
      .card { max-width: 500px; margin: 20px auto; background: #1e293b; border-radius: 12px; padding: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
      h1 { font-size: 20px; margin-bottom: 20px; color: #38bdf8; text-align: center; }
      .status-pill { display: inline-block; padding: 4px 12px; border-radius: 20px; font-weight: bold; font-size: 14px; }
      .online { background: #166534; color: #4ade80; }
      .offline { background: #991b1b; color: #f87171; }
      .running { background: #0284c7; color: #e0f2fe; }
      .stopped { background: #334155; color: #cbd5e1; }
      .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #334155; }
      .label { color: #94a3b8; }
      .val { font-weight: 600; }
      .footer { text-align: center; margin-top: 15px; font-size: 12px; color: #64748b; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>🚜 Motor Starter Cloud Server</h1>
      <div class="row">
        <span class="label">ESP32 Controller</span>
        <span class="status-pill ${espState.isOnline ? 'online' : 'offline'}">${espState.isOnline ? 'ONLINE' : 'OFFLINE'}</span>
      </div>
      <div class="row">
        <span class="label">Last Heartbeat</span>
        <span class="val">${espAgeSec === 'Never' ? 'Never' : espAgeSec + 's ago'}</span>
      </div>
      <div class="row">
        <span class="label">Motor State</span>
        <span class="status-pill ${espState.motorState === 'RUNNING' ? 'running' : 'stopped'}">${espState.motorState}</span>
      </div>
      <div class="row">
        <span class="label">Remaining Timer</span>
        <span class="val">${espState.remainingSeconds > 0 ? formatDuration(espState.remainingSeconds) : 'None'}</span>
      </div>
      <div class="row">
        <span class="label">Schedule</span>
        <span class="val">${dailySchedule.enabled ? dailySchedule.onTime + ' - ' + dailySchedule.offTime : 'Disabled'}</span>
      </div>
      <div class="row">
        <span class="label">Server Time (IST)</span>
        <span class="val">${ist.time} (${ist.date})</span>
      </div>
      <div class="footer">Cloud Server Active • Ready for Telegram & ESP32</div>
    </div>
  </body>
  </html>
  `;
  res.send(html);
});

// --- Background Watchdog (Every 5 seconds) ---
setInterval(() => {
  const now = Date.now();
  // 1. Connection Loss Detection (45s timeout)
  if (espState.isOnline && (now - espState.lastSeen > 45000)) {
    espState.isOnline = false;
    console.log('WATCHDOG: ESP32 missed pings for >45s. Marked OFFLINE.');

    if (espState.motorState === 'RUNNING') {
      espState.wasRunningBeforeDisconnect = true;
      const remInfo = espState.remainingSeconds > 0 ? `${formatDuration(espState.remainingSeconds)} remaining` : 'No limit mode';
      sendTelegramMessage(
        `⚠️ <b>CRITICAL ALERT: ESP32 Connection Lost!</b>\n` +
        `• Motor was <b>RUNNING</b> (${remInfo}).\n` +
        `• Possible starter power trip, 3-phase loss, or Wi-Fi dropped.\n` +
        `• The local ESP32 countdown timer will continue independently if power is still present.\n` +
        `• If power died, safety stop will trigger on reconnection.`
      );
    } else {
      sendTelegramMessage(`ℹ️ <b>ESP32 is Offline</b> (Starter is currently idle).`);
    }
  }

  // 2. Daily Schedule Watchdog
  const ist = getIST();
  // Reset daily flags at midnight
  if (dailySchedule.lastDay !== ist.date) {
    dailySchedule.lastDay = ist.date;
    dailySchedule.onDoneToday = false;
    dailySchedule.offDoneToday = false;
  }

  if (dailySchedule.enabled) {
    // Scheduled ON trigger
    if (ist.time === dailySchedule.onTime && !dailySchedule.onDoneToday) {
      dailySchedule.onDoneToday = true;
      if (espState.isOnline) {
        queueCommand('START', 0, 'Daily Schedule');
        sendTelegramMessage(`📅 <b>Scheduled Start Triggered!</b> Motor is turning ON for morning schedule.`);
      } else {
        sendTelegramMessage(`❌ <b>Scheduled Start Failed:</b> ESP32 is OFFLINE at ${dailySchedule.onTime}!`);
      }
    }

    // Scheduled OFF trigger
    if (ist.time === dailySchedule.offTime && !dailySchedule.offDoneToday) {
      dailySchedule.offDoneToday = true;
      if (espState.isOnline) {
        queueCommand('STOP', 0, 'Daily Schedule');
        sendTelegramMessage(`📅 <b>Scheduled Stop Triggered!</b> Motor is turning OFF.`);
      } else {
        sendTelegramMessage(`⚠️ <b>Scheduled Stop Notice:</b> ESP32 is offline at scheduled stop time (${dailySchedule.offTime}).`);
      }
    }
  }
}, 5000);

// Start Server & Telegram Polling
app.listen(PORT, () => {
  console.log(`Motor Starter Cloud Server running on port ${PORT}`);
  console.log(`Authorized Chat ID: ${AUTH_CHAT_ID}`);
  pollTelegram();
});
