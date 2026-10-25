// AppDeck builder: clone a GitHub repo, build it (AI-fixing errors), publish it as its own Base44 site on <name>.<BASE_DOMAIN>.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const E = process.env;
const API = "https://app.base44.com/api";
const WORK = path.resolve("work");
const SRC = path.join(WORK, "src");

const report = async (patch) => {
  console.log("[status]", JSON.stringify(patch));
  if (!E.CALLBACK_URL) return;
  try {
    await fetch(E.CALLBACK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-builder-secret": E.CALLBACK_SECRET || "" },
      body: JSON.stringify({ id: E.RECORD_ID, ...patch }),
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

async function main() {
  const { owner, repo } = parseRepo(E.REPO_URL);
  const label = slug(E.SUBDOMAIN || repo);
  fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
  await report({ status: "draft", health: "red", issues: ["Cloning repo"] });
  sh(`git clone --depth 1 https://github.com/${owner}/${repo}.git src`, WORK);
  const info = detect();
  const outDir = await build(info);
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
