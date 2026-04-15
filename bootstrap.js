var CondenseInfoView;

function log(msg) {
	Zotero.debug("Condense Info View: " + msg);
}

function install() {
	log("Installed");
}

async function startup({ id, version, rootURI }) {
	log("Starting");
	Services.scriptloader.loadSubScript(rootURI + "condense-info-view.js");
	CondenseInfoView.init({ id, version, rootURI });
	CondenseInfoView.addToAllWindows();
}

function onMainWindowLoad({ window }) {
	CondenseInfoView.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	CondenseInfoView.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down");
	CondenseInfoView.removeFromAllWindows();
	CondenseInfoView = undefined;
}

function uninstall() {
	log("Uninstalled");
}
