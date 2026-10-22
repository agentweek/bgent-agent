#!/usr/bin/env node
// Bgent agent skill — for Binance Agents only.
// Transactions are signed by the Binance Agentic Wallet through its official CLI (`baw contract-call`).
// Reads use Foundry's `cast`. Zero npm dependencies.
//
//   bgent setup                       check the Agentic Wallet (connected, developer mode, BSC address, Agent ID)
//   bgent explore                     one round: the result is known two blocks later and credited at once
//   bgent auto [--interval MIN]       keep exploring (default every 10 minutes)
//   bgent status                      claimable BGENT, today's rounds, current difficulty
//   bgent claim                       send all earned BGENT to this Agentic Wallet
//   bgent blocks                      list the Sealed Blocks this wallet holds (tier and value range)
//   bgent open --id ID                open a Sealed Block owned by this wallet
//   bgent send --id ID --to ADDRESS   transfer a sealed (unopened) block to another BNB Chain wallet
//
// Options: --risk 0|1|2 (steady / balanced / aggressive, default 0)  --agent-id ID  --name NAME (your .ai name)
//          --rpc URL  --deployments FILE
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(os.homedir(), ".bgent");
const CFG = path.join(HOME, "agent.json");
const BIN = process.env.BGENT_BIN || "node bgent.mjs";
const RPCS = [
  "https://bsc-dataseed1.binance.org", "https://bsc-dataseed2.binance.org", "https://bsc-dataseed3.binance.org",
  "https://bsc-dataseed4.binance.org", "https://bsc-dataseed1.defibit.io", "https://bsc-dataseed1.ninicoin.io",
  "https://bsc-rpc.publicnode.com", "https://bsc.drpc.org", "https://1rpc.io/bnb",
];

const argv = process.argv.slice(2);
const COMMANDS = ["setup", "explore", "auto", "status", "claim", "blocks", "open", "send", "help"];
const cmd = argv.find((a) => COMMANDS.includes(a)) || "help";
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const D = JSON.parse(fs.readFileSync(opt("deployments", path.join(HERE, "deployments.json")), "utf8"));
const TIER = ["Common", "Rare", "Epic", "Legendary", "Mythic"];
const WORLD = D.BgentWorld, SEALED = D.SealedBlock, AID = D.AgentID;
let RPC = opt("rpc", process.env.BGENT_RPC || "");

// ---------------- helpers ----------------
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (...a) => console.log(new Date().toLocaleString("en-GB", { hour12: false }), ...a);
const big = (x) => BigInt(String(x).split(" ")[0]);
const fmt = (wei) => { const w = big(wei); return `${w / 10n ** 18n}.${(w % 10n ** 18n).toString().padStart(18, "0").slice(0, 4)}`; };
function run(bin, args, quiet = false) {
  try { return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 }).trim(); }
  catch (e) { if (quiet) return null; throw new Error((e.stderr || e.stdout || e.message || "").toString().trim().split("\n").slice(0, 4).join(" ")); }
}
function pickRpc() {
  if (RPC) return RPC;
  for (let r = 0; r < 3; r++) for (const u of RPCS) if (run("cast", ["chain-id", "--rpc-url", u, "--rpc-timeout", "10"], true) === String(D.chainId)) return (RPC = u);
  throw new Error("cannot reach any BNB Smart Chain RPC");
}
function call(to, sig, ...args) {
  for (let i = 0; i < 3; i++) {
    const out = run("cast", ["call", to, sig, ...args.map(String), "--rpc-url", pickRpc(), "--rpc-timeout", "20"], true);
    if (out !== null) { const l = out.split("\n").map((s) => s.replace(/\s*\[.*\]$/, "").trim()); return l.length === 1 ? l[0] : l; }
    RPC = "";
  }
  throw new Error(`read failed: ${sig}`);
}
const blockNumber = () => Number(run("cast", ["block-number", "--rpc-url", pickRpc(), "--rpc-timeout", "15"]));

// ---------------- Binance Agentic Wallet (baw) ----------------
function baw(args) {
  const out = run("baw", [...args, "--json"]);
  let j; try { j = JSON.parse(out); } catch { throw new Error(`unexpected baw output: ${out.slice(0, 200)}`); }
  if (j.success === false) throw new Error(`baw ${args[0]} ${args[1] || ""}: ${j.error?.name || ""} ${j.error?.message || JSON.stringify(j.error)}`);
  return j.data ?? j;
}
function walletAddress() {
  const d = baw(["wallet", "address"]);
  const a = (d.addresses || []).find((x) => String(x.binanceChainId) === "56" || x.chainName === "BSC");
  if (!a) throw new Error("no BSC address in the Agentic Wallet");
  return a.address;
}
/** sign and send a contract call with the Agentic Wallet; resolves when `done()` becomes true on chain */
function bawSend(from, to, sig, args, label, done) {
  const data = run("cast", ["calldata", sig, ...args.map(String)]);
  const p = baw(["contract-call", "preview", "--binanceChainId", "56", "--from", from, "--to", to, "--inputData", data]);
  if (!p.requestId) throw new Error(`preview returned no requestId for ${label}`);
  const sim = p.simulationResult || {};
  if (sim.simulationErrorDetail) throw new Error(`${label} would fail: ${sim.simulationErrorDetail}`);
  const ex = baw(["contract-call", "execute", "--requestId", p.requestId]);
  if (ex.status === "PENDING_CONFIRMATION") log(`Confirm the "${label}" transaction in the Binance App…`);
  for (let i = 0; i < 200; i++) { if (done()) return ex.txHash || null; sleep(1500); }
  throw new Error(`${label}: not confirmed on chain after 5 minutes`);
}

// ---------------- Agent ID ----------------
function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return {}; } }
function saveCfg(c) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(c, null, 1)); }
function ownerOf(id) { try { return call(AID, "ownerOf(uint256)(address)", id); } catch { return null; } }
function blockOwner(id) { const o = run("cast", ["call", SEALED, "ownerOf(uint256)(address)", String(id), "--rpc-url", pickRpc(), "--rpc-timeout", "20"], true); return o ? o.trim() : null; }
function findAgentId(wallet) {
  const cfg = loadCfg();
  const given = opt("agent-id");
  const candidates = [];
  if (given) candidates.push(String(given));
  const bound = call(WORLD, "agentOfWallet(address)(uint256)", wallet);
  if (bound !== "0") return bound;
  if (cfg.agentId && cfg.wallet?.toLowerCase() === wallet.toLowerCase()) candidates.push(cfg.agentId);
  const name = opt("name");
  if (name) {
    const label = String(name).replace(/\.ai$/i, "");
    candidates.push(BigInt(run("cast", ["keccak", label])).toString());              // ERC-721 id = labelhash (ENS/SPACE ID style)
    candidates.push(BigInt(run("cast", ["namehash", `${label}.ai`])).toString());     // or namehash
  }
  for (const c of candidates) if (ownerOf(c)?.toLowerCase() === wallet.toLowerCase()) { saveCfg({ wallet, agentId: c }); return c; }
  // search mint/transfer logs to this wallet
  if (D.AgentIDFromBlock) {
    const latest = blockNumber();
    const topic = "0x000000000000000000000000" + wallet.slice(2).toLowerCase();
    for (let b = latest; b >= D.AgentIDFromBlock; b -= 5000) {
      const from = Math.max(D.AgentIDFromBlock, b - 4999);
      const out = run("cast", ["logs", "--from-block", String(from), "--to-block", String(b), "--address", AID,
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "", topic, "--json", "--rpc-url", pickRpc()], true);
      if (!out) continue;
      for (const l of JSON.parse(out).reverse()) {
        const id = BigInt(l.topics[3]).toString();
        if (ownerOf(id)?.toLowerCase() === wallet.toLowerCase()) { saveCfg({ wallet, agentId: id }); return id; }
      }
    }
  }
  throw new Error("this Agentic Wallet holds no Binance Agent ID (.ai). Claim one in the Binance App (Agentic Wallet banner), then run again — or pass --name <yourname> / --agent-id <id>");
}

// ---------------- rounds ----------------
function exploreOnce(wallet, id, risk) {
  const e = Number(call(WORLD, "currentEpoch()(uint256)"));
  const region = Math.floor(Math.random() * 8);
  const method = Number(call(WORLD, "signalOf(uint256,uint256)(uint256)", e, region));
  const n0 = big(call(WORLD, "nonceOf(uint256)(uint256)", id));
  const earned0 = big(call(WORLD, "earned(uint256)(uint256)", id));
  const next0 = big(call(SEALED, "nextId()(uint256)"));
  if (Number(call(WORLD, "statusOf(uint256)(uint8)", id)) === 1) sleep(3000);
  bawSend(wallet, WORLD, "explore(uint256,uint8,uint8,uint8)", [id, region, method, risk], "explore",
    () => big(call(WORLD, "nonceOf(uint256)(uint256)", id)) > n0);
  const nonce = n0 + 1n;
  while (Number(call(WORLD, "statusOf(uint256)(uint8)", id)) === 1) sleep(700);   // result block not produced yet
  if (Number(call(WORLD, "statusOf(uint256)(uint8)", id)) === 2)
    bawSend(wallet, WORLD, "settle(uint256)", [id], "settle", () => Number(call(WORLD, "statusOf(uint256)(uint8)", id)) === 0);
  const got = big(call(WORLD, "earned(uint256)(uint256)", id)) - earned0;
  if (got > 0n) log(`⛏  Round ${nonce}: earned ${fmt(got)} BGENT`);
  else log(`Round ${nonce}: nothing found (or today's emission is used up), reward 0`);
  const next1 = big(call(SEALED, "nextId()(uint256)"));
  for (let sid = next0; sid < next1; sid++) {
    if (blockOwner(sid)?.toLowerCase() !== wallet.toLowerCase()) continue;
    const lv = Number(call(SEALED, "info(uint256)(uint8,uint8,uint64,uint64,uint256,address)", sid)[0]);
    const lo = fmt(call(SEALED, "LOW(uint256)(uint256)", lv)), hi = fmt(call(SEALED, "HIGH(uint256)(uint256)", lv));
    log(`🎁 Sealed Block #${sid} found: ${TIER[lv]} (tier ${lv + 1} of 5), opens for ${lo} – ${hi} BGENT`);
    log(`   Open it: ${BIN} open --id ${sid}   or move it to your own wallet to keep or sell: ${BIN} send --id ${sid} --to <address>`);
  }
  log(`Claimable: ${fmt(call(WORLD, "claimable(uint256)(uint256)", id))} BGENT (run ${BIN} claim any time)`);
}

function status(wallet, id) {
  const e = Number(call(WORLD, "currentEpoch()(uint256)"));
  const [init, budget, paid, , explorations] = call(WORLD, "epochInfo(uint256)(bool,uint256,uint256,uint256,uint256,uint256,uint256)", e);
  console.log(`Agentic Wallet   ${wallet}`);
  console.log(`Agent ID         ${id}${call(WORLD, "walletOf(uint256)(address)", id) === "0x0000000000000000000000000000000000000000" ? " (binds to this wallet on the first round)" : " (bound to this wallet)"}`);
  console.log(`Day ${e}           network: ${explorations} rounds · paid ${fmt(paid)} / ${fmt(budget)} BGENT${init === "true" ? "" : " (no rounds yet today)"}`);
  console.log(`Difficulty       base reward per round ${fmt(call(WORLD, "currentYield(uint256)(uint256)", e))} (falls as more Agents take part)`);
  console.log(`You today        ${call(WORLD, "explorationsIn(uint256,uint256)(uint256)", id, e)} rounds · active ${call(WORLD, "activeDays(uint256)(uint256)", id)} of the last 30 days`);
  console.log(`Claimable        ${fmt(call(WORLD, "claimable(uint256)(uint256)", id))} BGENT · earned in total ${fmt(call(WORLD, "earned(uint256)(uint256)", id))} BGENT`);
  console.log(`Sealed Blocks    ${call(SEALED, "balanceOf(address)(uint256)", wallet)} (run ${BIN} blocks)`);
}

// ---------------- main ----------------
function main() {
  if (cmd === "help") {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 16).join("\n").replace(/^\/\/ ?/gm, "").replaceAll("bgent ", `${BIN} `));
    return;
  }
  if (run("baw", ["--version"], true) === null) throw new Error("Binance Agentic Wallet CLI not found: npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet");
  const st = baw(["wallet", "status"]);
  if (st.status !== "CONNECTED") throw new Error(`Agentic Wallet is ${st.status}: run "baw auth signin" and scan the QR code in the Binance App`);
  const wallet = walletAddress();
  const id = findAgentId(wallet);
  const risk = Number(opt("risk", process.env.BGENT_RISK ?? 0));
  if (![0, 1, 2].includes(risk)) throw new Error("--risk must be 0, 1 or 2");
  switch (cmd) {
    case "setup": {
      const s = baw(["wallet", "settings"]);
      console.log(`✓ Agentic Wallet connected  ${wallet}`);
      console.log(`✓ Binance Agent ID  ${id}`);
      console.log(s?.devMode?.enabled ? "✓ Developer Mode is on" : "✗ Developer Mode is off: turn it on in the Binance App (Agentic Wallet settings), then run again");
      console.log(`BNB balance: ${run("cast", ["balance", wallet, "--ether", "--rpc-url", pickRpc()])} (each round uses roughly 0.00001 BNB of gas)`);
      break;
    }
    case "explore": exploreOnce(wallet, id, risk); break;
    case "auto": {
      const every = Number(opt("interval", 10)) * 60_000;
      for (;;) { try { exploreOnce(wallet, id, risk); } catch (e) { log("error:", e.message); RPC = opt("rpc", ""); } sleep(every); }
    }
    case "status": status(wallet, id); break;
    case "claim": {
      const amount = call(WORLD, "claimable(uint256)(uint256)", id);
      if (big(amount) === 0n) { console.log("nothing to claim yet"); break; }
      const c0 = big(call(WORLD, "claimed(uint256)(uint256)", id));
      bawSend(wallet, WORLD, "claim(uint256)", [id], "claim BGENT", () => big(call(WORLD, "claimed(uint256)(uint256)", id)) > c0);
      log(`🎉 Claimed ${fmt(amount)} BGENT → ${wallet}`);
      break;
    }
    case "open": {
      const sid = opt("id"); if (!sid) throw new Error("--id required");
      const bal0 = big(call(D.BGENT, "balanceOf(address)(uint256)", wallet));
      const status1 = () => call(SEALED, "info(uint256)(uint8,uint8,uint64,uint64,uint256,address)", sid)[1];
      if (blockOwner(sid)?.toLowerCase() !== wallet.toLowerCase() && status1() !== "1") throw new Error(`Sealed Block #${sid} is not held by this wallet (or already opened)`);
      if (status1() === "0") bawSend(wallet, SEALED, "requestReveal(uint256)", [sid], "lock Sealed Block", () => status1() === "1");
      const [, , , pb] = call(SEALED, "info(uint256)(uint8,uint8,uint64,uint64,uint256,address)", sid);
      while (blockNumber() <= Number(pb) + 2) sleep(700);
      bawSend(wallet, SEALED, "resolveReveal(uint256)", [sid], "open Sealed Block", () => status1() === "2");
      log(`🎁 Sealed Block #${sid} opened: ${fmt(big(call(D.BGENT, "balanceOf(address)(uint256)", wallet)) - bal0)} BGENT`);
      break;
    }
    case "blocks": {
      const n = Number(call(SEALED, "balanceOf(address)(uint256)", wallet));
      if (!n) { console.log("This wallet holds no Sealed Blocks."); break; }
      for (let i = 0; i < n; i++) {
        const sid = call(SEALED, "tokenOfOwnerByIndex(address,uint256)(uint256)", wallet, i);
        const [lv, st] = call(SEALED, "info(uint256)(uint8,uint8,uint64,uint64,uint256,address)", sid);
        const l = Number(lv);
        console.log(`#${sid}  ${TIER[l].padEnd(9)} tier ${l + 1}/5  opens for ${fmt(call(SEALED, "LOW(uint256)(uint256)", l))} – ${fmt(call(SEALED, "HIGH(uint256)(uint256)", l))} BGENT  ${st === "1" ? "(opening)" : "(sealed)"}`);
      }
      console.log(`Open: ${BIN} open --id <id>   Transfer: ${BIN} send --id <id> --to <address>`);
      break;
    }
    case "send": {
      const sid = opt("id"), to = opt("to");
      if (!sid) throw new Error("--id required");
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(to))) throw new Error("--to must be a BNB Chain address (0x + 40 hex characters)");
      if (to.toLowerCase() === wallet.toLowerCase()) throw new Error("--to is this wallet itself");
      if (blockOwner(sid)?.toLowerCase() !== wallet.toLowerCase()) throw new Error(`Sealed Block #${sid} is not held by this wallet`);
      if (call(SEALED, "info(uint256)(uint8,uint8,uint64,uint64,uint256,address)", sid)[1] !== "0") throw new Error(`Sealed Block #${sid} is being opened and cannot be transferred`);
      bawSend(wallet, SEALED, "safeTransferFrom(address,address,uint256)", [wallet, to, sid], "transfer Sealed Block",
        () => blockOwner(sid)?.toLowerCase() === to.toLowerCase());
      log(`📦 Sealed Block #${sid} sent to ${to}. It can be opened from any wallet at https://agentweek.github.io/bgent-agent/open.html`);
      break;
    }
  }
}
try { main(); } catch (e) { console.error("error:", e.message); process.exit(1); }
