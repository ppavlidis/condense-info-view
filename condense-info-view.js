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
	//   _lastCreatorItemID, _moreLabelClickedForItemID }
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

		// Remove injected elements.
		const doc = window.document;
		for (const id of data.addedElementIDs) {
			doc.getElementById(id)?.remove();
		}

		// Remove our CSS classes so the pane returns to normal.
		for (const el of doc.querySelectorAll(".civ-row-hidden, .civ-row-dimmed, .civ-creator-hidden")) {
			el.classList.remove("civ-row-hidden", "civ-row-dimmed", "civ-creator-hidden");
		}
		for (const el of doc.querySelectorAll(".civ-creator-ellipsis")) {
			el.remove();
		}

		this._windows.delete(window);
	},

	// ─── Observer setup ───────────────────────────────────────────────────────

	_setupObservers(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		const self = this;

		// Track the most recently seen info table so we only attach the
		// fine-grained observer once.
		let knownInfoTable = null;
		let tableObserver = null;

		const attachToTable = (table) => {
			if (table === knownInfoTable) return;
			knownInfoTable = table;
			if (tableObserver) tableObserver.disconnect();

			tableObserver = new window.MutationObserver(() => self._scheduleUpdate(window));
			// childList catches row add/remove (item type changes re-render all rows).
			// attributeFilter catches editable-text value changes while on the same item.
			tableObserver.observe(table, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["value"],
			});
			data.observers.push(tableObserver);
			self._scheduleUpdate(window);
		};

		// A coarser observer on the document root detects when the info table
		// appears (e.g. on first load, tab switch, or pane collapse/expand).
		const docObserver = new window.MutationObserver(() => {
			const table = doc.getElementById("info-table");
			if (table) attachToTable(table);
		});
		docObserver.observe(doc.documentElement, { childList: true, subtree: true });
		data.observers.push(docObserver);

		// Immediate check in case the table already exists.
		const existingTable = doc.getElementById("info-table");
		if (existingTable) attachToTable(existingTable);
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
		const infoTable = doc.getElementById("info-table");
		if (!infoTable) return;

		// Do not reclassify rows while the user is actively typing in a field —
		// that would hide the row they're editing. Only bail for actual text
		// inputs; Zotero moves focus to other elements in the table for
		// navigation, which should not block our update.
		const active = doc.activeElement;
		if (active && infoTable.contains(active) &&
			(active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;

		const data = this._windows.get(window);
		if (!data) return;

		this._ensureToggleButton(window);

		const importantFields = this._importantFieldsForWindow(window);
		const showAll = data.showAll;

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

		this._updateCreators(window);
	},

	// ─── Creator collapsing ───────────────────────────────────────────────────

	_updateCreators(window) {
		const doc = window.document;
		const infoTable = doc.getElementById("info-table");
		if (!infoTable) return;

		const data = this._windows.get(window);
		if (!data) return;

		// Reset per-item state when the selected item changes.
		const currentItemID = this._getCurrentItemID(window);
		if (data._lastCreatorItemID !== currentItemID) {
			data._lastCreatorItemID = currentItemID;
			data._moreLabelClickedForItemID = null;
			data.showAllCreators = false;
		}

		// Showing all creators: clear our additions and bail.
		if (data.showAll || data.showAllCreators) {
			for (const el of infoTable.querySelectorAll(".civ-creator-ellipsis")) el.remove();
			for (const el of infoTable.querySelectorAll(".civ-creator-hidden")) {
				el.classList.remove("civ-creator-hidden");
			}
			return;
		}

		// Zotero renders only the first 5 creators and adds a "N more..." row
		// (div#more-creators-label) for the rest. Click it once to expand all
		// creators into the DOM; our observer fires after the re-render.
		//
		// Guard: only click once per item. During a sync storm Zotero can keep
		// re-rendering the creator list with the label still present, causing an
		// infinite click → mutation → click loop if we click unconditionally.
		const moreLabel = doc.getElementById("more-creators-label");
		if (moreLabel) {
			if (data._moreLabelClickedForItemID !== currentItemID) {
				data._moreLabelClickedForItemID = currentItemID;
				moreLabel.click();
			}
			// Whether we just clicked or already did (and it reappeared during sync),
			// bail and let Zotero finish rendering before we apply our collapsing.
			return;
		}
		// moreLabel is gone — all creators are in the DOM. Clear the click guard
		// so it works correctly if this item is navigated away from and back.
		data._moreLabelClickedForItemID = null;

		// All creators are now in the DOM. If we already applied our collapsing,
		// skip to avoid an observer feedback loop (inserting the ellipsis node
		// itself triggers a childList mutation).
		if (infoTable.querySelector(".civ-creator-ellipsis")) return;

		const creatorRows = Array.from(infoTable.querySelectorAll(".meta-row"))
			.filter(row => this._isCreatorRow(row));

		if (creatorRows.length < this.CREATOR_COLLAPSE_THRESHOLD) return;

		const last    = creatorRows[creatorRows.length - 1];
		const hiddenRows = creatorRows.slice(1, -1);

		for (const row of hiddenRows) row.classList.add("civ-creator-hidden");

		// Build the clickable "··· N more" row aligned to the value column.
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
		const expand = () => {
			data.showAllCreators = true;
			self._updateCreators(window);
		};
		ellipsis.addEventListener("click", expand);
		ellipsis.addEventListener("keydown", e => {
			if (e.key === "Enter" || e.key === " ") { e.preventDefault(); expand(); }
		});

		last.before(ellipsis);
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

	// ─── Toggle button ────────────────────────────────────────────────────────

	_ensureToggleButton(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		if (!data) return;

		// If the button already exists, make sure its label matches data.showAll.
		// The section header can be rebuilt by Zotero (e.g. during a protocol
		// navigation), which would remove and recreate our button; if that happens
		// we create a fresh one below. But occasionally the element survives while
		// its text gets out of sync — resync it here.
		const existing = doc.getElementById("civ-toggle-btn");
		if (existing) {
			const wantText = data.showAll ? "hide empty" : "show empty";
			if (existing.textContent !== wantText) {
				existing.textContent = wantText;
				existing.title = data.showAll ? "Hide empty fields" : "Show all empty fields";
				existing.classList.toggle("civ-toggle-active", data.showAll);
			}
			return;
		}

		// Insert into the collapsible-section header for the Info pane,
		// just before the expand/collapse twisty button.
		const infoElement = doc.getElementById("zotero-editpane-info-box");
		const section = infoElement?.querySelector("collapsible-section")
			?? doc.querySelector("collapsible-section[data-pane='info']");
		const head = section?.querySelector(".head");
		if (!head) return;

		const btn = doc.createElement("button");
		btn.id = "civ-toggle-btn";
		btn.className = "civ-toggle-btn";
		// Initialise label from current state, not always "show empty", so that
		// if the button is recreated after a re-render the label stays correct.
		btn.textContent = data.showAll ? "hide empty" : "show empty";
		btn.title = data.showAll ? "Hide empty fields" : "Show all empty fields";
		btn.classList.toggle("civ-toggle-active", data.showAll);

		const self = this;
		btn.addEventListener("click", (e) => {
			e.stopPropagation(); // don't collapse the section
			data.showAll = !data.showAll;
			// Showing all fields also expands creators; hiding resets them.
			if (data.showAll) data.showAllCreators = true;
			else data.showAllCreators = false;
			btn.textContent = data.showAll ? "hide empty" : "show empty";
			btn.title = data.showAll ? "Hide empty fields" : "Show all empty fields";
			btn.classList.toggle("civ-toggle-active", data.showAll);
			self._updateRows(window);
		});

		const twisty = head.querySelector(".twisty");
		if (twisty) {
			twisty.before(btn);
		} else {
			head.appendChild(btn);
		}

		data.addedElementIDs.push("civ-toggle-btn");
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
