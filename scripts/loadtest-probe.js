'use strict';
// Loaded into the throwaway server by scripts/loadtest.js (node --require).
// Twice a second it reports how much memory and processor time the server
// has used so far. It does nothing unless the load tester started the server.

if (process.send) {
  const timer = setInterval(() => {
    if (!process.connected) return;
    const cpu = process.cpuUsage();
    process.send({ loadtestStats: { at: Date.now(), rss: process.memoryUsage.rss(), cpuMicros: cpu.user + cpu.system } });
  }, 500);
  // Neither the timer nor the channel may keep a stopping server alive.
  timer.unref();
  if (process.channel) process.channel.unref();
}
