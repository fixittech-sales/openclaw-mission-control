const path = require('path');
const os = require('os');

try { require('dotenv').config(); } catch {}

const OPENCLAW_BASE = process.env.OPENCLAW_BASE
  || path.join(os.homedir(), '.openclaw');

const config = {
  port: parseInt(process.env.MC_PORT || '3100', 10),
  pin: process.env.MC_PIN || '0000',
  title: process.env.MC_TITLE || 'Mission Control',

  openclaw: {
    base: OPENCLAW_BASE,
    config: path.join(OPENCLAW_BASE, 'openclaw.json'),
    agentsDir: path.join(OPENCLAW_BASE, 'agents'),
    antfarmDb: path.join(OPENCLAW_BASE, 'antfarm', 'antfarm.db'),
    eventsFile: path.join(OPENCLAW_BASE, 'antfarm', 'events.jsonl'),
  },

  coreAgentIds: (process.env.MC_CORE_AGENTS || 'main,ops,comms,architect')
    .split(',').map(s => s.trim()).filter(Boolean),
  a2aPollInterval: parseInt(process.env.MC_A2A_POLL_MS || '5000', 10),

  kanban: {
    enabled: process.env.MC_KANBAN_ENABLED !== 'false',
    url: process.env.MC_KANBAN_URL || 'http://localhost:3000',
    actionsLog: process.env.MC_ACTIONS_LOG
      || path.join(OPENCLAW_BASE, 'workspace', 'kanban-board', 'actions.log'),
  },

  vps: {
    enabled: process.env.MC_VPS_ENABLED === 'true',
    sshKeyPath: process.env.MC_VPS_SSH_KEY || '',
    username: process.env.MC_VPS_USER || '',
    host: process.env.MC_VPS_HOST || '',
    remotePath: process.env.MC_VPS_REMOTE_PATH || '',
    connectTimeout: parseInt(process.env.MC_VPS_TIMEOUT || '5', 10),
  },

  gateway: {
    launchdLabel: process.env.MC_GATEWAY_LAUNCHD_LABEL || 'ai.openclaw.gateway',
  },
};

module.exports = config;
