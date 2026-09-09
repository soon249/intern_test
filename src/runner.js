import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Executes untrusted candidate Python in a fresh interpreter subprocess:
//   python -I -S solution.py   (isolated mode: no env/user site-packages, stdlib only)
// with a hard kill timer and output caps. This is subprocess-level isolation —
// adequate for an internal low-stakes test, not container-grade. For hardened
// isolation run this module's worker inside a locked-down container.
// (The spec's rule is honoured: we never *pretend* this is stronger than it is.)

const OUTPUT_CAP = 100_000;
let pythonBinPromise = null;

function trySpawn(bin, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    let p;
    try {
      p = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve(false);
    }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; p.kill(); resolve(false); } }, timeoutMs);
    p.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
    p.on('close', code => { if (!settled) { settled = true; clearTimeout(timer); resolve(code === 0); } });
  });
}

async function resolvePython() {
  if (!pythonBinPromise) {
    pythonBinPromise = (async () => {
      if (process.env.PYTHON_BIN) {
        if (await trySpawn(process.env.PYTHON_BIN, ['-c', 'print(1)'])) return [process.env.PYTHON_BIN];
        return null;
      }
      if (await trySpawn('python', ['-c', 'print(1)'])) return ['python'];
      if (await trySpawn('py', ['-3', '-c', 'print(1)'])) return ['py', '-3'];
      return null;
    })();
  }
  return pythonBinPromise;
}

export async function pythonAvailable() {
  return (await resolvePython()) != null;
}

export async function runPython(code, { timeoutMs = 4000 } = {}) {
  const bin = await resolvePython();
  if (!bin) return { ok: false, error: 'NO_PYTHON', message: 'Python interpreter not available on the server' };

  const dir = mkdtempSync(path.join(tmpdir(), 'iap-run-'));
  const file = path.join(dir, 'solution.py');
  writeFileSync(file, code, 'utf8');

  return new Promise(resolve => {
    let stdout = '', stderr = '';
    let p;
    try {
      p = spawn(bin[0], [...bin.slice(1), '-I', '-S', file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      return resolve({ ok: false, error: 'SPAWN_ERROR', message: String(err.message) });
    }
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { p.kill('SIGKILL'); } catch { /* already dead */ } }, timeoutMs);

    p.stdout.on('data', d => { if (stdout.length < OUTPUT_CAP) stdout += d.toString('utf8'); });
    p.stderr.on('data', d => { if (stderr.length < OUTPUT_CAP) stderr += d.toString('utf8'); });
    p.on('error', err => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ ok: false, error: 'SPAWN_ERROR', message: String(err.message) });
    });
    p.on('close', exitCode => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({
        ok: true,
        exitCode,
        timedOut: killed,
        stdout,
        stderr: stderr.slice(0, 4000)
      });
    });
  });
}
