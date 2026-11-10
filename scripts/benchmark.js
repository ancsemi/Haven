#!/usr/bin/env node
'use strict';
/**
 * Haven benchmark: what does a server of a given size cost to run?
 *
 * Runs the load tester (scripts/loadtest.js) at several community sizes, one
 * after another, and prints one table: how much memory and how much of one
 * processor core the server used with that many people online at once. Each
 * run uses its own throwaway server and data folder; no real server is
 * touched.
 *
 *   node scripts/benchmark.js
 *
 * Options (all optional):
 *   --sizes LIST   people online in each run (default 10,50,100,250,500,1000)
 *   --port N       port for the throwaway servers (default 3990)
 *   --seconds N    how long the chat part of each run lasts (default 20)
 *   --json FILE    also write the results as JSON to FILE
 *
 * The chat is far busier than a real community of the same size: everyone
 * is online, everyone is in the same channel, and messages arrive at the
 * rate shown in the table without a pause. Treat the numbers as a ceiling.
 *
 * The fake people run on the same machine as the server and are not counted
 * in the server's numbers. Voice and video go directly between people
 * unless the voice relay is turned on, so calls are not part of this.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[argv[i].slice(2)] = true;
    else { out[argv[i].slice(2)] = next; i++; }
  }
  return out;
}
const args = readArgs(process.argv.slice(2));
const SIZES = String(args.sizes || '10,50,100,250,500,1000').split(',').map(n => parseInt(n, 10)).filter(n => n >= 2);
const PORT = parseInt(args.port, 10) || 3990;
const SECONDS = Math.max(5, parseFloat(args.seconds) || 20);

// Messages a second for a community of this size: one a second for a small
// group, rising to twenty a second for thousands. A real server this size
// sees a small fraction of that.
function chatRate(users) {
  if (users <= 25) return 1;
  if (users <= 100) return 2;
  if (users <= 250) return 5;
  if (users <= 500) return 10;
  if (users <= 1000) return 15;
  return 20;
}

const mb = b => b == null ? '-' : `${Math.round(b / 2 ** 20)} MB`;
const pc = v => v == null ? '-' : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
const ms = v => v == null ? '-' : `${Math.round(v)} ms`;

function runOne(users) {
  const rate = chatRate(users);
  const out = path.join(os.tmpdir(), `haven-benchmark-${process.pid}-${users}.json`);
  process.stdout.write(`  ${users} people at ${rate} messages a second... `);
  const run = spawnSync(process.execPath, [
    path.join(__dirname, 'loadtest.js'),
    '--users', String(users), '--rate', String(rate), '--chat-seconds', String(SECONDS),
    '--port', String(PORT), '--json', out,
  ], { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0 || !fs.existsSync(out)) {
    console.log('failed');
    console.error((run.stderr || run.stdout || '').trim().split('\n').slice(-5).join('\n'));
    return null;
  }
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(out, { force: true });
  const phase = start => result.phases.find(p => p.phase.startsWith(start));
  const empty = phase('the server running');
  const quiet = result.phases.find(p => p.phase.endsWith('nobody talking'));
  const chat = phase('chat:');
  const arrive = result.phases.find(p => p.phase.endsWith('connect and open the channel'));
  const failed = result.phases.reduce((n, p) => n + Object.values(p.errors || {}).reduce((a, b) => a + b, 0), 0);
  console.log('done');
  return {
    users, rate,
    startupMs: result.startupMs,
    memoryEmpty: empty?.server?.memoryEnd ?? null,
    memoryPeak: result.memoryPeak,
    cpuQuiet: quiet?.server?.cpuAverage ?? null,
    cpuChat: chat?.server?.cpuAverage ?? null,
    cpuChatBusiest: chat?.server?.cpuBusiestSecond ?? null,
    cpuArriveBusiest: arrive?.server?.cpuBusiestSecond ?? null,
    delayTypical: chat?.messages?.p50 ?? null,
    delayBad: chat?.messages?.p95 ?? null,
    delivered: chat?.messages ? `${chat.messages.deliveries} of ${chat.messages.expected}` : null,
    sentPerSecond: chat ? Math.round(chat.sentToClients / Math.max(1, SECONDS)) : null,
    errors: failed,
  };
}

function main() {
  const cpu = os.cpus();
  const machine = `${cpu[0]?.model.trim() || 'unknown processor'} (${cpu.length} threads), ${(os.totalmem() / 2 ** 30).toFixed(0)} GB memory, ${os.type()} ${os.release()} ${os.arch()}, Node ${process.versions.node}`;
  console.log(`Haven benchmark on ${machine}`);
  console.log(`Sizes: ${SIZES.join(', ')}. Each run takes a minute or two.\n`);

  const rows = SIZES.map(runOne).filter(Boolean);
  if (!rows.length) { console.error('\nNo run finished.'); process.exitCode = 1; return; }

  const started = rows.map(r => r.startupMs).filter(Boolean);
  console.log(`\nMachine: ${machine}`);
  if (started.length) console.log(`Server start: about ${(started.reduce((a, b) => a + b, 0) / started.length / 1000).toFixed(1)}s. Memory with nobody connected: ${mb(rows[0].memoryEmpty)}.`);
  console.log('');
  console.log('| People online | Memory (peak) | Processor, nobody talking | Chat rate | Processor while chatting (busiest second) | Message delay (typical / slow) | Sent to clients |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(`| ${r.users} | ${mb(r.memoryPeak)} | ${pc(r.cpuQuiet)} | ${r.rate} msg/s | ${pc(r.cpuChat)} (${pc(r.cpuChatBusiest)}) | ${ms(r.delayTypical)} / ${ms(r.delayBad)} | ${Math.round(r.sentPerSecond / 1024)} KB/s |`);
  }
  console.log('\nProcessor numbers are a share of ONE core: 25% is a quarter of a single core.');
  const bad = rows.filter(r => r.errors);
  for (const r of bad) console.log(`Note: the ${r.users} run reported ${r.errors} errors; run scripts/loadtest.js --users ${r.users} to see them.`);

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ machine, when: new Date().toISOString(), chatSeconds: SECONDS, rows }, null, 2));
    console.log(`Results written to ${args.json}`);
  }
}

main();
