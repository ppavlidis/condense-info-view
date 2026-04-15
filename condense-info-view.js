// Condense Info View — hides empty fields in the Zotero item info panel.
//
// Empty fields are divided into two tiers:
//   • "important" fields for this item type: shown dimmed (opacity reduced)
//     so the user is reminded they could fill them in.
//   • everything else: hidden entirely.
//
// A small toggle in the section header lets the user reveal all fields at once.

var CondenseInfoView = {
	id: null,
	version: null,
	rootURI: null,

	// Per-window state: Map from Window object → { observers[], addedElementIDs[], showAll, showAllCreators, timer,
	//   _lastCreatorItemID, _moreLabelClickedTables (WeakSet of tables clicked for current item) }
	_windows: new Map(),

	// Minimum number of creator rows before collapsing kicks in.
	CREATOR_COLLAPSE_THRESHOLD: 3,

	// Fields always shown even when empty (they are set by Zotero itself and
	// are always structurally relevant regardless of item type).
	ALWAYS_SHOW: new Set(["title", "itemType"]),

	// Fields that are "important" for each item type and should remain visible
	// (albeit dimmed) when empty, as a prompt to fill them in.
	//
	// The fieldname values match the `fieldname` DOM attribute on .meta-label
	// elements inside the info table.
	IMPORTANT_BY_TYPE: {
		journalArticle:      ["publicationTitle", "date", "volume", "issue", "pages", "DOI", "ISSN", "url"],
		book:                ["publisher", "place", "date", "ISBN", "edition", "url"],
		bookSection:         ["bookTitle", "publisher", "place", "date", "pages", "ISBN", "url"],
		thesis:              ["university", "place", "date", "thesisType", "url"],
		conferencePaper:     ["conferenceName", "proceedingsTitle", "date", "pages", "place", "DOI", "url"],
		report:              ["institution", "place", "date", "reportNumber", "reportType", "url"],
		webpage:             ["url", "websiteTitle", "accessDate", "date"],
		blogPost:            ["url", "blogTitle", "accessDate", "date"],
		forumPost:           ["url", "forumTitle", "accessDate", "date"],
		magazineArticle:     ["publicationTitle", "date", "volume", "issue", "pages", "ISSN", "url"],
		newspaperArticle:    ["publicationTitle", "place", "date", "section", "pages", "ISSN", "url"],
		encyclopediaArticle: ["encyclopediaTitle", "publisher", "place", "date", "pages", "ISBN", "url"],
		dictionaryEntry:     ["dictionaryTitle", "publisher", "place", "date", "pages", "ISBN", "url"],
		patent:              ["country", "patentNumber", "filingDate", "issueDate", "url"],
		presentation:        ["date", "place", "meetingName", "url"],
		videoRecording:      ["publisher", "place", "date", "runningTime", "url"],
		audioRecording:      ["label", "place", "date", "runningTime", "url"],
		podcast:             ["seriesTitle", "runningTime", "url", "accessDate"],
		tvBroadcast:         ["network", "place", "date", "url"],
		radioBroadcast:      ["network", "place", "date", "url"],
		artwork:             ["artworkMedium", "artworkSize", "date", "url"],
		computerProgram:     ["company", "place", "date", "version", "url"],
		document:            ["publisher", "place", "date", "url"],
		manuscript:          ["publisher", "place", "date", "url"],
		map:                 ["publisher", "place", "date", "scale", "url"],
		interview:           ["date", "interviewMedium", "url"],
		letter:              ["date"],
		email:               ["date"],
	},

	// Fallback for unknown item types.
	DEFAULT_IMPORTANT: ["date", "publisher", "place", "url"],

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	addToAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			if (!win.closed) this.addToWindow(win);
		}
	},

	removeFromAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			this.removeFromWindow(win);
		}
	},

	addToWindow(window) {
		if (this._windows.has(window)) return;

		const doc = window.document;
		const data = { observers: [], addedElementIDs: [], showAll: false, showAllCreators: false, timer: null };
		this._windows.set(window, data);

		// Inject stylesheet.
		const link = doc.createElement("link");
		link.id = "condense-info-view-style";
		link.rel = "stylesheet";
		link.href = this.rootURI + "style.css";
		doc.documentElement.appendChild(link);
		data.addedElementIDs.push(link.id);

		this._setupObservers(window);
	},

	removeFromWindow(window) {
		const data = this._windows.get(window);
		if (!data) return;

		// Cancel any pending update.
		if (data.timer) window.clearTimeout(data.timer);

		// Disconnect all observers.
		for (const obs of data.observers) obs.disconnect();

		// Remove injected elements (stylesheet etc. tracked by id).
		const doc = window.document;
		for (const id of data.addedElementIDs) {
			doc.getElementById(id)?.remove();
		}
		// Toggle buttons are tracked by class (can be multiple — one per Info
		// section across main pane and reader side panels).
		for (const btn of doc.querySelectorAll(".civ-toggle-btn")) btn.remove();

		// Remove our CSS classes so the pane returns to normal.
		for (const el of doc.querySelectorAll(".civ-row-hidden, .civ-row-dimmed, .civ-creator-hidden")) {
			el.classList.remove("civ-row-hidden", "civ-row-dimmed", "civ-creator-hidden");
		}
		for (const el of doc.querySelectorAll(".civ-creator-ellipsis")) {
			el.remove();
		}

		this._windows.delete(window);
	},

	// ─── Table discovery ──────────────────────────────────────────────────────

	// There can be multiple `#info-table` elements live in the document at the
	// same time — one for the main item pane, plus another for each reader-tab
	// side panel when viewing attachments/parent items. Process all of them.
	_infoTables(doc) {
		return doc.querySelectorAll("#info-table");
	},

	// Matching Info sections (one per live info-table) for toggle-button injection.
	_infoSections(doc) {
		return doc.querySelectorAll("collapsible-section[data-pane='info']");
	},

	// ─── Observer setup ───────────────────────────────────────────────────────

	_setupObservers(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		const self = this;

		// Per-table fine-grained observers. New info-tables can appear at any
		// time (opening a reader tab, selecting an attachment, etc.), so we
		// track every one we've seen via a WeakSet and attach on demand.
		const observedTables = new WeakSet();

		const attachToAllTables = () => {
			let sawAny = false;
			for (const table of self._infoTables(doc)) {
				sawAny = true;
				if (observedTables.has(table)) continue;
				observedTables.add(table);

				const obs = new window.MutationObserver(() => self._scheduleUpdate(window));
				// childList catches row add/remove (item type changes re-render all rows).
				// attributeFilter catches editable-text value changes while on the same item.
				obs.observe(table, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["value"],
				});
				data.observers.push(obs);
			}
			if (sawAny) self._scheduleUpdate(window);
		};

		// A coarser observer on the document root detects when new info tables
		// appear (first load, reader tab open, pane collapse/expand, etc.).
		const docObserver = new window.MutationObserver(attachToAllTables);
		docObserver.observe(doc.documentElement, { childList: true, subtree: true });
		data.observers.push(docObserver);

		// Immediate check in case tables already exist.
		attachToAllTables();
	},

	// ─── Row update logic ─────────────────────────────────────────────────────

	_scheduleUpdate(window) {
		const data = this._windows.get(window);
		if (!data) return;
		if (data.timer) window.clearTimeout(data.timer);
		data.timer = window.setTimeout(() => {
			data.timer = null;
			this._updateRows(window);
		}, 80);
	},

	_updateRows(window) {
		const doc = window.document;
		const infoTables = this._infoTables(doc);
		if (!infoTables.length) return;

		const data = this._windows.get(window);
		if (!data) return;

		this._ensureToggleButtons(window);

		// `importantFields` isn't used in show-all mode; compute only when needed.
		const showAll = data.showAll;
		const importantFields = showAll ? null : this._importantFieldsForWindow(window);
		const active = doc.activeElement;

		for (const infoTable of infoTables) {
			// Skip this particular table if the user is actively typing in one
			// of its fields — we don't want to hide the row they're editing.
			// Only bail for actual text inputs; Zotero moves focus to other
			// elements for keyboard navigation and we don't want to be blocked
			// by those.
			if (active && infoTable.contains(active) &&
				(active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) continue;

			for (const row of infoTable.querySelectorAll(".meta-row")) {
				// Always clear previous classifications first.
				row.classList.remove("civ-row-hidden", "civ-row-dimmed");

				if (showAll) continue;

				const fieldname = this._rowFieldname(row);
				if (!fieldname) continue;

				// Title and item type: always show.
				if (this.ALWAYS_SHOW.has(fieldname)) continue;

				// Creator rows (authors, editors, etc.): never hide.
				if (this._isCreatorRow(row)) continue;

				if (!this._isRowEmpty(row)) continue;

				// Empty field — decide whether to dim or hide.
				if (importantFields.has(fieldname)) {
					row.classList.add("civ-row-dimmed");
				} else {
					row.classList.add("civ-row-hidden");
				}
			}
		}

		this._updateCreators(window);
	},

	// ─── Creator collapsing ───────────────────────────────────────────────────

	_updateCreators(window) {
		const doc = window.document;
		const infoTables = this._infoTables(doc);
		if (!infoTables.length) return;

		const data = this._windows.get(window);
		if (!data) return;

		// Reset per-item state when the selected item changes.
		const currentItemID = this._getCurrentItemID(window);
		if (data._lastCreatorItemID !== currentItemID) {
			data._lastCreatorItemID = currentItemID;
			data._moreLabelClickedTables = null;
			data.showAllCreators = false;
		}

		// When showing all creators, do nothing here. The one-shot cleanup
		// (removing our ellipsis / civ-creator-hidden classes) is done by the
		// transition handlers — the toggle-button click and the "··· N more"
		// click — so we do not cause any DOM mutations from here during
		// sync-driven updates. Running cleanup on every _updateRows call
		// produced a feedback loop in show-empty mode: each el.remove() is a
		// childList mutation that fires the observer, schedules another
		// update, and re-enters this branch.
		if (data.showAll || data.showAllCreators) return;

		for (const infoTable of infoTables) {
			this._collapseCreatorsIn(window, infoTable, currentItemID);
		}
	},

	_collapseCreatorsIn(window, infoTable, currentItemID) {
		const doc = window.document;
		const data = this._windows.get(window);

		// Zotero renders only the first 5 creators in each info-table and adds
		// a "N more..." row (div#more-creators-label, scoped per table) for the
		// rest. Click it once per table to expand all creators into the DOM.
		//
		// Guard: only click once per (item, table) pair. During a sync storm
		// Zotero can keep re-rendering the creator list with the label still
		// present, causing a click → mutation → click loop if we click
		// unconditionally. We track which tables we've already clicked in a
		// WeakSet that's reset whenever the selected item changes.
		const moreLabel = infoTable.querySelector("#more-creators-label");
		if (moreLabel) {
			if (!data._moreLabelClickedTables) data._moreLabelClickedTables = new WeakSet();
			if (!data._moreLabelClickedTables.has(infoTable)) {
				data._moreLabelClickedTables.add(infoTable);
				moreLabel.click();
			}
			// Whether we just clicked or it reappeared, bail and let Zotero
			// finish before applying our collapsing for this table.
			return;
		}

		// All creators for this table are now in the DOM. If we already applied
		// our collapsing here, skip to avoid an observer feedback loop
		// (inserting the ellipsis node itself triggers a childList mutation).
		if (infoTable.querySelector(".civ-creator-ellipsis")) return;

		const creatorRows = Array.from(infoTable.querySelectorAll(".meta-row"))
			.filter(row => this._isCreatorRow(row));

		if (creatorRows.length < this.CREATOR_COLLAPSE_THRESHOLD) return;

		const last       = creatorRows[creatorRows.length - 1];
		const hiddenRows = creatorRows.slice(1, -1);

		for (const row of hiddenRows) row.classList.add("civ-creator-hidden");

		// Build the clickable ellipsis row aligned to the value column. It
		// acts as a toggle: labelled "··· N more" when middle creators are
		// hidden, "collapse" when they are shown. Clicking it flips the state
		// across every live info-table in the document so the main pane and
		// any reader-tab side panels stay in sync.
		const ellipsis = doc.createElement("div");
		ellipsis.className = "civ-creator-ellipsis";
		ellipsis.setAttribute("role", "button");
		ellipsis.setAttribute("tabindex", "0");
		ellipsis.title = "Show all authors";

		const spacer = doc.createElement("div"); // occupies the label column
		ellipsis.appendChild(spacer);

		const countLabel = doc.createElement("div");
		countLabel.className = "civ-creator-ellipsis-label";
		countLabel.textContent = `··· ${hiddenRows.length} more`;
		ellipsis.appendChild(countLabel);

		const self = this;
		const toggle = () => self._setCreatorsExpanded(window, !data.showAllCreators);
		ellipsis.addEventListener("click", toggle);
		ellipsis.addEventListener("keydown", e => {
			if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
		});

		last.before(ellipsis);
	},

	// Flip the expanded/collapsed state for all creator ellipses in this
	// window's document. Used by the ellipsis click (toggle) and indirectly
	// by the show-empty button (which just sets the state and calls
	// _updateRows for everything else). We iterate over every info-table
	// because the same window can have the info pane rendered in multiple
	// places simultaneously (main pane + reader-tab side panel); the user
	// clicks one ellipsis but expects all of them to reflect the new state.
	_setCreatorsExpanded(window, expanded) {
		const data = this._windows.get(window);
		if (!data) return;
		data.showAllCreators = expanded;

		for (const table of this._infoTables(window.document)) {
			const ellipsis = table.querySelector(".civ-creator-ellipsis");
			if (!ellipsis) continue;
			const label = ellipsis.querySelector(".civ-creator-ellipsis-label");
			const creatorRows = Array.from(table.querySelectorAll(".meta-row"))
				.filter(row => this._isCreatorRow(row));
			if (creatorRows.length < this.CREATOR_COLLAPSE_THRESHOLD) continue;
			const middle = creatorRows.slice(1, -1);

			if (expanded) {
				for (const row of middle) row.classList.remove("civ-creator-hidden");
				if (label) label.textContent = "collapse";
				ellipsis.title = "Collapse authors";
			} else {
				for (const row of middle) row.classList.add("civ-creator-hidden");
				if (label) label.textContent = `··· ${middle.length} more`;
				ellipsis.title = "Show all authors";
			}
		}
	},

	_getCurrentItemID(window) {
		try {
			const items = window.ZoteroPane?.getSelectedItems?.();
			return items?.length === 1 ? items[0].id : null;
		} catch (_) {
			return null;
		}
	},

	_importantFieldsForWindow(window) {
		try {
			const pane = window.ZoteroPane;
			const items = pane?.getSelectedItems?.();
			if (items?.length === 1) {
				const typeName = Zotero.ItemTypes.getName(items[0].itemTypeID);
				const list = this.IMPORTANT_BY_TYPE[typeName] || this.DEFAULT_IMPORTANT;
				return new Set(list);
			}
		} catch (_) {}
		return new Set(this.DEFAULT_IMPORTANT);
	},

	// ─── Toggle buttons ───────────────────────────────────────────────────────

	// Inject a toggle button into every Info-section header in the document
	// that doesn't already have one. There can be multiple: one for the main
	// item pane, plus one per reader-tab side panel. All buttons share the
	// per-window `data.showAll` state, so clicking any of them applies
	// globally and keeps all of their labels in sync.
	_ensureToggleButtons(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		if (!data) return;

		for (const section of this._infoSections(doc)) {
			const head = section.querySelector(".head");
			if (!head) continue;
			if (head.querySelector(".civ-toggle-btn")) continue;

			const btn = this._createToggleButton(window, data);
			const twisty = head.querySelector(".twisty");
			if (twisty) twisty.before(btn);
			else head.appendChild(btn);
		}
	},

	_createToggleButton(window, data) {
		const doc = window.document;
		const self = this;

		const btn = doc.createElement("button");
		btn.className = "civ-toggle-btn";
		// Initialise label from current state so that a button added late
		// (e.g. when a reader tab opens after the user has already clicked
		// "show empty") shows the correct label.
		btn.textContent = data.showAll ? "hide empty" : "show empty";
		btn.title       = data.showAll ? "Hide empty fields" : "Show all empty fields";
		btn.classList.toggle("civ-toggle-active", data.showAll);

		btn.addEventListener("click", (e) => {
			e.stopPropagation(); // don't collapse the section
			data.showAll = !data.showAll;
			if (data.showAll) {
				data.showAllCreators = true;
				// Transition cleanup across every info-table (ellipsis /
				// civ-creator-hidden), done once on click rather than on every
				// _updateRows tick. See the matching comment in _updateCreators.
				for (const table of self._infoTables(doc)) {
					for (const el of table.querySelectorAll(".civ-creator-ellipsis")) el.remove();
					for (const el of table.querySelectorAll(".civ-creator-hidden")) {
						el.classList.remove("civ-creator-hidden");
					}
				}
			} else {
				data.showAllCreators = false;
			}
			// Sync ALL buttons' labels, not just this one, so the main-pane
			// button and side-panel button stay consistent.
			const label = data.showAll ? "hide empty" : "show empty";
			const title = data.showAll ? "Hide empty fields" : "Show all empty fields";
			for (const b of doc.querySelectorAll(".civ-toggle-btn")) {
				b.textContent = label;
				b.title = title;
				b.classList.toggle("civ-toggle-active", data.showAll);
			}
			self._updateRows(window);
		});

		return btn;
	},

	// ─── DOM helpers ──────────────────────────────────────────────────────────

	_rowFieldname(row) {
		return row.querySelector(".meta-label")?.getAttribute("fieldname") ?? null;
	},

	_isCreatorRow(row) {
		// Creator rows use .creator-type-value instead of .meta-data.
		return !!row.querySelector(".creator-type-value");
	},

	_isRowEmpty(row) {
		// Creator rows are never considered empty (they don't exist if no creators).
		if (this._isCreatorRow(row)) return false;

		const fields = row.querySelectorAll("editable-text");
		if (!fields.length) return false; // Non-text row — leave alone.

		return Array.from(fields).every((et) => {
			// Prefer the live DOM property; fall back to the HTML attribute.
			const propVal = typeof et.value === "string" ? et.value : null;
			const attrVal = et.getAttribute("value");
			const val = propVal ?? attrVal ?? "";
			return val.trim() === "";
		});
	},
};
