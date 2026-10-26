// AppDeck builder: clone a GitHub repo, build it (AI-fixing errors), publish it as its own Base44 site on <name>.<BASE_DOMAIN>.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const E = process.env;
const API = "https://app.base44.com/api";
const CALLBACK_URL = "https://app-deck-e89e9c13.base44.app/functions/builder-callback";
const WORK = path.resolve("work");
const SRC = path.join(WORK, "src");

const report = async (patch) => {
  console.log("[status]", JSON.stringify(patch));
  if (!E.CB_TOKEN) return;
  try {
    await fetch(CALLBACK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: E.RECORD_ID, token: E.CB_TOKEN, ...patch }),
    });
  } catch (e) { console.log("callback failed", e.message); }
};
const sh = (cmd, cwd = SRC, opts = {}) =>
  execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 12 * 60 * 1000, ...opts });
const tail = (s, n = 6000) => String(s || "").slice(-n);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
const exists = (...p) => fs.existsSync(path.join(SRC, ...p));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8")); } catch { return null; } };

class NeedsServer extends Error {}

function parseRepo(url) {
  const m = String(url).trim().replace(/\.git$/, "").match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error("Not a GitHub repo URL");
  return { owner: m[1], repo: m[2] };
}

function detect() {
  const pkg = readJson("package.json");
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasBuild = !!pkg.scripts?.build;
    const serverish = ["express", "fastify", "koa", "@nestjs/core", "hapi", "@hapi/hapi"].some((d) => deps[d]);
    if (hasBuild) return { kind: "node-build", pkg, serverish };
    if (serverish) throw new NeedsServer("Node server app (no front-end build step)");
  }
  for (const d of [".", "docs", "public", "dist", "build"]) if (exists(d, "index.html")) return { kind: "static", dir: d };
  if (exists("Dockerfile") || exists("requirements.txt") || exists("pyproject.toml") || exists("go.mod") || exists("Gemfile") || exists("composer.json"))
    throw new NeedsServer("Back-end app (needs a server runtime)");
  throw new Error("Could not find a website to publish (no index.html or build script)");
}

const OUT_DIRS = ["dist", "build", "out", "public", ".output/public", "_site", "docs"];
function findOutput() {
  for (const d of OUT_DIRS) if (exists(d, "index.html")) return d;
  return null;
}

async function aiFix(log, attempt) {
  if (!E.ANTHROPIC_API_KEY) return false;
  const ctx = ["package.json", "vite.config.js", "vite.config.ts", "next.config.js", "next.config.mjs", "astro.config.mjs", "svelte.config.js", "tsconfig.json", ".nvmrc"]
    .filter((f) => exists(f)).map((f) => `--- ${f}\n${fs.readFileSync(path.join(SRC, f), "utf8").slice(0, 4000)}`).join("\n");
  const prompt = `A static-site build failed (attempt ${attempt}). Goal: make "npm run build" produce a static website folder with index.html (for Next.js use output: 'export'; for Vite keep base '/'). Do not add servers.\n\nBuild log (tail):\n${tail(log, 5000)}\n\nFiles:\n${ctx}\n\nReply with ONLY JSON: {"explanation": string, "files": [{"path": string, "content": string}], "commands": [string]}. commands run in the repo root (e.g. "npm install --legacy-peer-deps", "npm i -D some-pkg"). No destructive commands. If it cannot be fixed without a server, reply {"explanation":"needs server","files":[],"commands":[]}.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": E.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) { console.log("AI fix request failed", r.status); return false; }
  const txt = (await r.json()).content?.[0]?.text || "";
  let fix; try { fix = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)); } catch { return false; }
  if (!fix.files?.length && !fix.commands?.length) return false;
  await report({ issues: [`AI fix ${attempt}: ${String(fix.explanation || "").slice(0, 200)}`] });
  for (const f of fix.files || []) {
    const p = path.join(SRC, f.path);
    if (!p.startsWith(SRC + path.sep) || f.path.includes("..")) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content);
  }
  for (const c of fix.commands || []) {
    if (!/^(npm|npx|pnpm|yarn)\s/.test(c) || /rm\s|sudo|curl|wget|\|/.test(c)) continue;
    try { sh(c); } catch (e) { console.log("fix cmd failed:", c); }
  }
  return true;
}

async function build(info) {
  if (info.kind === "static") return info.dir;
  const pm = exists("pnpm-lock.yaml") ? "pnpm" : exists("yarn.lock") ? "yarn" : "npm";
  if (pm !== "npm") sh("npm i -g " + pm, WORK);
  const install = pm === "npm" ? (exists("package-lock.json") ? "npm ci --no-audit --no-fund || npm install --no-audit --no-fund --legacy-peer-deps" : "npm install --no-audit --no-fund --legacy-peer-deps") : `${pm} install`;
  const run = pm === "npm" ? "npm run build" : `${pm} build`;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      await report({ issues: [attempt ? `Building (retry ${attempt})` : "Installing and building"] });
      sh(install); sh(run);
      const out = findOutput();
      if (out) return out;
      throw new Error("Build finished but produced no index.html folder");
    } catch (e) {
      const log = (e.stdout || "") + (e.stderr || "") + (e.message || "");
      console.log("BUILD FAILED\n", tail(log, 3000));
      if (attempt === 3 || !(await aiFix(log, attempt + 1))) {
        if (info.serverish) throw new NeedsServer("Needs a server (build failed and it uses a Node server framework)");
        throw new Error("Build failed: " + tail(log, 400).replace(/\s+/g, " "));
      }
    }
  }
}

const authHeaders = { Authorization: `Bearer ${E.BASE44_API_KEY}` };
async function b44(method, p, body) {
  const r = await fetch(API + p, { method, headers: { ...authHeaders, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { const err = new Error(`${method} ${p} -> ${r.status} ${String(t).slice(0, 300)}`); err.status = r.status; throw err; }
  return j;
}


// ---------- Dynamic apps: deploy on the DigitalOcean server through Coolify's API ----------
const COOLIFY_URL = (E.COOLIFY_URL || "http://168.144.66.117:8000").replace(/\/$/, "");
const DYN_DOMAIN = E.DYNAMIC_DOMAIN || `apps.${E.BASE_DOMAIN}`;
async function co(p, method = "GET", body) {
  const r = await fetch(`${COOLIFY_URL}/api/v1${p}`, {
    method, headers: { Authorization: `Bearer ${E.COOLIFY_TOKEN}`, "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`Coolify ${method} ${p} -> ${r.status} ${String(typeof j === "string" ? j : j.message || JSON.stringify(j)).slice(0, 250)}`);
  return j;
}
function guessPort() {
  for (const f of ["Dockerfile"]) if (exists(f)) { const m = fs.readFileSync(path.join(SRC, f), "utf8").match(/^\s*EXPOSE\s+(\d+)/im); if (m) return m[1]; }
  if (exists("requirements.txt") || exists("pyproject.toml")) return "8000";
  if (exists("go.mod")) return "8080";
  if (exists("Gemfile")) return "3000";
  if (exists("composer.json")) return "80";
  return "3000";
}
async function deployDynamic(owner, repo, label, why) {
  if (!E.COOLIFY_TOKEN) throw new NeedsServer(why + ". Server hosting is not configured (COOLIFY_TOKEN missing)");
  if (exists("docker-compose.yml") && !exists("Dockerfile") || exists("docker-compose.yaml") && !exists("Dockerfile")) {
    throw new Error("Uses docker-compose only (multi-container). Not supported automatically yet.");
  }
  await report({ kind: "server", issues: [`Deploying on your server (${why})`] });
  const servers = await co("/servers"), projects = await co("/projects");
  if (!servers.length || !projects.length) throw new Error("No server/project in Coolify");
  const branch = sh("git rev-parse --abbrev-ref HEAD").trim();
  const domain = `https://${label}.${DYN_DOMAIN}`;
  let uuid = E.COOLIFY_UUID;
  const bp = exists("Dockerfile") ? "dockerfile" : "nixpacks";
  if (!uuid) {
    const created = await co("/applications/public", "POST", {
      project_uuid: projects[0].uuid, server_uuid: servers[0].uuid, environment_name: "production",
      git_repository: `https://github.com/${owner}/${repo}`, git_branch: branch, build_pack: bp,
      ports_exposes: guessPort(), domains: domain, name: label, instant_deploy: true,
    });
    uuid = created.uuid;
  } else {
    await co(`/applications/${uuid}/start`, "GET").catch(() => {});
  }
  await report({ kind: "server", coolify_uuid: uuid, issues: ["Building on your server (can take several minutes)"] });
  // Wait for the app to answer on its domain (max ~15 min), checking Coolify status for failures.
  let lastStatus = "";
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 20000));
    try { const r = await fetch(domain, { redirect: "follow", signal: AbortSignal.timeout(10000) }); if (r.status < 500) { if (r.ok || r.status < 400) return { domain, uuid }; } } catch {}
    try { const a = await co(`/applications/${uuid}`); lastStatus = String(a.status || ""); } catch {}
    if (/exited|degraded|unhealthy/.test(lastStatus) && i > 6) break;
  }
  let log = "";
  try { const d = await co(`/deployments/applications/${uuid}`); const first = (d.deployments || d)[0]; log = JSON.stringify(first?.logs || first || "").slice(-1500); } catch {}
  throw new Error(`Server app did not come up (status: ${lastStatus || "unknown"}). ${log}`.slice(0, 400));
}

async function main() {
  const { owner, repo } = parseRepo(E.REPO_URL);
  const label = slug(E.SUBDOMAIN || repo);
  fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
  await report({ status: "draft", health: "red", issues: ["Cloning repo"] });
  sh(`git clone --depth 1 https://github.com/${owner}/${repo}.git src`, WORK);
  let info, outDir;
  try {
    info = detect();
    outDir = await build(info);
  } catch (e) {
    if (e instanceof NeedsServer) {
      const res = await deployDynamic(owner, repo, label, e.message);
      await report({ live_url: res.domain, status: "live", kind: "server", coolify_uuid: res.uuid, health: "green", issues: [], published_at: new Date().toISOString() });
      console.log("LIVE", res.domain);
      return;
    }
    throw e;
  }
  const outAbs = path.join(SRC, outDir);
  const tgz = path.join(WORK, "site.tgz");
  sh(`tar -czf ${tgz} -C ${outAbs} .`, WORK);
  const mb = fs.statSync(tgz).size / 1048576;
  if (mb > 50) throw new Error(`Built site is ${mb.toFixed(0)} MB (limit 50 MB)`);

  await report({ issues: ["Publishing"] });
  // Reuse a previous Base44 site for this record if the callback told us one (APP_ID env), else create.
  let appId = E.APP_ID;
  if (!appId) {
    const app = await b44("POST", "/apps", { name: label, public_settings: "public_without_login", prevent_iframe_embedding: false });
    appId = app.id;
  }
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(tgz)]), "site.tar.gz");
  const dr = await fetch(`${API}/apps/${appId}/deploy-dist`, { method: "POST", headers: authHeaders, body: form });
  if (!dr.ok) throw new Error(`deploy-dist failed ${dr.status} ${(await dr.text()).slice(0, 300)}`);
  const deployed = await dr.json();

  // Attach <label>.<BASE_DOMAIN>
  let host = `${label}.${E.BASE_DOMAIN}`, domainOk = false, domainId = null;
  for (const h of [host, `${label}-app.${E.BASE_DOMAIN}`]) {
    try { const d = await b44("POST", `/apps/${appId}/custom-domains`, { domain: h }); host = h; domainId = d.id; domainOk = true; break; }
    catch (e) { console.log("domain add failed", e.message); }
  }
  if (domainOk) { try { await b44("POST", `/apps/${appId}/custom-domains/${domainId}/link`); } catch (e) { console.log("link failed", e.message); } }

  const liveUrl = domainOk ? `https://${host}` : deployed.app_url;
  // Wait for DNS/SSL (up to ~6 min), fall back to the Base44 URL.
  let ok = false;
  for (let i = 0; i < 18 && domainOk; i++) {
    try { const r = await fetch(liveUrl, { redirect: "follow" }); if (r.ok) { ok = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 20000));
  }
  const finalUrl = ok || !domainOk ? liveUrl : deployed.app_url;
  await report({
    live_url: finalUrl, status: "live", kind: "static", base44_app_id: appId, published_at: new Date().toISOString(),
    health: "green", issues: ok || !domainOk ? [] : [`${host} not resolving yet (DNS). Serving on Base44 URL meanwhile.`],
  });
  console.log("LIVE", finalUrl);
}

main().catch(async (e) => {
  console.error(e);
  if (e instanceof NeedsServer) await report({ status: "error", health: "red", kind: "server", issues: [e.message + ". Static hosting only."] });
  else await report({ status: "error", health: "red", issues: [String(e.message).slice(0, 400)] });
  process.exit(1);
});
