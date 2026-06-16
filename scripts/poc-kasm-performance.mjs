import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const displayNumber = Number(process.env.POC_DISPLAY || 89);
const display = `:${displayNumber}`;
const kasmPort = Number(process.env.POC_KASM_PORT || 7189);
const nativePort = Number(process.env.POC_NATIVE_PORT || 6189);
const geometry = process.env.POC_GEOMETRY || "2560x1440";
const depth = process.env.POC_DEPTH || "24";
const sampleSeconds = Number(process.env.POC_SAMPLE_SECONDS || 15);
const workloadMode = process.env.POC_WORKLOAD || "animated-scroll";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kasm-poc3-"));
const children = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

async function runPoc() {
  const authFile = path.join(tmpRoot, "Xauthority");
  const cookie = crypto.randomBytes(16).toString("hex");
  runChecked("xauth", ["-f", authFile, "add", display, ".", cookie]);

  const workloadServer = await startWorkloadServer();
  const workloadUrl = `http://127.0.0.1:${workloadServer.port}/workload.html`;

  const xvnc = startProcess("Xvnc", [
    display,
    "-geometry",
    geometry,
    "-depth",
    depth,
    "-auth",
    authFile,
    "-rfbport",
    "0",
    "-websocketPort",
    String(kasmPort),
    "-localhost",
    "-publicIP",
    "127.0.0.1",
    "-SecurityTypes",
    "None",
    "-DisableBasicAuth",
    "1",
    "-sslOnly",
    "0",
    "-UseIPv6",
    "0",
    "-httpd",
    "/usr/share/kasmvnc/www",
    "-Log",
    "*:stderr:30",
  ], {
    logPath: path.join(tmpRoot, "xvnc.log"),
    env: { XAUTHORITY: authFile },
  });
  await waitForTcp("127.0.0.1", kasmPort, 5000);
  await sleep(500);

  const xdpyinfo = spawnSync("xdpyinfo", [], {
    encoding: "utf8",
    env: { ...process.env, DISPLAY: display, XAUTHORITY: authFile },
  });
  const hasDamage = xdpyinfo.status === 0 && /\bDAMAGE\b/.test(xdpyinfo.stdout);

  const desktopChrome = startProcess("google-chrome", [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-fre",
    "--ozone-platform=x11",
    `--user-data-dir=${path.join(tmpRoot, "desktop-chrome")}`,
    `--window-size=${geometry.replace("x", ",")}`,
    "--window-position=0,0",
    "--new-window",
    "--autoplay-policy=no-user-gesture-required",
    workloadUrl,
  ], {
    logPath: path.join(tmpRoot, "desktop-chrome.log"),
    env: { DISPLAY: display, XAUTHORITY: authFile },
  });
  await sleep(5000);

  const variants = [];
  variants.push(await runVariant({
    name: "damage",
    noxdamage: false,
    xvncPid: xvnc.pid,
    chromePid: desktopChrome.pid,
    authFile,
  }));
  variants.push(await runVariant({
    name: "noxdamage",
    noxdamage: true,
    xvncPid: xvnc.pid,
    chromePid: desktopChrome.pid,
    authFile,
  }));

  workloadServer.close();

  return {
    ok: true,
    tmpRoot,
    display,
    geometry,
    workloadMode,
    sampleSeconds,
    hasDamage,
    workloadUrl,
    variants,
  };
}

async function runVariant({ name, noxdamage, xvncPid, chromePid, authFile }) {
  const x11vnc = startProcess("x11vnc", [
    "-display",
    display,
    "-auth",
    authFile,
    "-listen",
    "127.0.0.1",
    "-no6",
    "-noipv6",
    "-rfbport",
    String(nativePort),
    "-rfbportv6",
    "-1",
    "-nopw",
    "-forever",
    "-shared",
    "-repeat",
    ...(noxdamage ? ["-noxdamage"] : []),
    "-o",
    path.join(tmpRoot, `x11vnc-${name}.log`),
  ], { logPath: path.join(tmpRoot, `x11vnc-${name}.stderr.log`) });
  await waitForTcp("127.0.0.1", nativePort, 5000);

  const kasmClient = startProcess("google-chrome", [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${path.join(tmpRoot, `kasm-client-${name}`)}`,
    "--window-size=2560,1440",
    `http://127.0.0.1:${kasmPort}/vnc.html?autoconnect=1&resize=scale&enable_webp=true&enable_threading=true`,
  ], { logPath: path.join(tmpRoot, `kasm-client-${name}.log`) });

  const nativeClient = new RfbLoadClient("127.0.0.1", nativePort);
  await nativeClient.connect();
  await sleep(5000);

  const pidstat = startProcess("pidstat", [
    "-h",
    "-u",
    "-p",
    [xvncPid, x11vnc.pid, chromePid, kasmClient.pid].join(","),
    "1",
    String(sampleSeconds),
  ], { logPath: path.join(tmpRoot, `pidstat-${name}.log`) });
  await waitForExit(pidstat, (sampleSeconds + 5) * 1000);

  const sockets = listeningSocketsForPids([x11vnc.pid]);
  nativeClient.stop();
  await terminateProcess(kasmClient);
  await terminateProcess(x11vnc);
  await sleep(500);

  const x11vncLog = readFile(path.join(tmpRoot, `x11vnc-${name}.log`));
  const pidstatText = readFile(path.join(tmpRoot, `pidstat-${name}.log`));

  return {
    name,
    noxdamage,
    x11vncPid: x11vnc.pid,
    kasmClientPid: kasmClient.pid,
    nativeClient: nativeClient.stats,
    listenSockets: sockets,
    x11vncUsedDamage: /X DAMAGE available/.test(x11vncLog) && !noxdamage,
    cpuAverages: parsePidstatAverages(pidstatText),
    logs: {
      x11vnc: path.join(tmpRoot, `x11vnc-${name}.log`),
      pidstat: path.join(tmpRoot, `pidstat-${name}.log`),
    },
  };
}

class RfbLoadClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffers = [];
    this.buffered = 0;
    this.waiters = [];
    this.running = false;
    this.timer = null;
    this.bytesPerPixel = 4;
    this.width = 0;
    this.height = 0;
    this.stats = {
      updates: 0,
      rects: 0,
      bytes: 0,
      encodings: {},
      errors: [],
    };
  }

  async connect() {
    this.socket = net.connect(this.port, this.host);
    this.socket.on("data", (chunk) => {
      this.buffers.push(chunk);
      this.buffered += chunk.length;
      this.stats.bytes += chunk.length;
      this.flushWaiters();
    });
    this.socket.on("error", (error) => {
      this.stats.errors.push(error.message);
    });
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });

    const protocol = (await this.readExact(12)).toString("ascii");
    this.socket.write(Buffer.from(protocol, "ascii"));
    const securityTypeCount = (await this.readExact(1))[0];
    const securityTypes = await this.readExact(securityTypeCount);
    if (!securityTypes.includes(1)) {
      throw new Error(`rfb_security_none_unavailable:${[...securityTypes].join(",")}`);
    }
    this.socket.write(Buffer.from([1]));
    const securityResult = (await this.readExact(4)).readUInt32BE(0);
    if (securityResult !== 0) throw new Error(`rfb_security_failed:${securityResult}`);
    this.socket.write(Buffer.from([1]));
    const serverInit = await this.readExact(24);
    this.width = serverInit.readUInt16BE(0);
    this.height = serverInit.readUInt16BE(2);
    this.bytesPerPixel = serverInit[4] / 8;
    const nameLength = serverInit.readUInt32BE(20);
    if (nameLength > 0) await this.readExact(nameLength);

    this.sendSetEncodings([16, 1, 0]);
    this.sendFramebufferUpdateRequest(false);
    this.running = true;
    this.readLoop().catch((error) => {
      this.stats.errors.push(error.message);
      this.stop();
    });
    this.timer = setInterval(() => {
      if (this.running) this.sendFramebufferUpdateRequest(true);
    }, 150);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.socket) this.socket.destroy();
  }

  sendSetEncodings(encodings) {
    const buffer = Buffer.alloc(4 + encodings.length * 4);
    buffer[0] = 2;
    buffer.writeUInt16BE(encodings.length, 2);
    encodings.forEach((encoding, index) => buffer.writeInt32BE(encoding, 4 + index * 4));
    this.socket.write(buffer);
  }

  sendFramebufferUpdateRequest(incremental) {
    const buffer = Buffer.alloc(10);
    buffer[0] = 3;
    buffer[1] = incremental ? 1 : 0;
    buffer.writeUInt16BE(0, 2);
    buffer.writeUInt16BE(0, 4);
    buffer.writeUInt16BE(this.width, 6);
    buffer.writeUInt16BE(this.height, 8);
    this.socket.write(buffer);
  }

  async readLoop() {
    while (this.running) {
      const messageType = (await this.readExact(1))[0];
      if (messageType === 0) {
        await this.readExact(1);
        const rectCount = (await this.readExact(2)).readUInt16BE(0);
        this.stats.updates += 1;
        this.stats.rects += rectCount;
        for (let index = 0; index < rectCount; index += 1) {
          const header = await this.readExact(12);
          const width = header.readUInt16BE(4);
          const height = header.readUInt16BE(6);
          const encoding = header.readInt32BE(8);
          this.stats.encodings[encoding] = (this.stats.encodings[encoding] || 0) + 1;
          if (encoding === 0) {
            await this.readExact(width * height * this.bytesPerPixel);
          } else if (encoding === 1) {
            await this.readExact(4);
          } else if (encoding === 16) {
            const length = (await this.readExact(4)).readUInt32BE(0);
            await this.readExact(length);
          } else {
            throw new Error(`unsupported_rfb_encoding:${encoding}`);
          }
        }
      } else if (messageType === 2) {
        // Bell.
      } else if (messageType === 3) {
        await this.readExact(3);
        const length = (await this.readExact(4)).readUInt32BE(0);
        await this.readExact(length);
      } else {
        throw new Error(`unsupported_rfb_message:${messageType}`);
      }
    }
  }

  readExact(length) {
    if (this.buffered >= length) return Promise.resolve(this.take(length));
    return new Promise((resolve, reject) => {
      this.waiters.push({ length, resolve, reject });
    });
  }

  take(length) {
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.buffers[0];
      const n = Math.min(chunk.length, length - offset);
      chunk.copy(out, offset, 0, n);
      offset += n;
      this.buffered -= n;
      if (n === chunk.length) {
        this.buffers.shift();
      } else {
        this.buffers[0] = chunk.subarray(n);
      }
    }
    return out;
  }

  flushWaiters() {
    while (this.waiters.length > 0 && this.buffered >= this.waiters[0].length) {
      const waiter = this.waiters.shift();
      waiter.resolve(this.take(waiter.length));
    }
  }
}

function startWorkloadServer() {
  const server = http.createServer((req, res) => {
    if (req.url !== "/workload.html") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(workloadHtml());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => server.close(),
      });
    });
  });
}

function workloadHtml() {
  if (workloadMode === "scroll") {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; font-family: Arial, sans-serif; background: #f7f8fa; color: #17202a; }
    .bar { position: sticky; top: 0; height: 72px; background: #fff; border-bottom: 1px solid #d0d7de; display: flex; align-items: center; padding: 0 24px; font-size: 24px; z-index: 2; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 16px; }
    .card { height: 220px; border: 1px solid #d0d7de; border-radius: 8px; background: #fff; padding: 18px; box-sizing: border-box; }
    .thumb { height: 96px; border-radius: 6px; background: linear-gradient(135deg, #0969da, #1a7f37, #bf8700); margin-bottom: 12px; }
    .line { height: 12px; background: #d8dee4; border-radius: 99px; margin: 10px 0; }
  </style>
</head>
<body>
  <div class="bar">KasmVNC POC scroll workload <span id="n" style="margin-left:16px"></span></div>
  <div class="grid">${Array.from({ length: 320 }, (_, i) => `<div class="card"><div class="thumb" style="filter:hue-rotate(${i * 5}deg)"></div><b>Card ${i}</b><div class="line"></div><div class="line" style="width:72%"></div><div class="line" style="width:48%"></div></div>`).join("")}</div>
  <script>
    let tick = 0;
    setInterval(() => {
      tick++;
      document.getElementById('n').textContent = 'tick ' + tick + ' scrollY ' + Math.round(scrollY);
      const max = document.documentElement.scrollHeight - innerHeight;
      const next = scrollY + 52;
      scrollTo(0, next >= max ? 0 : next);
    }, 50);
  </script>
</body>
</html>`;
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; font-family: Arial, sans-serif; background: #101418; color: white; }
    .hero { position: sticky; top: 0; height: 220px; background: #111; z-index: 2; overflow: hidden; }
    canvas { width: 100vw; height: 220px; display: block; }
    .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; padding: 16px; }
    .card { height: 180px; border-radius: 8px; background: linear-gradient(135deg, #1f6feb, #2ea043, #d29922); box-shadow: inset 0 0 0 1px rgba(255,255,255,.2); }
    .text { padding: 18px; font-size: 22px; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="hero"><canvas id="c" width="2560" height="440"></canvas></div>
  <div class="text">KasmVNC POC Chrome workload: animated canvas, continuous scrolling, frequent composited repaints.</div>
  <div class="grid">${Array.from({ length: 240 }, (_, i) => `<div class="card" style="filter:hue-rotate(${i * 9}deg)"></div>`).join("")}</div>
  <script>
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    let frame = 0;
    function draw() {
      frame++;
      const w = canvas.width, h = canvas.height;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, 'hsl(' + (frame % 360) + ' 80% 45%)');
      g.addColorStop(1, 'hsl(' + ((frame * 3) % 360) + ' 80% 55%)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 80; i++) {
        ctx.fillStyle = 'rgba(255,255,255,' + (0.15 + (i % 5) * 0.08) + ')';
        const x = (Math.sin(frame / 17 + i) * 0.5 + 0.5) * w;
        const y = (Math.cos(frame / 23 + i * 2) * 0.5 + 0.5) * h;
        ctx.fillRect(x, y, 160 + (i % 7) * 30, 12 + (i % 9) * 6);
      }
      ctx.fillStyle = 'white';
      ctx.font = 'bold 56px Arial';
      ctx.fillText('frame ' + frame + ' scrollY ' + Math.round(scrollY), 48, 110);
      requestAnimationFrame(draw);
    }
    draw();
    setInterval(() => {
      const max = document.documentElement.scrollHeight - innerHeight;
      const next = scrollY + 42;
      scrollTo(0, next >= max ? 0 : next);
    }, 32);
  </script>
</body>
</html>`;
}

function parsePidstatAverages(text) {
  const samples = new Map();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9 || cols[0].startsWith("#") || cols[0] === "Linux") continue;
    const pid = Number(cols[2]);
    const cpu = Number(cols[7]);
    if (!Number.isFinite(pid) || !Number.isFinite(cpu)) continue;
    const command = cols.slice(9).join(" ");
    const bucket = samples.get(pid) || {
      pid,
      command,
      samples: 0,
      cpuSum: 0,
      cpuMax: 0,
      userSum: 0,
      systemSum: 0,
    };
    bucket.samples += 1;
    bucket.cpuSum += cpu;
    bucket.cpuMax = Math.max(bucket.cpuMax, cpu);
    bucket.userSum += Number(cols[3]) || 0;
    bucket.systemSum += Number(cols[4]) || 0;
    samples.set(pid, bucket);
  }
  return [...samples.values()].map((bucket) => ({
    pid: bucket.pid,
    command: bucket.command,
    samples: bucket.samples,
    avgCpu: Number((bucket.cpuSum / bucket.samples).toFixed(2)),
    maxCpu: Number(bucket.cpuMax.toFixed(2)),
    avgUser: Number((bucket.userSum / bucket.samples).toFixed(2)),
    avgSystem: Number((bucket.systemSum / bucket.samples).toFixed(2)),
  }));
}

function listeningSocketsForPids(pids) {
  const result = spawnSync("ss", ["-ltnpH"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => pids.some((pid) => line.includes(`pid=${pid},`)))
    .map((line) => {
      const local = line.split(/\s+/)[3] || "";
      return { local, line };
    });
}

function startProcess(command, args, options = {}) {
  const log = fs.createWriteStream(options.logPath, { flags: "a" });
  const proc = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.pipe(log, { end: false });
  proc.stderr.pipe(log, { end: false });
  children.push(proc);
  return proc;
}

function stopProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch {}
}

async function terminateProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  stopProcess(proc);
  const exited = await waitForExitOrTimeout(proc, 1000);
  if (!exited && proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill("SIGKILL");
    } catch {}
    await waitForExitOrTimeout(proc, 1000);
  }
}

function cleanup() {
  for (const proc of [...children].reverse()) stopProcess(proc);
  setTimeout(() => {
    for (const proc of [...children].reverse()) {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
    }
  }, 1000).unref?.();
}

function waitForExitOrTimeout(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once("exit", onExit);
  });
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process_timeout:${proc.pid}`)), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForTcp(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await sleep(100);
  }
  throw new Error(`tcp_not_ready:${host}:${port}`);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

try {
  const result = await runPoc();
  console.log(JSON.stringify(result, null, 2));
} finally {
  cleanup();
}
