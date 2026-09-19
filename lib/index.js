/**
 * dsh-plugin-toggle: hot-plug enable/disable switches for installed plugins.
 *
 * Adds a settings page that lists every live loader entry and lets you flip a
 * plugin on/off without restarting the DSH process. It uses the public Cordis
 * loader `entry.update()` API and the same webserver route pattern as other
 * host plugins. Runtime toggles are persisted to the profile `cordis.patch.yml`
 * as `disabled: true` override entries, so they survive restarts.
 *
 * The official-file patches ship the pristine 0.1.5-rc.2 sources they were
 * built against: on every start the live copy is compared with the bundled
 * pristine for the SAME package version, then re-patched from scratch. This
 * heals damage from older plugin versions and never downgrades files from a
 * newer DSH (version-gated reset).
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-plugin-toggle'
export const inject = ['webServer']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PRISTINE_DIR = join(PLUGIN_DIR, '..', 'pristine')

/** Extra names to protect beyond the whole @deepseek-ai scope. */
const CORE_DENYLIST = [
  'cordis-plugin-loader',
  'cordis-plugin-include',
  'dsh-super-injector',
]

function isProtectedName(name) {
  const value = String(name || '')
  return value.startsWith('@deepseek-ai/') || CORE_DENYLIST.some((key) => value.includes(key))
}

function logPatch(section, file, message) {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '.'
    appendFileSync(join(home, '.dsh', 'plugin-toggle-patch.log'), `${new Date().toISOString()} ${section} ${file}: ${message}\n`)
  } catch { /* ignore */ }
}

function candidateRoots(loader) {
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  const dshHome = process.env.DSH_HOME || join(home, '.dsh')
  const root = loader?.root?.tree
  const profileRoot = root?.filename ? dirname(dirname(root.filename)) : join(dshHome, 'profiles')
  const roots = [profileRoot, join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh')]
  return [...new Set(roots)]
}

/**
 * Local-origin guard: only accept requests whose Host is a loopback authority
 * and whose Origin, when present, is also loopback. Routes live under /api so
 * the host's browser-trust fence also applies; this is defense in depth.
 */
function guardLocal(req) {
  const host = String(req.headers.host || '').toLowerCase()
  const hostName = host.split(':')[0] || ''
  const hostOk = hostName === 'localhost'
    || /^127\.\d+\.\d+\.\d+$/.test(hostName)
    || hostName === '[::1]'
  if (!hostOk) return false
  const origin = req.headers.origin
  if (origin && origin !== 'null') {
    try {
      const o = new URL(origin)
      const name = o.hostname.toLowerCase()
      if (name !== 'localhost' && !/^127\.\d+\.\d+\.\d+$/.test(name) && name !== '[::1]') return false
    } catch {
      return false
    }
  }
  return true
}

const MAX_BODY_BYTES = 64 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    let overflow = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { overflow = true; data = ''; req.destroy(); return }
      data += chunk
    })
    req.on('end', () => {
      if (overflow) { reject(Object.assign(new Error('request body too large'), { statusCode: 413 })); return }
      try { resolve(JSON.parse(data || '{}')) } catch (error) {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/** Replace exactly one occurrence; returns null when the anchor is not unique. */
function replaceOnce(content, anchor, replacement) {
  const parts = content.split(anchor)
  if (parts.length !== 2) return null
  return parts[0] + replacement + parts[1]
}

// ---------------------------------------------------------------------------
// Official patch 1: settings-plugin-inventory client (the plugin list UI).
// ---------------------------------------------------------------------------

function patchInventoryClient(content) {
  // 1) Outer card <button> -> <div role="button"> so the nested toggle button is clickable.
  {
    const outer = /\(0, react_jsx_runtime\.jsxs\)\("button", \{\r?\n(\t*)className: PluginInventorySettingsTab_module_css_default\.cardContent,\r?\n\t*type: "button",\r?\n(\t*)"aria-expanded": open,/
    const replaced = content.replace(outer, '(0, react_jsx_runtime.jsxs)("div", {\n$1className: PluginInventorySettingsTab_module_css_default.cardContent,\n$1role: "button",\n$1tabIndex: 0,\n$1style: { cursor: "pointer" },\n$2"aria-expanded": open,')
    if (replaced === content) logPatch('inventory', 'client.js', 'step1 anchor did not match (outer card already a div?)')
    content = replaced
  }

  // 2) isProtected helper in module scope (protects the whole @deepseek-ai scope).
  if (!content.includes('function isProtected')) {
    const helper = `
\t\t/** Core plugins that should not be casually disabled. */
\t\tfunction isProtected(moduleName) { return (moduleName || '').startsWith("@deepseek-ai/") || /cordis-plugin-loader|cordis-plugin-include|dsh-super-injector/.test(moduleName || ''); }`
    const funcEnd = /(\t\tfunction moduleShortName\(moduleName\) \{\r?\n\t\t\treturn \(moduleName\.startsWith\("@"\)[\s\S]*?\r?\n\t\t\})/
    const replaced = content.replace(funcEnd, '$1' + helper + '\n')
    if (replaced === content) logPatch('inventory', 'client.js', 'step2 anchor did not match (moduleShortName)')
    content = replaced
  }

  // 3) Hot-plug toggle button as the first child of globalRowCard's trailing
  //    Fragment, where `entry` and `setRequest` are both in scope.
  if (!content.includes('/api/plugin-toggle/toggle')) {
    const anchor = '\n\t\t\t\ttrailing: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [entry.enabled && !failed && entry.fiberPhase !== null ? (0, react_jsx_runtime.jsx)(PhaseDot, {'
    const button = '(0, react_jsx_runtime.jsx)("button", { type: "button", style: { marginLeft: 8, padding: "2px 8px", fontSize: 12, cursor: "pointer", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #444)", background: "transparent", color: "var(--dsw-alias-label-primary, #ddd)" }, disabled: isProtected(entry.moduleName), onClick: (e) => { e.stopPropagation(); fetch("/api/plugin-toggle/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: entry.entryId, enabled: !(entry.enabled === true) }) }).then((r) => r.json()).then((r) => { if (r?.ok) setRequest((value) => value + 1); }).catch(() => {}); }, children: isProtected(entry.moduleName) ? "保护" : (entry.enabled === true ? "停用" : "启用") }), '
    const replaced = replaceOnce(content, anchor, '\n\t\t\t\ttrailing: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [' + button + 'entry.enabled && !failed && entry.fiberPhase !== null ? (0, react_jsx_runtime.jsx)(PhaseDot, {')
    if (replaced === null) logPatch('inventory', 'client.js', 'step3 anchor missing or not unique (globalRowCard trailing)')
    else content = replaced
  }

  // 4) Enrich the remote inventory list with descriptions served by this plugin.
  //    The generated Typert result schema stays untouched; the client merges
  //    `description` from /api/plugin-toggle/descriptions before rendering.
  if (!content.includes('plugin-toggle-descriptions-v2')) {
    const oldList = /const list = async \(\) => \{\r?\n(\s*)const result = await ctx\.remote\.pluginInventory\.list\(\);\r?\n\s*if \(!result\.ok\) throw new Error\(`pluginInventory\.list failed: \$\{result\.error\.code\}: \$\{result\.error\.message\}`\);\r?\n\s*return result\.value;\r?\n\s*\};/
    const replaced = content.replace(oldList, (match, indent) => {
      const i = indent || '\t\t\t\t'
      return 'const list = async () => {\n' +
        i + 'const result = await ctx.remote.pluginInventory.list();\n' +
        i + 'if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`);\n' +
        i + 'const value = result.value;\n' +
        i + '// plugin-toggle-descriptions-v2\n' +
        i + 'try {\n' +
        i + '\tconst r = await fetch("/api/plugin-toggle/descriptions");\n' +
        i + '\tconst d = await r.json();\n' +
        i + '\tif (d?.ok && Array.isArray(value?.entries)) {\n' +
        i + '\t\tvalue.entries = value.entries.map((entry) => ({ ...entry, description: d.descriptions?.[entry.moduleName] || entry.description }));\n' +
        i + '\t}\n' +
        i + '} catch { /* ignore */ }\n' +
        i + 'return value;\n' +
        i + '};'
    })
    if (replaced === content) logPatch('inventory', 'client.js', 'step4 anchor did not match (list function)')
    content = replaced
  }

  return content
}

// ---------------------------------------------------------------------------
// Official patch 2: host-plugin-inventory service (adds package descriptions).
// ---------------------------------------------------------------------------

function patchHostInventoryContent(content) {
  const DESC_MARKER = '// dsh-plugin-toggle: description-roots-v2'
  if (content.includes('function packageDescription') && content.includes('description: packageDescription') && content.includes(DESC_MARKER)) return content

  if (!content.includes('import { readFileSync, existsSync } from "node:fs";')) {
    content = content.replace(
      'import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";',
      'import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";\nimport { readFileSync, existsSync } from "node:fs";\nimport { dirname, join } from "node:path";'
    )
  }

  const descFn = `
const descriptionCache = new Map();
${DESC_MARKER}
function packageDescription(moduleName) {
  if (!moduleName || typeof moduleName !== "string" || moduleName.startsWith("cordis:")) return undefined;
  if (descriptionCache.has(moduleName)) return descriptionCache.get(moduleName);
  const userRoot = process.env.USERPROFILE || process.env.HOME || ".";
  const dshHome = process.env.DSH_HOME || join(userRoot, ".dsh");
  const roots = [
    join(userRoot, ".dsh", "profiles", "node_modules"),
    join(dshHome, "profiles", "node_modules"),
    join(userRoot, "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules"),
  ];
  try {
    const parts = moduleName.split("/");
    for (const root of roots) {
      const pkgPath = join(root, ...parts, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        const desc = typeof pkg.description === "string" ? pkg.description : undefined;
        descriptionCache.set(moduleName, desc);
        return desc;
      }
    }
  } catch { /* ignore */ }
  descriptionCache.set(moduleName, undefined);
  return undefined;
}
`
  const descStart = content.indexOf('const descriptionCache = new Map();')
  const gateway = content.indexOf('let PluginInventoryGateway')
  if (descStart !== -1 && gateway > descStart) {
    content = content.slice(0, descStart) + descFn + content.slice(gateway)
  } else {
    const replaced = content.replace(/(?:var|let) PluginInventoryGateway = \(\(\) => \{/, descFn + '\nlet PluginInventoryGateway = (() => {')
    if (replaced === content) logPatch('host-inventory', 'index.js', 'gateway anchor did not match')
    content = replaced
  }

  if (!content.includes('description: packageDescription')) {
    const replaced = content.replace(/(\t+)moduleName: entry\.options\.name,/, '$1moduleName: entry.options.name,\n$1description: packageDescription(entry.options.name),')
    if (replaced === content) logPatch('host-inventory', 'index.js', 'description line anchor did not match')
    content = replaced
  }

  return content
}

// ---------------------------------------------------------------------------
// Official patch 3: agent-preset client (session-header preset dropdown).
// ---------------------------------------------------------------------------

function patchAgentPresetClientContent(content) {
  if (content.includes('preset-switch-dropdown-v8')) return content
  if (!content.includes('function AgentPresetLabel(')) {
    logPatch('agent-preset', 'client.js', 'AgentPresetLabel not found')
    return content
  }

  const newFunction = `// preset-switch-dropdown-v8
function AgentPresetLabel({ sessionId, useSessions, useAgentPresets, load, t }) {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset;
    return typeof value === "string" ? value : void 0;
  });
  const options = useAgentPresets((state) => state.options);
  const [enabled, setEnabled] = react.useState(null);
  react.useEffect(() => {
    if (preset !== void 0) load();
  }, [preset, load]);
  react.useEffect(() => {
    let alive = true;
    const finish = (value) => { if (alive) setEnabled(value); };
    const loadStatus = () => {
      fetch("/api/preset-switch/status")
        .then((r) => {
          const ct = String(r.headers.get("content-type") || "");
          if (!ct.includes("application/json")) throw new Error("not-json");
          return r.json();
        })
        .then((d) => {
          if (d && typeof d.enabled === "boolean") finish(d.enabled);
          else throw new Error("bad-shape");
        })
        .catch(() => {
          // preset-switch is unreachable — it may be disabled as a plugin.
          // Ask plugin-toggle for the entry state; hide only when it is off.
          fetch("/api/plugin-toggle/list")
            .then((r) => r.json())
            .then((d) => {
              if (!d?.ok || !Array.isArray(d.entries)) return finish(true);
              const row = d.entries.find((e) => String(e.name || "").includes("dsh-preset-switch"));
              finish(row ? !row.disabled : true);
            })
            .catch(() => finish(true));
        });
    };
    loadStatus();
    const timer = window.setInterval(loadStatus, 5000);
    const onFocus = () => loadStatus();
    window.addEventListener("focus", onFocus);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, []);
  react.useEffect(() => {
    const id = "preset-switch-dropdown-style";
    if (document.getElementById(id)) return;
    const s = document.createElement("style");
    s.id = id;
    s.textContent = ".psd-summary{background:rgba(255,255,255,0.04);transition:background .15s}.psd-summary:hover{background:rgba(255,255,255,0.14)!important}.psd-menu-item{transition:background .15s}.psd-menu-item:hover{background:rgba(255,255,255,0.12)!important}";
    document.head.appendChild(s);
  }, []);
  if (preset === void 0 || enabled === false) return null;
  const option = options.find((entry) => entry.id === preset);
  const text = option === void 0 ? void 0 : presetDisplayText(option, t);
  const currentName = text?.name ?? preset;
  const switchTo = (id) => {
    fetch("/api/preset-switch/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, preset: id })
    }).then((r) => r.json()).then((r) => {
      if (r?.ok) location.reload();
      else alert(r?.error || "切换失败");
    }).catch((err) => alert("切换失败: " + err));
  };
  return react.createElement("details", { style: { position: "relative", display: "inline-block" } },
    react.createElement("summary", {
      className: "psd-summary",
      style: { display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.04)", color: "var(--theme-text, #ddd)", border: "none", cursor: "pointer", font: "inherit", fontSize: 13, padding: "5px 10px", borderRadius: 999, listStyle: "none", outline: "none", transition: "background .15s" }
    },
      react.createElement(_deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutline16, { size: 14, className: AgentPresetLabel_module_css_default.icon, style: { opacity: 0.9 } }),
      react.createElement("span", null, currentName),
      react.createElement("svg", { width: 10, height: 6, viewBox: "0 0 10 6", style: { marginLeft: 2, flex: "none", opacity: 0.9 } },
        react.createElement("path", { d: "M1 1 L5 5 L9 1", stroke: "currentColor", strokeWidth: 1.5, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" })
      )
    ),
    react.createElement("div", { style: { position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 10000, minWidth: 180, maxWidth: 280, background: "var(--theme-bg-layer-2, #242428)", border: "1px solid var(--theme-border, #3a3a3f)", borderRadius: 10, padding: 4, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" } },
      options.map((entry) => {
        const entryText = presetDisplayText(entry, t);
        const active = entry.id === preset;
        return react.createElement("button", {
          key: entry.id,
          className: "psd-menu-item",
          style: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", textAlign: "left", padding: "7px 10px", borderRadius: 7, background: active ? "rgba(74,158,255,0.14)" : "transparent", color: "var(--theme-text, #ddd)", border: "none", cursor: "pointer", font: "inherit", fontSize: 13, gap: 8, transition: "background .15s" },
          onClick: () => switchTo(entry.id)
        },
          react.createElement("span", null, entryText.name ?? entry.id),
          active ? react.createElement("span", { style: { fontSize: 13, opacity: 0.9 } }, "✓") : null
        );
      })
    )
  );
}`
  const agentLabelRegex = /function AgentPresetLabel\(\{[\s\S]*?\n\t\t\}/
  const replaced = content.replace(agentLabelRegex, newFunction)
  if (replaced === content) {
    logPatch('agent-preset', 'client.js', 'AgentPresetLabel replacement did not match')
    return content
  }
  return replaced
}

// ---------------------------------------------------------------------------
// Version-gated pristine reset + re-patch of every official target.
// ---------------------------------------------------------------------------

const PATCH_TARGETS = [
  {
    pkg: 'dsh-client-ui-settings-plugin-inventory',
    rel: join('node_modules', '@deepseek-ai', 'dsh-client-ui-settings-plugin-inventory', 'lib', 'client.js'),
    pristineRel: join('lib', 'client.js'),
    patch: patchInventoryClient,
    label: 'inventory',
  },
  {
    pkg: 'dsh-host-plugin-inventory',
    rel: join('node_modules', '@deepseek-ai', 'dsh-host-plugin-inventory', 'lib', 'index.js'),
    pristineRel: join('lib', 'index.js'),
    patch: patchHostInventoryContent,
    label: 'host-inventory',
  },
  {
    pkg: 'dsh-client-ui-agent-preset',
    rel: join('node_modules', '@deepseek-ai', 'dsh-client-ui-agent-preset', 'lib', 'client.js'),
    pristineRel: join('lib', 'client.js'),
    patch: patchAgentPresetClientContent,
    label: 'agent-preset',
  },
]

function applyOfficialPatches(loader) {
  for (const target of PATCH_TARGETS) {
    let pristine
    let pristineVersion
    try {
      pristine = readFileSync(join(PRISTINE_DIR, target.pkg, target.pristineRel), 'utf8')
      pristineVersion = JSON.parse(readFileSync(join(PRISTINE_DIR, target.pkg, 'package.json'), 'utf8')).version
    } catch (error) {
      logPatch(target.label, target.rel, `bundled pristine unreadable: ${error?.message || error}`)
      continue
    }
    for (const root of candidateRoots(loader)) {
      const file = join(root, target.rel)
      if (!existsSync(file)) continue
      try {
        const liveVersion = JSON.parse(readFileSync(join(dirname(dirname(file)), 'package.json'), 'utf8')).version
        if (liveVersion !== pristineVersion) {
          logPatch(target.label, file, `version mismatch (live ${liveVersion} vs pristine ${pristineVersion}); skipping to avoid downgrade`)
          continue
        }
        const patched = target.patch(pristine)
        const live = readFileSync(file, 'utf8')
        if (live !== patched) writeFileSync(file, patched, 'utf8')
      } catch (error) {
        logPatch(target.label, file, error?.message || String(error))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Toggle persistence (profile cordis.patch.yml override entries).
// ---------------------------------------------------------------------------

function patchFileFor(loader) {
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  const dshHome = process.env.DSH_HOME || join(home, '.dsh')
  const root = loader.root?.tree
  if (root?.filename) return join(dirname(root.filename), 'cordis.patch.yml')
  return join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
}

function readPatch(file) {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

/** Very small patch-block splitter: each block starts at a top-level `- id:` or `- insert:`. */
function splitBlocks(content) {
  const lines = content.split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    if (/^\s*- (id|insert):/.test(line)) {
      if (current) blocks.push(current)
      current = { text: line + '\n', id: /^\s*- id:\s*([^\s#]+)/.exec(line)?.[1] || null }
    } else if (current) {
      current.text += line + '\n'
    } else {
      // comments / empty lines before first entry
      if (!blocks.length) blocks.push({ text: line + '\n', id: null })
      else blocks[blocks.length - 1].text += line + '\n'
    }
  }
  if (current) blocks.push(current)
  return blocks
}

function persistDisabled(file, id) {
  let content = readPatch(file)
  const blocks = splitBlocks(content)
  if (blocks.some((b) => b.id === id && /disabled:\s*true/.test(b.text))) return false
  const cleanedTop = blocks.map((b) => b.text).join('').replace(/^\s*\[\]\s*$/m, '')
  const append = `\n# dsh-plugin-toggle: disabled ${id}\n- id: ${id}\n  disabled: true\n`
  writeFileSync(file, cleanedTop + append, 'utf8')
  return true
}

function persistEnabled(file, id) {
  const original = readPatch(file)
  let content = original
  // Remove the exact block this plugin wrote (comment + entry).
  const marker = `# dsh-plugin-toggle: disabled ${id}\n- id: ${id}\n  disabled: true\n`
  content = content.replace(marker, '')
  // Also remove orphan marker comments left by earlier versions.
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  content = content.replace(new RegExp(`# dsh-plugin-toggle: disabled ${escaped}\\n?`), '')
  // Also drop any other block that disables this id.
  const blocks = splitBlocks(content)
  const kept = blocks.filter((b) => !(b.id === id && /disabled:\s*true/.test(b.text)))
  let next = kept.map((b) => b.text).join('').replace(/^\s*\[\]\s*$/m, '')
  next = next.replace(/\n{3,}/g, '\n\n')
  // Compare against the ORIGINAL file content: the marker removal above must
  // not count as a change, or re-enabling would never persist.
  if (next === original) return false
  writeFileSync(file, next, 'utf8')
  return true
}

// ---------------------------------------------------------------------------
// Package descriptions for the plugin's own settings page.
// ---------------------------------------------------------------------------

function descriptionRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  const dshHome = process.env.DSH_HOME || join(home, '.dsh')
  return [...new Set([
    join(dshHome, 'profiles', 'node_modules'),
    join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
  ])]
}

function readPackageDescription(moduleName) {
  if (!moduleName || typeof moduleName !== 'string') return undefined
  const normalized = moduleName.startsWith('cordis:')
    ? '@deepseek-ai/cordis-plugin-' + moduleName.slice('cordis:'.length)
    : moduleName
  const names = normalized.startsWith('cordis-plugin-') ? [normalized, '@deepseek-ai/' + normalized] : [normalized]
  for (const name of names) {
    const parts = name.split('/')
    for (const root of descriptionRoots()) {
      try {
        const pkgPath = join(root, ...parts, 'package.json')
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (typeof pkg?.description === 'string') return pkg.description
      } catch { /* keep looking */ }
    }
  }
  return undefined
}

function findEntry(loader, id) {
  const entries = [...loader.entries()]
  return entries.find((entry) =>
    entry.id === id
    || entry.options?.name === id
    || String(entry.options?.name ?? '').includes(id)
  )
}

export function apply(ctx) {
  const loader = ctx.loader

  // Reapply the official-file patches on every start/hot-reload. Starts from
  // the bundled pristine copy, so damage from older patch versions heals.
  applyOfficialPatches(loader)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/plugin-toggle',
    handler: async (req, res) => {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      if (!guardLocal(req)) return send(403, { ok: false, error: 'forbidden origin' })
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.replace(/^\/api\/plugin-toggle/, '') || '/'

        if (req.method === 'GET' && path === '/list') {
          const entries = [...loader.entries()].map((entry) => {
            const name = String(entry.options?.name ?? entry.id ?? '')
            const state = entry.fiber ? 'active' : 'inactive'
            return {
              id: entry.id,
              leafId: entry.options?.id ?? entry.id.split(':').pop() ?? entry.id,
              name,
              description: readPackageDescription(name),
              disabled: Boolean(entry.disabled),
              state,
              protected: isProtectedName(name),
            }
          }).sort((a, b) => String(a.name).localeCompare(String(b.name)))
          return send(200, { ok: true, entries })
        }

        if (req.method === 'GET' && path === '/descriptions') {
          const descriptions = {}
          for (const entry of loader.entries()) {
            const name = String(entry.options?.name ?? entry.id ?? '')
            const description = readPackageDescription(name)
            if (description) descriptions[name] = description
          }
          return send(200, { ok: true, descriptions })
        }

        if (req.method === 'POST' && path === '/toggle') {
          const contentType = String(req.headers['content-type'] || '')
          if (!/^application\/json\b/i.test(contentType)) {
            return send(415, { ok: false, error: 'content-type must be application/json' })
          }
          const body = await readBody(req)
          const id = String(body?.id ?? '').trim()
          const enabled = Boolean(body?.enabled)
          if (!id) return send(400, { ok: false, error: 'id is required' })

          const entry = findEntry(loader, id)
          if (!entry) return send(404, { ok: false, error: `plugin entry not found: ${id}` })

          const name = String(entry.options?.name ?? entry.id ?? '')
          if (isProtectedName(name)) {
            return send(400, { ok: false, error: `refusing to toggle protected core plugin: ${name}` })
          }

          const leafId = entry.options?.id ?? entry.id.split(':').pop() ?? entry.id
          const patchFile = patchFileFor(loader)

          try {
            await entry.update({ disabled: enabled ? undefined : true })
            if (enabled) persistEnabled(patchFile, leafId)
            else persistDisabled(patchFile, leafId)
            return send(200, {
              ok: true,
              id: entry.id,
              leafId,
              name,
              disabled: Boolean(entry.disabled),
            })
          } catch (error) {
            return send(500, { ok: false, error: error && error.message ? error.message : String(error) })
          }
        }

        return send(404, { ok: false, error: 'not found: ' + path })
      } catch (error) {
        const code = Number(error?.statusCode) || 500
        return send(code, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }), 'dsh-plugin-toggle: api')
}
