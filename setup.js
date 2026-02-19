#!/usr/bin/env node
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise(resolve => {
  const prompt = def ? `${q} [${def}]: ` : `${q}: `;
  rl.question(prompt, answer => resolve(answer.trim() || def || ''));
});

async function main() {
  console.log('\n  Mission Control Setup');
  console.log('  =====================\n');

  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const overwrite = await ask('.env already exists. Overwrite? (y/N)', 'N');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Setup cancelled.');
      rl.close();
      return;
    }
  }

  const lines = [];

  const port = await ask('Server port', '3100');
  lines.push(`MC_PORT=${port}`);

  const pin = await ask('Dashboard PIN (4+ digits recommended)', '');
  if (pin) {
    lines.push(`MC_PIN=${pin}`);
  } else {
    lines.push('MC_PIN=0000');
    console.log('  (Using default PIN 0000 - change this before exposing to network)\n');
  }

  const title = await ask('Dashboard title', 'Mission Control');
  lines.push(`MC_TITLE=${title}`);

  const defaultBase = path.join(os.homedir(), '.openclaw');
  const openclawBase = await ask('OpenClaw base path', defaultBase);
  if (openclawBase !== defaultBase) {
    lines.push(`OPENCLAW_BASE=${openclawBase}`);
  } else {
    lines.push(`# OPENCLAW_BASE=${defaultBase}`);
  }

  const agents = await ask('Core agent IDs (comma-separated)', 'main,ops');
  lines.push(`MC_CORE_AGENTS=${agents}`);

  console.log('');
  const kanban = await ask('Enable Kanban board integration? (Y/n)', 'Y');
  if (kanban.toLowerCase() !== 'n') {
    lines.push('MC_KANBAN_ENABLED=true');
    const kanbanUrl = await ask('Kanban service URL', 'http://localhost:3000');
    lines.push(`MC_KANBAN_URL=${kanbanUrl}`);
  } else {
    lines.push('MC_KANBAN_ENABLED=false');
  }

  console.log('');
  const vps = await ask('Enable VPS activity log? (y/N)', 'N');
  if (vps.toLowerCase() === 'y') {
    lines.push('MC_VPS_ENABLED=true');
    lines.push(`MC_VPS_SSH_KEY=${await ask('SSH key path', '~/.ssh/id_rsa')}`);
    lines.push(`MC_VPS_USER=${await ask('VPS username')}`);
    lines.push(`MC_VPS_HOST=${await ask('VPS hostname or IP')}`);
    lines.push(`MC_VPS_REMOTE_PATH=${await ask('Remote log file path')}`);
  } else {
    lines.push('MC_VPS_ENABLED=false');
  }

  const content = lines.join('\n') + '\n';
  fs.writeFileSync(envPath, content);
  console.log(`\n  .env written to ${envPath}`);
  console.log('  Run "npm start" to launch Mission Control.\n');
  rl.close();
}

main().catch(err => { console.error(err); process.exit(1); });
