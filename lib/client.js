window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-plugin-toggle",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    const inject = ["slots"];
    const API = "/plugin-toggle/api";

    const styles = `
.pt-page{font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;padding:14px 16px;max-width:760px}
.pt-page h3{margin:0 0 8px;font-size:13px}
.pt-list{list-style:none;margin:0;padding:0}
.pt-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--theme-border,#333);border-radius:8px;margin-bottom:6px}
.pt-item .name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pt-item .id{color:var(--theme-text-secondary,#888);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:35%}
.pt-item .st{font-size:10px;padding:2px 6px;border-radius:10px}
.pt-item .st.on{background:rgba(46,204,113,.15);color:#2ecc71}
.pt-item .st.off{background:rgba(255,193,7,.12);color:#f1c40f}
.pt-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;white-space:nowrap}
.pt-btn.off{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.pt-btn:disabled{opacity:.45;cursor:not-allowed}
.pt-msg{margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);white-space:pre-wrap;max-height:180px;overflow:auto;font-size:11px}
`;

    function PluginToggleSection() {
      const [entries, setEntries] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [notice, setNotice] = React.useState("");

      const refresh = React.useCallback(() => {
        fetch(API + "/list")
          .then((r) => r.json())
          .then((d) => {
            if (!d?.ok) setError(JSON.stringify(d));
            else {
              setEntries(d.entries);
              setError(null);
            }
          })
          .catch((err) => setError(String(err)));
      }, []);

      React.useEffect(() => {
        refresh();
        const timer = window.setInterval(refresh, 30000);
        return () => window.clearInterval(timer);
      }, [refresh]);

      const toggle = (entry) => {
        setBusy(entry.id);
        setNotice("");
        fetch(API + "/toggle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: entry.id, enabled: entry.disabled }),
        })
          .then((r) => r.json())
          .then((r) => {
            if (!r?.ok) {
              setNotice(r?.error || JSON.stringify(r));
              return;
            }
            setNotice(`已${r.disabled ? "停用" : "启用"} ${r.name}`);
            refresh();
          })
          .catch((err) => setNotice("切换请求失败: " + err))
          .finally(() => setBusy(null));
      };

      return React.createElement(
        "div",
        { className: "pt-page" },
        React.createElement("style", null, styles),
        React.createElement("h3", null, "插件热插拔开关"),
        error
          ? React.createElement("div", { className: "pt-msg" }, "加载失败: " + error)
          : null,
        notice
          ? React.createElement("div", { className: "pt-msg" }, notice)
          : null,
        entries === null
          ? React.createElement("div", { className: "pt-msg" }, "加载中…")
          : entries.length === 0
            ? React.createElement("div", { className: "pt-msg" }, "（没有可切换的插件条目）")
            : React.createElement(
                "ul",
                { className: "pt-list" },
                entries.map((entry) =>
                  React.createElement(
                    "li",
                    { key: entry.id, className: "pt-item" },
                    React.createElement("span", { className: "name" }, entry.name),
                    React.createElement("span", { className: "id" }, entry.leafId || entry.id),
                    React.createElement(
                      "span",
                      { className: "st " + (entry.disabled ? "off" : "on") },
                      entry.disabled ? "已停用" : "运行中"
                    ),
                    React.createElement(
                      "button",
                      {
                        className: "pt-btn" + (entry.disabled ? " off" : ""),
                        disabled: busy === entry.id || entry.protected,
                        onClick: () => toggle(entry),
                      },
                      entry.protected ? "保护" : entry.disabled ? "启用" : "停用"
                    )
                  )
                )
              )
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "plugin-toggle",
        order: 60,
        label: () => "热插拔",
        component: PluginToggleSection,
      })), "dsh-plugin-toggle: settings page");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
