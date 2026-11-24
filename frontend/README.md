# Posnic frontend

The web till: HTML modules, CSS and vanilla JavaScript assembled by Gulp. The
desktop app loads the generated files from `frontend/public/`; that directory is
build output and is not committed.

## Build

```bash
npm install
npm run build:assets   # HTML, CSS and JS only
npm run build          # build and create the zip artifact
npm run build:dev      # unminified output for debugging
```

`NODE_ENV=dev` switches minification off. `pages_html_map.json` and
`pages_css_js_map.json` control which source files are combined into each page.

## Source layout

| Path | Purpose |
|---|---|
| `dashboard.html`, `login.html` and the other root HTML files | Page shells |
| `modules/` | Feature screens |
| `modals/` | Shared dialogs |
| `layouts/` | Page layout fragments |
| `static/script/js/` | Core scripts and feature modules |
| `static/style/` | CSS, SCSS and third-party styles |
| `static/json/` | Runtime JSON data |
| `languages/` | Translation inputs used by the build |
| `gulpfile.js/` | Build tasks |

The app tests live in the repository root `tests/` directory and are run from
there with `npm test`. This package has no separate test suite.
