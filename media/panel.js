// @ts-check
// Note: the webview CSP forbids inline style attributes — use classes only.
(function () {
  // @ts-ignore - provided by VS Code
  const vscode = acquireVsCodeApi();

  /** Number of distinct level colors (lvl-0 … lvl-3 in panel.css); deeper levels reuse the last. */
  const LEVEL_CLASSES = 4;

  /** Bean kinds in board order, with their column title and short tag. */
  const KINDS = {
    controller: { title: "Controllers", tag: "controller" },
    service: { title: "Services", tag: "service" },
    repository: { title: "Repositories", tag: "repository" },
    component: { title: "Components", tag: "component" },
    client: { title: "Clients", tag: "client" },
    mapper: { title: "Mappers", tag: "mapper" },
    bean: { title: "@Bean methods", tag: "@Bean" },
    configuration: { title: "Configuration", tag: "config" },
    application: { title: "Application", tag: "app" },
  };
  const KIND_ORDER = Object.keys(KINDS);

  const saved = vscode.getState() || {};
  const state = {
    /** @type {any} */ data: null,
    view: saved.view || "board",
    groupBy: saved.groupBy || "level",
    filter: saved.filter || "",
    unusedOnly: !!saved.unusedOnly,
    /** @type {string | null} */ selectedId: null,
    /** @type {Set<string>} expanded hierarchy paths */
    expanded: new Set(),
  };

  /** @type {Map<string, any>} */ let byId = new Map();
  /** @type {Map<string, string[]>} */ let injectedBy = new Map();
  /** @type {Map<string, string[]>} @Bean methods declared by each configuration class */ let defines = new Map();
  /** @type {string[]} */ let roots = [];

  const $ = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
  const content = $("#content");
  const details = $("#details");
  const search = /** @type {HTMLInputElement} */ ($("#search"));
  const unusedToggle = $("#unused-toggle");
  const unusedCount = $("#unused-count");
  const stats = $("#stats");

  search.value = state.filter;

  // ---------------------------------------------------------------- helpers

  const esc = (/** @type {string} */ s) =>
    String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));

  const byName = (/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name);
  const lvl = (/** @type {number} */ level) => `lvl-${Math.min(Math.max(level, 0), LEVEL_CLASSES - 1)}`;
  const isUnused = (/** @type {any} */ b) => !b.used && !b.entryPoint;
  const nameMatches = (/** @type {any} */ b) =>
    (b.name.toLowerCase().includes(state.filter.toLowerCase()) || b.typeName.toLowerCase().includes(state.filter.toLowerCase()))
    && (!state.unusedOnly || isUnused(b));
  const filterActive = () => state.filter !== "" || state.unusedOnly;
  const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const kindTag = (/** @type {any} */ b) => `<span class="kind-tag kind-${b.kind}">${esc(KINDS[/** @type {keyof KINDS} */ (b.kind)]?.tag || b.kind)}</span>`;
  const displayName = (/** @type {any} */ b) => (b.kind === "bean" ? `${b.name}()` : b.name);

  /** Where a bean lives: "src/main/java/com/acme/user" for UserService.java, or "RestTemplate · AppConfig" for a @Bean method. */
  function location(/** @type {any} */ b) {
    if (b.kind === "bean") {
      const owner = b.declaredBy && byId.get(b.declaredBy);
      return `${b.typeName}${owner ? ` · ${owner.name}` : ""}`;
    }
    const rel = b.relativeFile;
    const slash = rel.lastIndexOf("/");
    const base = rel.slice(slash + 1).replace(/\.[^.]+$/, "");
    return base === b.name && slash > 0 ? rel.slice(0, slash) : rel;
  }

  /** Highlights the filter match inside a name. */
  function highlight(/** @type {string} */ name) {
    const f = state.filter.toLowerCase();
    const i = f ? name.toLowerCase().indexOf(f) : -1;
    if (i < 0) return esc(name);
    return `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + f.length))}</mark>${esc(name.slice(i + f.length))}`;
  }

  function saveState() {
    vscode.setState({ view: state.view, groupBy: state.groupBy, filter: state.filter, unusedOnly: state.unusedOnly });
  }

  function index() {
    byId = new Map(state.data.beans.map((/** @type {any} */ b) => [b.id, b]));
    injectedBy = new Map();
    defines = new Map();
    for (const b of state.data.beans) {
      for (const dep of b.dependencies) {
        if (!injectedBy.has(dep)) injectedBy.set(dep, []);
        injectedBy.get(dep).push(b.id);
      }
      if (b.declaredBy) {
        if (!defines.has(b.declaredBy)) defines.set(b.declaredBy, []);
        defines.get(b.declaredBy).push(b.id);
      }
    }
    // Roots: not injected by anyone; beans only reachable through cycles get promoted.
    const all = [...state.data.beans].sort(byName);
    roots = all.filter(b => !injectedBy.has(b.id)).map(b => b.id);
    const reached = new Set();
    const visit = (/** @type {string} */ id) => {
      if (reached.has(id) || !byId.has(id)) return;
      reached.add(id);
      byId.get(id).dependencies.forEach(visit);
    };
    roots.forEach(visit);
    for (const b of all) {
      if (!reached.has(b.id)) {
        roots.push(b.id);
        visit(b.id);
      }
    }
    if (state.selectedId && !byId.has(state.selectedId)) state.selectedId = null;
  }

  /** @type {Map<string, boolean>} */
  let subtreeCache = new Map();
  function subtreeMatches(/** @type {string} */ id, visiting = new Set()) {
    if (subtreeCache.has(id)) return /** @type {boolean} */ (subtreeCache.get(id));
    if (visiting.has(id)) return false;
    visiting.add(id);
    const b = byId.get(id);
    const result = !!b && (nameMatches(b) || b.dependencies.some((/** @type {string} */ d) => subtreeMatches(d, visiting)));
    visiting.delete(id);
    subtreeCache.set(id, result);
    return result;
  }

  /** "child" (injected by the selection) | "parent" (injects the selection) | "". */
  function relation(/** @type {string} */ id) {
    const sel = state.selectedId;
    if (!sel || id === sel) return "";
    if (byId.get(sel)?.dependencies.includes(id)) return "child";
    if ((injectedBy.get(sel) || []).includes(id)) return "parent";
    return "";
  }

  function allEndpoints() {
    return state.data.beans.flatMap((/** @type {any} */ b) => b.endpoints);
  }

  // ---------------------------------------------------------------- render

  function render() {
    subtreeCache = new Map();
    document.querySelectorAll(".tab").forEach(t => {
      const active = /** @type {HTMLElement} */ (t).dataset.view === state.view;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    });
    unusedToggle.setAttribute("aria-pressed", String(state.unusedOnly));
    unusedToggle.classList.toggle("hidden", state.view === "endpoints");
    search.placeholder = state.view === "endpoints" ? "Filter by path or controller" : "Filter by name";
    document.body.classList.toggle("has-selection", !!state.selectedId && state.view !== "endpoints");

    if (!state.data) {
      content.innerHTML = `<div class="empty"><div class="spinner"></div>Analyzing workspace…</div>`;
      return;
    }

    const total = state.data.beans.length;
    const shown = state.data.beans.filter(nameMatches).length;
    unusedCount.textContent = String(state.data.beans.filter(isUnused).length);
    stats.textContent = state.view === "endpoints"
      ? plural(allEndpoints().length, "endpoint")
      : filterActive() ? `${shown} of ${plural(total, "bean")}` : plural(total, "bean");

    if (state.view === "board") renderBoard();
    else if (state.view === "hierarchy") renderHierarchy();
    else renderEndpoints();
    renderDetails();
  }

  function emptyState(/** @type {string} */ title, /** @type {string} */ hint) {
    return `<div class="empty"><strong>${esc(title)}</strong>${hint ? `<span>${esc(hint)}</span>` : ""}</div>`;
  }

  function noMatches() {
    return emptyState("No matching beans", state.unusedOnly ? "Try turning off “Unused”." : "Try a different name.");
  }

  function levelHint(/** @type {number} */ level) {
    return level <= 0 ? "No project dependencies" : `Depends on up to level ${level - 1}`;
  }

  function card(/** @type {any} */ b) {
    const rel = relation(b.id);
    const deps = b.dependencies.length;
    const users = (injectedBy.get(b.id) || []).length;
    const meta = [
      deps ? `<span title="Beans it injects">injects ${deps}</span>` : "",
      users ? `<span title="Beans that inject it">injected by ${users}</span>` : "",
      b.endpoints.length ? `<span title="HTTP endpoints">${plural(b.endpoints.length, "endpoint")}</span>` : "",
    ].filter(Boolean).join(`<span class="sep">·</span>`);
    return `<button class="card ${lvl(b.level)} ${b.id === state.selectedId ? "selected" : ""} ${rel ? `rel-${rel}` : ""}"
        data-select="${esc(b.id)}" title="${esc(b.relativeFile)} — double-click to open">
      <span class="card-top">
        <span class="card-name">${highlight(displayName(b))}</span>
        ${rel === "child" ? `<span class="rel-tag child">injected</span>` : ""}
        ${rel === "parent" ? `<span class="rel-tag parent">injects it</span>` : ""}
        ${isUnused(b) ? `<span class="tag unused">unused</span>` : ""}
        ${kindTag(b)}
      </span>
      <span class="card-path">${esc(location(b))}</span>
      ${meta ? `<span class="card-meta">${meta}</span>` : ""}
    </button>`;
  }

  function renderBoard() {
    const byLevel = state.groupBy === "level";
    /** @type {Map<string | number, any[]>} */
    const groups = new Map();
    for (const b of state.data.beans) {
      if (!nameMatches(b)) continue;
      const key = byLevel ? b.level : b.kind;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    if (groups.size === 0) {
      content.innerHTML = state.data.beans.length ? boardHead() + noMatches()
        : emptyState("No Spring beans found", "Open a folder containing a Spring project, then re-analyze.");
      return;
    }
    const keys = byLevel
      ? [...groups.keys()].sort((a, b) => Number(a) - Number(b))
      : KIND_ORDER.filter(k => groups.has(k));
    const columns = keys.map(key => {
      const items = groups.get(key).sort(byName);
      const head = byLevel
        ? `<span class="dot"></span>
           <span class="column-title">Level ${key}</span>
           <span class="count-pill">${items.length}</span>
           <span class="column-hint">${levelHint(Number(key))}</span>`
        : `<span class="dot"></span>
           <span class="column-title">${esc(KINDS[/** @type {keyof KINDS} */ (key)].title)}</span>
           <span class="count-pill">${items.length}</span>`;
      return `<section class="column ${byLevel ? lvl(Number(key)) : `kind-${key}`}">
        <header class="column-head">${head}</header>
        <div class="cards">${items.map(card).join("")}</div>
      </section>`;
    }).join("");
    content.innerHTML = `${boardHead()}<div class="board">${columns}</div>`;
  }

  function boardHead() {
    return `<div class="board-head">
      <span class="muted">Group by</span>
      <div class="segmented small-seg" role="radiogroup" aria-label="Group by">
        <button class="seg ${state.groupBy === "level" ? "active" : ""}" data-group="level" role="radio" aria-checked="${state.groupBy === "level"}">Level</button>
        <button class="seg ${state.groupBy === "kind" ? "active" : ""}" data-group="kind" role="radio" aria-checked="${state.groupBy === "kind"}">Stereotype</button>
      </div>
    </div>`;
  }

  function renderHierarchy() {
    const rows = [];
    const autoExpand = filterActive();
    const walk = (/** @type {string} */ id, /** @type {string} */ pathKey, /** @type {number} */ depth, /** @type {Set<string>} */ ancestors, /** @type {boolean} */ underMatch) => {
      const b = byId.get(id);
      if (!b) return;
      const circular = ancestors.has(id);
      const childFilter = autoExpand && !underMatch && !nameMatches(b);
      const children = circular ? [] : b.dependencies
        .filter((/** @type {string} */ d) => byId.has(d) && (!childFilter
          || (subtreeMatches(d) && (nameMatches(byId.get(d)) || !(d === id || ancestors.has(d))))))
        .map((/** @type {string} */ d) => byId.get(d)).sort(byName);
      const expanded = children.length > 0 && (state.expanded.has(pathKey) || childFilter);
      const rel = relation(id);
      const guides = `<span class="guide"></span>`.repeat(depth);
      rows.push(`<div class="row ${lvl(b.level)} ${id === state.selectedId ? "selected" : ""} ${rel ? `rel-${rel}` : ""} ${filterActive() && !nameMatches(b) ? "context" : ""}"
          data-select="${esc(id)}" data-path="${esc(pathKey)}" role="treeitem" aria-expanded="${children.length ? expanded : ""}" title="${esc(b.relativeFile)} — double-click to open">
        ${guides}
        <span class="caret ${children.length ? (expanded ? "open" : "") : "none"}" data-toggle="${esc(pathKey)}"></span>
        <span class="dot"></span>
        <span class="row-name">${highlight(displayName(b))}</span>
        ${kindTag(b)}
        ${circular ? `<span class="tag warn" title="Circular dependency: already injected higher up in this branch">↻ circular</span>` : ""}
        ${!circular && children.length ? `<span class="row-count">${children.length}</span>` : ""}
        ${isUnused(b) ? `<span class="tag unused">unused</span>` : ""}
        <span class="row-path">${esc(location(b))}</span>
      </div>`);
      if (expanded) {
        const next = new Set(ancestors).add(id);
        for (const child of children) {
          walk(child.id, `${pathKey}/${child.id}`, depth + 1, next, underMatch || nameMatches(b));
        }
      }
    };
    const visibleRoots = roots.filter(id => !autoExpand || subtreeMatches(id)).map(id => byId.get(id)).sort(byName);
    visibleRoots.forEach(b => walk(b.id, b.id, 0, new Set(), false));
    content.innerHTML = rows.length
      ? `<div class="tree-head">
          <span class="muted">${plural(visibleRoots.length, "top-level bean")}</span>
          <span class="spacer"></span>
          <button class="ghost-button" data-action="expand">Expand top level</button>
          <button class="ghost-button" data-action="collapse">Collapse all</button>
        </div>
        <div class="tree" role="tree">${rows.join("")}</div>`
      : state.data.beans.length ? noMatches()
      : emptyState("No Spring beans found", "Open a folder containing a Spring project, then re-analyze.");
  }

  function endpointRow(/** @type {any} */ b, /** @type {any} */ e) {
    const f = state.filter.toLowerCase();
    const path = f && e.path.toLowerCase().includes(f) ? highlight(e.path) : esc(e.path);
    return `<button class="endpoint" data-open="${esc(b.file)}" data-line="${e.line}" title="Open ${esc(e.handler)}()">
      <span class="http http-${esc(e.method.toLowerCase())}">${esc(e.method)}</span>
      <span class="ep-path">${path}</span>
      <span class="ep-handler">${esc(e.handler)}()</span>
    </button>`;
  }

  function renderEndpoints() {
    const f = state.filter.toLowerCase();
    const controllers = state.data.beans.filter((/** @type {any} */ b) => b.endpoints.length).sort(byName);
    if (!controllers.length) {
      content.innerHTML = emptyState("No endpoints found", "Methods annotated with @GetMapping, @PostMapping, @RequestMapping… in controllers show up here.");
      return;
    }
    const groups = controllers.map((/** @type {any} */ b) => {
      const controllerMatch = b.name.toLowerCase().includes(f);
      const endpoints = b.endpoints
        .filter((/** @type {any} */ e) => controllerMatch || e.path.toLowerCase().includes(f) || e.handler.toLowerCase().includes(f))
        .sort((/** @type {any} */ x, /** @type {any} */ y) => x.path.localeCompare(y.path) || x.method.localeCompare(y.method));
      if (!endpoints.length) return "";
      return `<article class="endpoint-group">
        <header class="endpoint-head">
          <button class="chip ${lvl(b.level)}" data-select="${esc(b.id)}" data-goto="board" title="Show on board"><span class="dot"></span>${highlight(b.name)}</button>
          <span class="card-path">${esc(b.relativeFile)}</span>
          <span class="spacer"></span>
          <span class="count-pill" title="Endpoints">${endpoints.length}</span>
        </header>
        <div class="endpoint-list">${endpoints.map((/** @type {any} */ e) => endpointRow(b, e)).join("")}</div>
      </article>`;
    }).join("");
    content.innerHTML = groups.trim() ? `<div class="endpoint-groups">${groups}</div>` : emptyState("No matching endpoints", "Try a different path or controller name.");
  }

  function chip(/** @type {any} */ b, /** @type {string} */ goto = "") {
    return `<button class="chip ${lvl(b.level)}" data-select="${esc(b.id)}" ${goto ? `data-goto="${goto}"` : ""} title="${esc(b.relativeFile)}"><span class="dot"></span>${esc(displayName(b))}</button>`;
  }

  function chipList(/** @type {any[]} */ items, /** @type {string} */ emptyText) {
    if (!items.length) return `<p class="muted small">${emptyText}</p>`;
    return `<div class="chips">${items.sort(byName).map(b => chip(b)).join("")}</div>`;
  }

  function renderDetails() {
    const b = state.selectedId && byId.get(state.selectedId);
    if (!b || state.view === "endpoints") {
      details.classList.add("hidden");
      details.innerHTML = "";
      return;
    }
    const children = b.dependencies.map((/** @type {string} */ id) => byId.get(id)).filter(Boolean);
    const parents = (injectedBy.get(b.id) || []).map(id => byId.get(id)).filter(Boolean);
    const defined = (defines.get(b.id) || []).map(id => byId.get(id)).filter(Boolean);
    const owner = b.declaredBy && byId.get(b.declaredBy);
    details.classList.remove("hidden");
    details.innerHTML = `
      <header class="details-head ${lvl(b.level)}">
        <div class="details-title">
          <h2>${esc(displayName(b))}</h2>
          <button class="icon-button" data-action="deselect" title="Close (Esc)" aria-label="Close details">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 7.1 12.6 2.5l.9.9L8.9 8l4.6 4.6-.9.9L8 8.9l-4.6 4.6-.9-.9L7.1 8 2.5 3.4l.9-.9z"/></svg>
          </button>
        </div>
        <div class="details-tags">
          <span class="level-badge"><span class="dot"></span>Level ${b.level}</span>
          ${kindTag(b)}
          ${isUnused(b) ? `<span class="tag unused" title="No project bean injects it">unused</span>` : ""}
          ${b.tags.map((/** @type {string} */ t) => `<span class="tag">${esc(t)}</span>`).join("")}
        </div>
        <dl class="facts">
          <dt>Bean name</dt><dd class="mono">${esc(b.beanName)}</dd>
          ${b.kind === "bean" ? `<dt>Type</dt><dd class="mono">${esc(b.typeName)}</dd>` : ""}
        </dl>
        <button class="link path" data-open="${esc(b.file)}" data-line="${b.line}" title="Open file">${esc(b.relativeFile)}:${b.line}</button>
      </header>
      <div class="stat-grid">
        <div class="stat"><span class="stat-value">${children.length}</span><span class="stat-label">injects</span></div>
        <div class="stat"><span class="stat-value">${parents.length}</span><span class="stat-label">injected by</span></div>
        <div class="stat"><span class="stat-value">${b.endpoints.length}</span><span class="stat-label">endpoints</span></div>
      </div>
      <section>
        <h3><span class="legend child"></span>Injects</h3>
        ${chipList(children, "Doesn't inject other project beans.")}
      </section>
      <section>
        <h3><span class="legend parent"></span>Injected by</h3>
        ${chipList(parents, b.entryPoint ? "Not injected — called by the framework." : "Not injected by any project bean.")}
      </section>
      ${b.external.length ? `<section>
        <h3>External dependencies</h3>
        <div class="chips">${b.external.map((/** @type {string} */ t) =>
          `<span class="chip external" title="Not provided by a project bean (framework or library)">${esc(t)}</span>`).join("")}</div>
      </section>` : ""}
      ${owner ? `<section><h3>Declared in</h3><div class="chips">${chip(owner)}</div></section>` : ""}
      ${defined.length ? `<section><h3>Defines</h3>${chipList(defined, "")}</section>` : ""}
      ${b.endpoints.length ? `<section>
        <h3>Endpoints</h3>
        <div class="endpoint-list compact">${[...b.endpoints]
          .sort((/** @type {any} */ x, /** @type {any} */ y) => x.path.localeCompare(y.path))
          .map((/** @type {any} */ e) => endpointRow(b, e)).join("")}</div>
      </section>` : ""}
      <div class="details-actions">
        <button class="primary" data-open="${esc(b.file)}" data-line="${b.line}">Open file</button>
        ${state.view === "board"
          ? `<button class="secondary" data-action="show-in-hierarchy">Show in hierarchy</button>`
          : `<button class="secondary" data-action="show-on-board">Show on board</button>`}
      </div>`;
  }

  function scrollSelectedIntoView() {
    const el = content.querySelector(".selected");
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Path keys from a root down to `id` (shortest), so the hierarchy can be expanded to it. */
  function pathTo(/** @type {string} */ id) {
    /** @type {{ id: string, key: string, chain: string[] }[]} */
    let frontier = roots.map(r => ({ id: r, key: r, chain: [] }));
    const seen = new Set();
    while (frontier.length) {
      const next = [];
      for (const node of frontier) {
        if (node.id === id) return node.chain;
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        for (const dep of byId.get(node.id)?.dependencies || []) {
          next.push({ id: dep, key: `${node.key}/${dep}`, chain: [...node.chain, node.key] });
        }
      }
      frontier = next;
    }
    return [];
  }

  function switchView(/** @type {string} */ view) {
    state.view = view;
    if (view === "hierarchy" && state.selectedId) pathTo(state.selectedId).forEach(k => state.expanded.add(k));
    saveState();
    render();
    scrollSelectedIntoView();
  }

  // ---------------------------------------------------------------- events

  document.addEventListener("click", e => {
    const target = /** @type {HTMLElement} */ (e.target);

    const tab = target.closest(".tab");
    if (tab) {
      switchView(/** @type {HTMLElement} */ (tab).dataset.view || "board");
      return;
    }

    const group = target.closest("[data-group]");
    if (group) {
      state.groupBy = /** @type {HTMLElement} */ (group).dataset.group || "level";
      saveState();
      render();
      scrollSelectedIntoView();
      return;
    }

    const toggle = target.closest("[data-toggle]");
    if (toggle && !toggle.classList.contains("none")) {
      const key = /** @type {HTMLElement} */ (toggle).dataset.toggle || "";
      state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
      render();
      return;
    }

    const open = target.closest("[data-open]");
    if (open) {
      const el = /** @type {HTMLElement} */ (open);
      if (el.dataset.open) vscode.postMessage({ type: "open", file: el.dataset.open, line: Number(el.dataset.line) || undefined });
      return;
    }

    const action = target.closest("[data-action]");
    if (action) {
      const name = /** @type {HTMLElement} */ (action).dataset.action;
      if (name === "deselect") state.selectedId = null;
      if (name === "collapse") state.expanded.clear();
      if (name === "expand") roots.forEach(id => state.expanded.add(id));
      if (name === "show-in-hierarchy") return switchView("hierarchy");
      if (name === "show-on-board") return switchView("board");
      render();
      return;
    }

    const select = target.closest("[data-select]");
    if (select) {
      const el = /** @type {HTMLElement} */ (select);
      const id = el.dataset.select || null;
      const fromContent = !!el.closest("#content") && !el.dataset.goto;
      state.selectedId = fromContent && state.selectedId === id ? null : id;
      if (el.dataset.goto) return switchView(el.dataset.goto);
      if (state.view === "hierarchy" && !fromContent && id) pathTo(id).forEach(k => state.expanded.add(k));
      render();
      if (!fromContent) scrollSelectedIntoView();
    }
  });

  document.addEventListener("dblclick", e => {
    const el = /** @type {HTMLElement} */ (e.target).closest("#content [data-select]");
    const b = el && byId.get(/** @type {HTMLElement} */ (el).dataset.select || "");
    if (b) vscode.postMessage({ type: "open", file: b.file, line: b.line });
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (document.activeElement === search && search.value) {
        search.value = "";
        search.dispatchEvent(new Event("input"));
      } else if (state.selectedId) {
        state.selectedId = null;
        render();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  search.addEventListener("input", () => {
    state.filter = search.value;
    saveState();
    render();
  });

  unusedToggle.addEventListener("click", () => {
    state.unusedOnly = !state.unusedOnly;
    saveState();
    render();
  });

  $("#refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));

  /** @type {string | null} */
  let pendingReveal = null;

  function reveal(/** @type {string} */ file) {
    if (!state.data) {
      pendingReveal = file;
      return;
    }
    const norm = (/** @type {string} */ f) => f.replace(/\\/g, "/").toLowerCase();
    const inFile = state.data.beans.filter((/** @type {any} */ b) => norm(b.file) === norm(file));
    if (!inFile.length) return;
    // Prefer the class the file is named after, then any class bean, then @Bean methods.
    const base = file.replace(/\\/g, "/").split("/").pop()?.replace(/\.java$/i, "");
    const target = inFile.find((/** @type {any} */ b) => b.kind !== "bean" && b.name === base)
      || inFile.find((/** @type {any} */ b) => b.kind !== "bean")
      || inFile[0];
    if (state.selectedId === target.id) return;
    state.selectedId = target.id;
    if (state.view === "endpoints") state.view = "board";
    if (state.view === "hierarchy") pathTo(target.id).forEach(key => state.expanded.add(key));
    render();
    scrollSelectedIntoView();
  }

  window.addEventListener("message", event => {
    const msg = event.data;
    if (msg.type === "data") {
      state.data = msg.payload;
      index();
      render();
      if (pendingReveal) {
        reveal(pendingReveal);
        pendingReveal = null;
      }
    } else if (msg.type === "reveal") {
      reveal(msg.file);
    } else if (msg.type === "loading") {
      content.innerHTML = `<div class="empty"><div class="spinner"></div>Analyzing workspace…</div>`;
    }
  });

  render();
  vscode.postMessage({ type: "ready" });
})();
