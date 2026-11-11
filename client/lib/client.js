window.__ModuleLoader__.load({
  id: "minimi-dsh-client",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require("react")

    const BRAND_COLOR = "var(--dsw-alias-link)"

    function Mark({ size = 26 }) {
      return React.createElement(
        "svg",
        { width: size, height: size, viewBox: "0 0 32 32", role: "img", "aria-label": "Minimi" },
        React.createElement(
          "defs",
          null,
          React.createElement(
            "linearGradient",
            { id: "minimi-mark-gradient", x1: "4", y1: "2", x2: "28", y2: "30", gradientUnits: "userSpaceOnUse" },
            React.createElement("stop", { offset: "0", stopColor: "#86c9b5" }),
            React.createElement("stop", { offset: "1", stopColor: "#286c59" }),
          ),
        ),
        React.createElement("rect", { x: 1, y: 1, width: 30, height: 30, rx: 9, fill: "url(#minimi-mark-gradient)" }),
        React.createElement("path", {
          d: "M8.5 23V9.2l7.5 8.1 7.5-8.1V23",
          fill: "none",
          stroke: "#ffffff",
          strokeWidth: 2.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
        React.createElement("circle", { cx: 16, cy: 25.4, r: 1.35, fill: "#ffffff", opacity: 0.9 }),
      )
    }

    function Name() {
      return React.createElement(
        "span",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontWeight: 700,
            fontSize: "15px",
            letterSpacing: "-0.02em",
            color: "var(--dsw-alias-label-primary, currentColor)",
            lineHeight: 1,
          },
        },
        "Minimi",
        React.createElement(
          "span",
          {
            style: {
              fontSize: "9px",
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: BRAND_COLOR,
              border: "1px solid color-mix(in srgb, " + BRAND_COLOR + " 40%, transparent)",
              borderRadius: "999px",
              padding: "2px 5px",
              lineHeight: 1,
            },
          },
          "research",
        ),
      )
    }

    const inject = ["slots", "theme"]

    function apply(ctx) {
      ctx.effect(() => ctx.theme.overrideTokens("minimi", {
        "--dsw-alias-bg-base": { light: "#faf9f6", dark: "#171b1a" },
        "--dsw-alias-bg-layer-1": { light: "#f2f3ee", dark: "#1c2220" },
        "--dsw-alias-bg-layer-2": { light: "#ffffff", dark: "#252d29" },
        "--dsw-specific-sidebar-fill": { light: "#eef1eb", dark: "#121715" },
        "--dsw-specific-sidebar-nav-item-active": { light: "#dce8df", dark: "#2b3b33" },
        "--dsw-specific-sidebar-nav-item-active-accent": { light: "#dce8df", dark: "#2b3b33" },
        "--dsw-specific-input-major": { light: "#ffffff", dark: "#252e29" },
        "--dsw-specific-bubble": { light: "#e5eee8", dark: "#29392f" },
        "--dsw-alias-link": { light: "#216451", dark: "#93d4bc" },
        "--dsw-alias-button-primary-fill": { light: "#235e4c", dark: "#a2d4bd" },
        "--dsw-alias-button-primary-hover": { light: "#194936", dark: "#c3e5d4" },
        "--dsw-alias-button-info-fill": { light: "#235e4c", dark: "#a2d4bd" },
      }))
      // The upstream shell sets the title per route/build; keep the product name.
      const setTitle = () => {
        if (document.title !== "Minimi") document.title = "Minimi"
      }
      setTitle()
      const timer = setInterval(setTitle, 1000)
      ctx.effect(() => () => clearInterval(timer))

      ctx.slots.inject("sidebar.brand.mark", () =>
        ctx.slots.inject("sidebar.brand.name", function* () {
          yield ctx.slots.register({ name: "sidebar.brand.mark" }, Mark)
          yield ctx.slots.register({ name: "sidebar.brand.name" }, Name)
        }),
      )

      // The conversation hero uses the same mark; it is rendered at a larger size.
      ctx.slots.inject("conversation.hero.brand.mark", () =>
        ctx.slots.register({ name: "conversation.hero.brand.mark" }, Mark),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
