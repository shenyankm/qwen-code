/** Fork-only real Windows ConPTY probe; production source is unchanged. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32', 'Run on a real Windows runner');
const artifacts = path.resolve('artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const report = {
  platform: process.platform,
  release: os.release(),
  node: process.version,
  scenarios: [],
};
const save = () =>
  fs.writeFileSync(
    path.join(artifacts, 'windows-pty-report.json'),
    JSON.stringify(report, null, 2),
  );
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
let current;
const originals = {
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
};
for (const name of Object.keys(originals)) {
  childProcess[name] = function (...args) {
    if (current && String(args[0]).toLowerCase().includes('taskkill')) {
      current.events.push({
        event: name,
        command: String(args[0]),
        args: args[1],
        at: performance.now(),
        stack: new Error().stack,
      });
    }
    return Reflect.apply(originals[name], this, args);
  };
}
syncBuiltinESMExports();
const { ShellExecutionService } = await import(
  '../packages/core/dist/src/services/shellExecutionService.js'
);
const { getPty } = await import('../packages/core/dist/src/utils/getPty.js');
const { loadXtermHeadless } = await import(
  '../packages/core/dist/src/utils/load-xterm-headless.js'
);
const { getShellConfiguration } = await import(
  '../packages/core/dist/src/utils/shell-utils.js'
);
const backend = await getPty();
assert.ok(backend, 'Native node-pty must load; no fallback accepted');
const { Terminal } = await loadXtermHeadless();
report.backend = backend.name;
report.shell = getShellConfiguration();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-9071-win-'));
const fixture = path.join(root, 'fixture.cjs');
fs.writeFileSync(
  fixture,
  `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dir = process.argv[2];
if (process.argv[3] === 'child') {
  fs.writeFileSync(path.join(dir, 'child-ready'), String(process.pid));
  setInterval(() => fs.writeFileSync(path.join(dir, 'heartbeat'), String(Date.now())), 30);
  setTimeout(() => process.exit(0), 120000);
} else {
  const child = spawn(process.execPath, [__filename, dir, 'child'], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ parent: process.pid, child: child.pid }));
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(dir, 'release'))) {
      clearInterval(timer);
      fs.writeFileSync(path.join(dir, 'exiting'), String(Date.now()));
      process.exit(0);
    }
  }, 2);
  setTimeout(() => process.exit(98), 90000).unref();
}
`,
);
const waitFor = async (predicate, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'Timed out waiting for real process state');
    await delay(10);
  }
};
let activePids = [];
const clean = () => {
  for (const pid of activePids) {
    if (alive(pid))
      originals.spawnSync('taskkill.exe', ['/f', '/t', '/pid', String(pid)], {
        windowsHide: true,
      });
  }
  activePids = [];
};
const watchdog = setTimeout(() => {
  report.fatal = 'Overall ten-minute watchdog expired';
  save();
  clean();
  process.exit(2);
}, 600000);

async function scenario(mode, index, raceDelay = 0) {
  const entry = { mode, index, raceDelay, events: [] };
  report.scenarios.push(entry);
  current = entry;
  const dir = path.join(root, `${index}-${mode}`);
  fs.mkdirSync(dir);
  const controller = new AbortController();
  let pty;
  let rawExit;
  let settled = false;
  let abortTimer;
  const abort = () => {
    entry.events.push({
      event: 'abort',
      at: performance.now(),
      shellAlive: alive(pty.pid),
      nativeExitSeen: Boolean(rawExit),
      settled,
    });
    controller.abort();
  };
  const instrumented = {
    name: backend.name,
    module: {
      spawn(...args) {
        pty = backend.module.spawn(...args);
        activePids.push(pty.pid);
        entry.shellPid = pty.pid;
        entry.spawnOptions = {
          useConptyDll: args[2].useConptyDll,
          executable: args[0],
        };
        const onExit = pty.onExit.bind(pty);
        Object.defineProperty(pty, 'onExit', {
          configurable: true,
          value: (listener) =>
            onExit((event) => {
              rawExit = {
                event: 'native-exit',
                ...event,
                shellAlive: alive(pty.pid),
                at: performance.now(),
              };
              entry.events.push(rawExit);
              // Real native event, real OS liveness. Only delivery to the service is held.
              if (mode === 'controlled-before-exit-delivery') abort();
              listener(event);
              if (mode === 'controlled-after-exit-delivery') abort();
            }),
        });
        return pty;
      },
    },
  };
  try {
    const command = `node "${fixture}" "${dir}"`;
    const handle = ShellExecutionService.executeWithPty(
      command,
      root,
      () => {},
      controller.signal,
      {},
      instrumented,
      Terminal,
    );
    const resultPromise = handle.result.then((value) => {
      settled = true;
      return value;
    });
    await waitFor(
      () =>
        fs.existsSync(path.join(dir, 'ready.json')) &&
        fs.existsSync(path.join(dir, 'child-ready')),
    );
    const pids = JSON.parse(
      fs.readFileSync(path.join(dir, 'ready.json'), 'utf8'),
    );
    entry.fixturePids = pids;
    activePids.push(pids.parent, pids.child);
    assert.ok(
      alive(pids.child),
      'Detached child must be alive before scenario',
    );
    if (mode === 'live-cancel') abort();
    else {
      fs.writeFileSync(path.join(dir, 'release'), '1');
      entry.events.push({ event: 'release', at: performance.now() });
      if (mode === 'natural-race') abortTimer = setTimeout(abort, raceDelay);
      if (mode === 'controlled-kernel-exit-before-event') {
        const deadline = Date.now() + 10000;
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        while (alive(pty.pid) && Date.now() < deadline) {
          Atomics.wait(sleeper, 0, 0, 2);
        }
        assert.equal(
          alive(pty.pid),
          false,
          'Real kernel process must have exited',
        );
        assert.equal(
          rawExit,
          undefined,
          'Native exit callback must still be pending',
        );
        entry.events.push({
          event: 'controlled-event-loop-stall-ended',
          at: performance.now(),
        });
        abort();
      }
    }
    await waitFor(() => settled, 30000);
    clearTimeout(abortTimer);
    const result = await resultPromise;
    entry.result = {
      exitCode: result.exitCode,
      signal: result.signal,
      aborted: result.aborted,
      executionMethod: result.executionMethod,
      error: result.error?.message,
    };
    assert.equal(
      result.executionMethod,
      backend.name,
      'No child_process fallback',
    );
    assert.ok(rawExit, 'Must observe actual native exit callback');
    await delay(350);
    entry.childAlive = alive(pids.child);
    entry.shellAliveAfterSettle = alive(pty.pid);
    entry.heartbeat = fs.existsSync(path.join(dir, 'heartbeat'))
      ? fs.statSync(path.join(dir, 'heartbeat')).mtimeMs
      : null;
    entry.childHeartbeatFresh =
      entry.heartbeat !== null && Date.now() - entry.heartbeat < 300;
    const taskkills = entry.events.filter((event) => event.command);
    entry.treeKillCount = taskkills.filter((event) =>
      event.args.includes('/t'),
    ).length;
    entry.finalizerTreeKills = taskkills.filter(
      (event) =>
        event.args.includes('/t') && event.stack.includes('windowsKillPid'),
    ).length;
    if (mode === 'live-cancel') {
      assert.ok(
        result.aborted,
        'Genuine cancellation must be classified aborted',
      );
      assert.equal(
        entry.childAlive,
        false,
        'Genuine cancellation must kill detached descendant',
      );
      assert.ok(entry.treeKillCount > 0, 'Must observe real taskkill /t');
    } else if (mode !== 'natural-race') {
      assert.equal(result.exitCode, 0, 'Natural completion must retain exit 0');
      assert.equal(
        result.aborted,
        false,
        'Natural completion must not become aborted',
      );
      assert.ok(
        entry.childAlive && entry.childHeartbeatFresh,
        'Detached child must survive natural completion',
      );
      assert.equal(
        entry.treeKillCount,
        0,
        'Natural completion must not dispatch a tree kill',
      );
    } else {
      const aborted = entry.events.find((event) => event.event === 'abort');
      entry.abortBeforeNativeExit = Boolean(aborted && aborted.at < rawExit.at);
      entry.abortAfterDeadLeaderBeforeNativeExit = Boolean(
        aborted && !aborted.shellAlive && aborted.at < rawExit.at,
      );
      if (entry.abortAfterDeadLeaderBeforeNativeExit && result.exitCode === 0) {
        assert.ok(
          entry.childAlive && entry.childHeartbeatFresh,
          'Abort after real dead leader must preserve detached child',
        );
        assert.equal(
          entry.treeKillCount,
          0,
          'Dead leader must not permit tree kill',
        );
      }
      if (result.aborted)
        assert.equal(
          entry.childAlive,
          false,
          'Actual cancellation must kill child',
        );
      entry.cleanExitChildLost =
        result.exitCode === 0 && !result.aborted && !entry.childAlive;
      assert.equal(
        entry.cleanExitChildLost,
        false,
        'Clean non-aborted completion must preserve detached child',
      );
    }
    entry.status = 'PASS';
  } catch (error) {
    entry.status = 'FAIL';
    entry.error = error.stack;
  } finally {
    clearTimeout(abortTimer);
    current = undefined;
    clean();
    console.log(JSON.stringify(entry));
    save();
  }
}

try {
  await scenario('natural-completion', 0);
  await scenario('live-cancel', 1);
  await scenario('controlled-before-exit-delivery', 2);
  await scenario('controlled-after-exit-delivery', 3);
  await scenario('controlled-kernel-exit-before-event', 28);
  for (let i = 0; i < 24; i++)
    await scenario('natural-race', i + 4, [0, 2, 5, 10, 20, 40][i % 6]);
  const races = report.scenarios.filter(
    (entry) => entry.mode === 'natural-race',
  );
  report.coverage = {
    naturalTrials: races.length,
    abortBeforeNativeExit: races.filter((entry) => entry.abortBeforeNativeExit)
      .length,
    abortAfterDeadLeaderBeforeNativeExit: races.filter(
      (entry) => entry.abortAfterDeadLeaderBeforeNativeExit,
    ).length,
    nativeExitWhileShellAlive: report.scenarios.filter((entry) =>
      entry.events.some(
        (event) => event.event === 'native-exit' && event.shellAlive,
      ),
    ).length,
    cleanExitChildLost: races.filter((entry) => entry.cleanExitChildLost)
      .length,
    finalizerTreeKills: report.scenarios.reduce(
      (sum, entry) => sum + (entry.finalizerTreeKills ?? 0),
      0,
    ),
  };
  report.status = report.scenarios.some((entry) => entry.status === 'FAIL')
    ? 'FAIL'
    : 'CONTROLS_PASS';
  report.scope =
    'Real ConPTY and real processes; controlled cases reorder native exit callback delivery or stall the JS event loop until OS liveness reports the real shell exited. No fabricated exit, liveness, PTY, taskkill, or result. executeWithPty seam bypasses CLI/model orchestration.';
  report.raceVerdict =
    report.coverage.abortAfterDeadLeaderBeforeNativeExit > 0
      ? 'DEAD_LEADER_RACE_OBSERVED'
      : 'NATURAL_DEAD_LEADER_RACE_NOT_HIT_INCONCLUSIVE';
  report.finalizerConcern =
    report.coverage.nativeExitWhileShellAlive > 0
      ? 'CHECK_SCENARIO_EVENTS'
      : 'LIVE_PID_AFTER_NATIVE_EXIT_NOT_OBSERVED_INCONCLUSIVE';
  save();
  console.log(
    JSON.stringify({
      status: report.status,
      coverage: report.coverage,
      raceVerdict: report.raceVerdict,
      finalizerConcern: report.finalizerConcern,
    }),
  );
  process.exitCode = report.status === 'FAIL' ? 1 : 0;
} finally {
  clearTimeout(watchdog);
  clean();
  for (const name of Object.keys(originals))
    childProcess[name] = originals[name];
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
