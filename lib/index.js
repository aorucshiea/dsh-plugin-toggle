/**
 * dsh-plugin-toggle: hot-plug enable/disable switches for installed plugins.
 *
 * Adds a settings page that lists every live loader entry and lets you flip a
 * plugin on/off without restarting the DSH process. It uses the public Cordis
 * loader `entry.update()` API and the same webserver route pattern as other
 * host plugins; it does not modify official core components.
 *
 * Runtime toggles are persisted to the profile `cordis.patch.yml` as
 * `disabled: true` override entries, so they survive restarts.
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'dsh-plugin-toggle'
export const inject = ['webServer']

const CORE_DENYLIST = new Set([
  'cordis-plugin-loader',
  'cordis-plugin-include',
  'dsh-super-injector',
  'dsh-host-webserver',
  'dsh-web-app',
  'dsh-agent-loop',
  'dsh-agent',
  'dsh-session',
  'dsh-tools',
  'dsh-system-prompt',
  'dsh-commands',
  'dsh-settings',
  'dsh-settings-file',
  'dsh-llm',
  'dsh-api-gateway',
  'dsh-host-apiproxy',
  'dsh-client-runtime',
])

function candidateRoots(loader) {
  const home = process.env.DSH_HOME || process.env.USERPROFILE || '.'
  const root = loader?.root?.tree
  const profileRoot = root?.filename ? dirname(dirname(root.filename)) : join(home, '.dsh', 'profiles')
  const roots = [profileRoot, home]
  // DSH itself is often installed globally under %AppData%\Roaming\npm\node_modules,
  // and its nested node_modules contains the official host/client packages that the
  // webserver actually loads. Include that tree so patches reach the live copies too.
  roots.push(join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  try {
    const npxBase = join(home, 'AppData', 'Local', 'npm-cache', '_npx')
    for (const name of readdirSync(npxBase)) {
      roots.push(join(npxBase, name))
    }
  } catch { /* no npx cache or unreadable */ }
  return [...new Set(roots)]
}

const OFFICIAL_CLIENT_REL = join('node_modules', '@deepseek-ai', 'dsh-client-ui-settings-plugin-inventory', 'lib', 'client.js')

/** Patch the official read-only plugin list to add hot-plug toggle buttons.
 *  DSH may restore/reinstall official packages, so this runs on every plugin
 *  start and reapplies the UI patch if it is missing. */
function patchOfficialInventory(loader) {
  const home = process.env.DSH_HOME || process.env.USERPROFILE || '.'
  const clientRel = join('node_modules', '@deepseek-ai', 'dsh-client-ui-settings-plugin-inventory', 'lib', 'client.js')
  const candidates = candidateRoots(loader).map((root) => join(root, clientRel))
  for (const file of candidates) {
    try {
      let content = readFileSync(file, 'utf8')

      // Repair a previous broken description insertion (missing `}` before the comma).
      {
        const brokenMarker = '), (0, react_jsx_runtime.jsxs)("div", {'
        let pos = content.indexOf(brokenMarker)
        while (pos !== -1) {
          const before = content.slice(Math.max(0, pos - 1), pos)
          if (before !== '}') {
            content = content.slice(0, pos) + '}' + content.slice(pos)
            pos += 1
          }
          pos = content.indexOf(brokenMarker, pos + 1)
        }
      }

      // 1) Outer card <button> -> <div role="button"> so the nested toggle button is clickable.
      if (!content.includes('role: "button"')) {
        const outer = /\(0, react_jsx_runtime\.jsxs\)\("button", \{\r?\n(\t*)className: PluginInventorySettingsTab_module_css_default\.cardContent,\r?\n\t*type: "button",\r?\n(\t*)"aria-expanded": open,/
        content = content.replace(outer, '(0, react_jsx_runtime.jsxs)("div", {\n$1className: PluginInventorySettingsTab_module_css_default.cardContent,\n$1role: "button",\n$1tabIndex: 0,\n$1style: { cursor: "pointer" },\n$2"aria-expanded": open,')
      }

      // 2) Add isProtected helper in module scope.
      if (!content.includes('function isProtected')) {
        const helper = `
\t\t/** Protected core plugins that should not be casually disabled. */
\t\tfunction isProtected(moduleName) { return /cordis-plugin-loader|cordis-plugin-include|dsh-super-injector|dsh-host-webserver|dsh-web-app|dsh-agent-loop|dsh-agent|dsh-session|dsh-tools|dsh-system-prompt|dsh-commands|dsh-settings|dsh-settings-file|dsh-llm|dsh-api-gateway|dsh-host-apiproxy|dsh-client-runtime/.test(moduleName || ''); }`
        const funcEnd = /(\t\tfunction moduleShortName\(moduleName\) \{\r?\n\t\t\treturn \(moduleName\.startsWith\("@"\)[\s\S]*?\r?\n\t\t\})/
        content = content.replace(funcEnd, '$1' + helper + '\n')
      }

      // 3) Insert toggle button before the chevron icon in each card trailing area.
      if (!content.includes('/plugin-toggle/api/toggle')) {
        const chevron = /(\t+)\(0, react_jsx_runtime\.jsx\)\(_deepseek_ai_dsh_client_ui_primitives\.IconChevronDownOutline14, \{\r?\n(?:\1\t[^\n]*\r?\n)*?\1\}\)/
        content = content.replace(chevron, (match, indent) => {
          const button = `${indent}(0, react_jsx_runtime.jsx)("button", {
${indent}\ttype: "button",
${indent}\tstyle: { marginLeft: 8, padding: "2px 8px", fontSize: 12, cursor: "pointer", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #444)", background: "transparent", color: "var(--dsw-alias-label-primary, #ddd)" },
${indent}\tdisabled: isProtected(entry.moduleName),
${indent}\tonClick: (e) => { e.stopPropagation(); fetch("/plugin-toggle/api/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: entry.entryId, enabled: !entry.enabled }) }).then((r) => r.json()).then((r) => { if (r?.ok) setRequest((value) => value + 1); }).catch(() => {}); },
${indent}\tchildren: isProtected(entry.moduleName) ? "保护" : (entry.enabled ? "停用" : "启用")
${indent}}),`
          return `${button}\n${match}`
        })
      }

      // 4) Insert a one-line description under each plugin card header.
      if (!content.includes('entry.description || "（暂无简介）"')) {
        const marker = '}), open ? (0, react_jsx_runtime.jsxs)("div", {'
        const idx = content.indexOf(marker)
        if (idx >= 0) {
          const indentMatch = /\t+$/.exec(content.slice(0, idx))
          const indent = indentMatch ? indentMatch[0] : '\t\t\t\t\t\t'
          const desc = `${indent}}), (0, react_jsx_runtime.jsxs)("div", {
${indent}\tstyle: { padding: "0 16px 8px", fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)", lineHeight: 1.5 },
${indent}\tchildren: entry.description || "（暂无简介）"
${indent}}), open ? (0, react_jsx_runtime.jsxs)("div", {`
          content = content.slice(0, idx) + desc + content.slice(idx + marker.length)
        }
      }

      // 5) Enrich the remote inventory list with descriptions from our own HTTP endpoint.
      // The generated Typert result schema must stay untouched, so the client locally
      // merges `description` from /plugin-toggle/api/descriptions before rendering.
      if (!content.includes('plugin-toggle-descriptions-v1')) {
        const oldList = /const list = async \(\) => \{\r?\n(\s*)const result = await ctx\.remote\.pluginInventory\.list\(\);\r?\n\s*if \(!result\.ok\) throw new Error\(`pluginInventory\.list failed: \$\{result\.error\.code\}: \$\{result\.error\.message\}`\);\r?\n\s*return result\.value;\r?\n\s*\};/
        content = content.replace(oldList, (match, indent) => {
          const i = indent || '\t\t\t\t'
          return 'const list = async () => {\n' +
            i + 'const result = await ctx.remote.pluginInventory.list();\n' +
            i + 'if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`);\n' +
            i + 'const value = result.value;\n' +
            i + '// plugin-toggle-descriptions-v1\n' +
            i + 'try {\n' +
            i + '\tconst r = await fetch("/plugin-toggle/api/descriptions");\n' +
            i + '\tconst d = await r.json();\n' +
            i + '\tif (d?.ok && Array.isArray(value?.entries)) {\n' +
            i + '\t\tvalue.entries = value.entries.map((entry) => ({ ...entry, description: d.descriptions?.[entry.moduleName] || entry.description }));\n' +
            i + '\t}\n' +
            i + '} catch { /* ignore */ }\n' +
            i + 'return value;\n' +
            i + '};'
        })
      }

      writeFileSync(file, content, 'utf8')
    } catch (error) {
      // Patching is best-effort; log for diagnosis but never break the plugin.
      try {
        const log = join(home, '.dsh', 'plugin-toggle-patch.log')
        appendFileSync(log, `${new Date().toISOString()} ${file}: ${error?.message || String(error)}\n`)
      } catch { /* ignore */ }
    }
  }
}

const HOST_INVENTORY_REL = join('node_modules', '@deepseek-ai', 'dsh-host-plugin-inventory', 'lib', 'index.js')

/** Patch the official host plugin inventory service to include package descriptions. */
function patchHostInventory(loader) {
  const home = process.env.DSH_HOME || process.env.USERPROFILE || '.'
  const candidates = candidateRoots(loader).map((root) => join(root, HOST_INVENTORY_REL))
  for (const file of candidates) {
    try {
      let content = readFileSync(file, 'utf8')
      const DESC_MARKER = '// dsh-plugin-toggle: description-roots-v2'
      if (content.includes('function packageDescription') && content.includes('description: packageDescription') && content.includes(DESC_MARKER)) continue

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
  const userRoot = process.env.USERPROFILE || process.env.HOME || process.env.DSH_HOME || ".";
  const dshHome = process.env.DSH_HOME || join(userRoot, ".dsh");
  const roots = [
    join(userRoot, "node_modules"),
    join(userRoot, ".dsh", "profiles", "node_modules"),
    join(userRoot, ".dsh", "profiles", "web", "node_modules"),
    join(userRoot, ".dsh", "profiles", "safe", "node_modules"),
    join(userRoot, ".dsh", "profiles", "standard", "node_modules"),
    join(userRoot, ".dsh", "profiles", "code", "node_modules"),
    join(userRoot, ".dsh", "profiles", "minimal", "node_modules"),
    join(dshHome, "node_modules"),
    join(dshHome, "profiles", "node_modules"),
    join(dshHome, "profiles", "web", "node_modules"),
    join(dshHome, "profiles", "safe", "node_modules"),
    join(dshHome, "profiles", "standard", "node_modules"),
    join(dshHome, "profiles", "code", "node_modules"),
    join(dshHome, "profiles", "minimal", "node_modules"),
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
    if (moduleName.startsWith("cordis-plugin-")) {
      const scoped = "@deepseek-ai/" + moduleName;
      const scopedParts = scoped.split("/");
      for (const root of roots) {
        const pkgPath = join(root, ...scopedParts, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          const desc = typeof pkg.description === "string" ? pkg.description : undefined;
          descriptionCache.set(moduleName, desc);
          return desc;
        }
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
        content = content.replace(/(?:var|let) PluginInventoryGateway = \(\(\) => \{/, descFn + '\nlet PluginInventoryGateway = (() => {')
      }

      if (!content.includes('description: packageDescription')) {
        content = content.replace(/(\t+)moduleName: entry\.options\.name,/, '$1moduleName: entry.options.name,\n$1description: packageDescription(entry.options.name),')
      }

      writeFileSync(file, content, 'utf8')
    } catch (error) {
      try {
        const log = join(home, '.dsh', 'plugin-toggle-patch.log')
        appendFileSync(log, `${new Date().toISOString()} host ${file}: ${error?.message || String(error)}\n`)
      } catch { /* ignore */ }
    }
  }
}

// Descriptions are intentionally NOT added to the generated Typert schemas.
// Those schemas are strict and owned by DSH; the plugin serves descriptions from
// its own HTTP endpoint and the patched inventory client merges them locally.

const AGENT_PRESET_CLIENT_REL = join('node_modules', '@deepseek-ai', 'dsh-client-ui-agent-preset', 'lib', 'client.js')

/** Patch the session-header agent-preset label into a live switch dropdown
 *  that also watches preset-switch.enabled and hides automatically when the
 *  feature is turned off (no manual refresh needed). */
function patchAgentPresetClient(loader) {
  const home = process.env.DSH_HOME || process.env.USERPROFILE || '.'
  const candidates = candidateRoots(loader).map((root) => join(root, AGENT_PRESET_CLIENT_REL))
  for (const file of candidates) {
    try {
      let content = readFileSync(file, 'utf8')
      if (content.includes('preset-switch-dropdown-v7')) continue

      const newFunction = `// preset-switch-dropdown-v7
function AgentPresetLabel({ sessionId, useSessions, useAgentPresets, load, t }) {
  const preset = useSessions((state) => state.byId[sessionId]?.agentPreset);
  const options = useAgentPresets((state) => state.options);
  const [enabled, setEnabled] = react.useState(null);
  react.useEffect(() => {
    if (preset !== undefined) load();
  }, [preset, load]);
  react.useEffect(() => {
    let alive = true;
    const loadStatus = () => {
      fetch("/preset-switch/api/status")
        .then((r) => r.json())
        .then((d) => { if (alive) setEnabled(Boolean(d?.enabled)); })
        .catch(() => { if (alive) setEnabled(true); });
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
  if (preset === undefined || enabled === false) return null;
  const option = options.find((entry) => entry.id === preset);
  const text = option === undefined ? undefined : presetDisplayText(option, t);
  const currentName = text?.name ?? preset;
  const switchTo = (id) => {
    fetch("/preset-switch/api/switch", {
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
      content = content.replace(agentLabelRegex, newFunction)

      writeFileSync(file, content, 'utf8')
    } catch (error) {
      try {
        const log = join(home, '.dsh', 'plugin-toggle-patch.log')
        appendFileSync(log, `${new Date().toISOString()} agent-preset ${file}: ${error?.message || String(error)}\n`)
      } catch { /* ignore */ }
    }
  }
}

function descriptionRoots() {
  const userRoot = process.env.USERPROFILE || process.env.HOME || process.env.DSH_HOME || '.'
  const dshHome = process.env.DSH_HOME || join(userRoot, '.dsh')
  return [...new Set([
    join(userRoot, 'node_modules'),
    join(userRoot, '.dsh', 'profiles', 'node_modules'),
    join(userRoot, '.dsh', 'profiles', 'web', 'node_modules'),
    join(userRoot, '.dsh', 'profiles', 'safe', 'node_modules'),
    join(userRoot, '.dsh', 'profiles', 'standard', 'node_modules'),
    join(userRoot, '.dsh', 'profiles', 'code', 'node_modules'),
    join(userRoot, '.dsh', 'profiles', 'minimal', 'node_modules'),
    join(dshHome, 'node_modules'),
    join(dshHome, 'profiles', 'node_modules'),
    join(dshHome, 'profiles', 'web', 'node_modules'),
    join(dshHome, 'profiles', 'safe', 'node_modules'),
    join(dshHome, 'profiles', 'standard', 'node_modules'),
    join(dshHome, 'profiles', 'code', 'node_modules'),
    join(dshHome, 'profiles', 'minimal', 'node_modules'),
    join(userRoot, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

function findEntry(loader, id) {
  const entries = [...loader.entries()]
  return entries.find((entry) =>
    entry.id === id
    || entry.options?.name === id
    || String(entry.options?.name ?? '').includes(id)
  )
}

function patchFileFor(loader) {
  const root = loader.root?.tree
  if (root?.filename) return join(dirname(root.filename), 'cordis.patch.yml')
  return join(process.env.DSH_HOME || process.env.USERPROFILE || '.', '.dsh', 'profiles', 'web', 'cordis.patch.yml')
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
  let content = readPatch(file)
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
  if (next === content) return false
  writeFileSync(file, next, 'utf8')
  return true
}

export function apply(ctx) {
  const loader = ctx.loader

  // Reapply the official plugin-list UI patch on every start/hot-reload.
  patchOfficialInventory(loader)
  patchHostInventory(loader)
  patchAgentPresetClient(loader)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/plugin-toggle/api',
    handler: async (req, res) => {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.replace(/^\/plugin-toggle\/api/, '') || '/'

        if (req.method === 'GET' && path === '/list') {
          const entries = [...loader.entries()].map((entry) => {
            const name = String(entry.options?.name ?? entry.id ?? '')
            const state = entry.fiber ? 'active' : 'inactive'
            return {
              id: entry.id,
              leafId: entry.options?.id ?? entry.id.split(':').pop() ?? entry.id,
              name,
              disabled: Boolean(entry.disabled),
              state,
              protected: [...CORE_DENYLIST].some((key) => name.includes(key)),
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
          const body = await readBody(req)
          const id = String(body?.id ?? '').trim()
          const enabled = Boolean(body?.enabled)
          if (!id) return send(400, { ok: false, error: 'id is required' })

          const entry = findEntry(loader, id)
          if (!entry) return send(404, { ok: false, error: `plugin entry not found: ${id}` })

          const name = String(entry.options?.name ?? entry.id ?? '')
          if ([...CORE_DENYLIST].some((key) => name.includes(key))) {
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
        return send(500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }), 'dsh-plugin-toggle: api')
}