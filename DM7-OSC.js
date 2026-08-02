/*
 * Yamaha DM7 / DM7 Compact OSC module for Chataigne
 * Protocol: DM7 Series OSC Specifications v1.1.0
 *
 * @author Victor Koeppel
 *
 * Address grammar (set):   /yosc:req/set/<ParamID>/<X>[/<Y>]  <value>
 * Scene recall (args):     /yosc:req/ssrecallt_ex  <list>  "<number>"
 * Scene inc/dec (event):   /yosc:req/event  <ParamID>  <list>
 *
 * The console listens on UDP 49900. Set the module's OSC output remoteHost to
 * the console's "For Mixer Control" IP (SETUP > NETWORK).
 *
 * NOTE: The v1.1.0 spec does NOT document the feedback/response format for
 * parameters. The oscEvent() parser below is a best-effort guess (it assumes
 * the console echoes the same MIXER:Current/... address). Enable
 * "Log Unhandled Incoming" and watch the logger against real hardware to
 * confirm / correct the actual format.
 */

// ---- constants -------------------------------------------------------------

var REQ = "/yosc:req";
var INF_RAW = -32768; // fader "-inf" sentinel
var MIN_DB = -138;    // lowest real dB step (raw -13800); <= this => -inf

var COUNTS = {
	inputs: 120, // overwritten by model in refreshCounts()
	mixes: 48,
	matrices: 12,
	stereo: 4,
	dca: 24,
	mute: 12
};

// Feedback value specs: which channel-strip values get a two-way control.
// key -> { cont, sub, pid, type, count }
var SPEC = {
	inLevel:  { cont: "Inputs",   sub: "Level", pid: "MIXER:Current/InCh/Fader/Level", type: "level", count: "inputs" },
	inOn:     { cont: "Inputs",   sub: "On",    pid: "MIXER:Current/InCh/Fader/On",    type: "on",    count: "inputs" },
	inPan:    { cont: "Inputs",   sub: "Pan",   pid: "MIXER:Current/InCh/ToSt/Pan",    type: "pan",   count: "inputs" },
	inName:   { cont: "Inputs",   sub: "Name",  pid: "MIXER:Current/InCh/Label/Name",  type: "name",  count: "inputs" },

	mixLevel: { cont: "Mixes",    sub: "Level", pid: "MIXER:Current/Mix/Fader/Level",  type: "level", count: "mixes" },
	mixOn:    { cont: "Mixes",    sub: "On",    pid: "MIXER:Current/Mix/Fader/On",     type: "on",    count: "mixes" },
	mixName:  { cont: "Mixes",    sub: "Name",  pid: "MIXER:Current/Mix/Label/Name",   type: "name",  count: "mixes" },

	mtxLevel: { cont: "Matrices", sub: "Level", pid: "MIXER:Current/Mtrx/Fader/Level", type: "level", count: "matrices" },
	mtxOn:    { cont: "Matrices", sub: "On",    pid: "MIXER:Current/Mtrx/Fader/On",    type: "on",    count: "matrices" },
	mtxName:  { cont: "Matrices", sub: "Name",  pid: "MIXER:Current/Mtrx/Label/Name",  type: "name",  count: "matrices" },

	stLevel:  { cont: "Stereo",   sub: "Level", pid: "MIXER:Current/St/Fader/Level",   type: "level", count: "stereo" },
	stOn:     { cont: "Stereo",   sub: "On",    pid: "MIXER:Current/St/Fader/On",      type: "on",    count: "stereo" },
	stName:   { cont: "Stereo",   sub: "Name",  pid: "MIXER:Current/St/Label/Name",    type: "name",  count: "stereo" },

	dcaLevel: { cont: "DCAs",     sub: "Level", pid: "MIXER:Current/DCA/Fader/Level",  type: "level", count: "dca" },
	dcaOn:    { cont: "DCAs",     sub: "On",    pid: "MIXER:Current/DCA/Fader/On",     type: "on",    count: "dca" },
	dcaName:  { cont: "DCAs",     sub: "Name",  pid: "MIXER:Current/DCA/Label/Name",   type: "name",  count: "dca" },

	muteOn:   { cont: "Mute Groups", sub: "Muted", pid: "MIXER:Current/MuteGrpCtrl/On",         type: "on",   count: "mute" },
	muteName: { cont: "Mute Groups", sub: "Name",  pid: "MIXER:Current/MuteGrpCtrl/Label/Name", type: "name", count: "mute" }
};

// Chataigne's JS engine (JUCE) has no for..in, so keys are listed explicitly.
var SPEC_KEYS = [
	"inLevel", "inOn", "inPan", "inName",
	"mixLevel", "mixOn", "mixName",
	"mtxLevel", "mtxOn", "mtxName",
	"stLevel", "stOn", "stName",
	"dcaLevel", "dcaOn", "dcaName",
	"muteOn", "muteName"
];
var CONT_NAMES = ["Inputs", "Mixes", "Matrices", "Stereo", "DCAs", "Mute Groups"];

// runtime lookups (rebuilt by generateValues)
var valueRefs = {};   // key -> { index -> parameter }
var descByAddr = {};  // value control address -> { key, x }
var pidToKey = {};    // ParamID string -> key   (for feedback parsing)
var isUpdatingFromOSC = false;

// ---- lifecycle -------------------------------------------------------------

function init() {
	refreshCounts();
	buildPidIndex();
	generateValues();
	script.log("DM7 OSC module ready (" + local.parameters.consoleModel.get() + ", " + COUNTS.inputs + " inputs). Set the OSC output remoteHost to the console IP, port 49900.");
}

function refreshCounts() {
	COUNTS.inputs = (local.parameters.consoleModel.get() == "DM7C") ? 72 : 120;
}

function buildPidIndex() {
	pidToKey = {};
	for (var i = 0; i < SPEC_KEYS.length; i++) {
		var key = SPEC_KEYS[i];
		pidToKey[SPEC[key].pid] = key;
	}
}

function moduleParameterChanged(param) {
	if (param.name == "consoleModel") {
		refreshCounts();
		generateValues();
	} else if (param.name == "generateFeedbackValues") {
		generateValues();
	}
}

// ---- value tree (two-way feedback) -----------------------------------------

function generateValues() {
	// wipe previous tree
	for (var c = 0; c < CONT_NAMES.length; c++) {
		local.values.removeContainer(CONT_NAMES[c]);
	}
	valueRefs = {};
	descByAddr = {};

	if (!local.parameters.generateFeedbackValues.get()) return;

	var containers = {}; // cont name -> container
	var subConts = {};   // cont|sub -> container

	for (var k = 0; k < SPEC_KEYS.length; k++) {
		var key = SPEC_KEYS[k];
		var s = SPEC[key];
		var n = COUNTS[s.count];
		if (!containers[s.cont]) containers[s.cont] = local.values.addContainer(s.cont);
		var subKey = s.cont + "|" + s.sub;
		if (!subConts[subKey]) {
			subConts[subKey] = containers[s.cont].addContainer(s.sub);
			subConts[subKey].setCollapsed(true);
		}
		var sub = subConts[subKey];
		var refs = {};
		valueRefs[key] = refs;
		for (var i = 1; i <= n; i++) {
			var p = addValueParam(sub, i, s.type);
			refs["" + i] = p;
			descByAddr[p.getControlAddress()] = { key: key, x: i };
		}
	}
}

function addValueParam(container, i, type) {
	var name = "" + i;
	if (type == "level") return container.addFloatParameter(name, "dB", 0, MIN_DB, 10);
	if (type == "pan")   return container.addIntParameter(name, "L63..R63", 0, -63, 63);
	if (type == "on")    return container.addBoolParameter(name, "", false);
	return container.addStringParameter(name, "", ""); // name
}

// A generated value changed (from the UI, a mapping, or OSC feedback).
function moduleValueChanged(value) {
	if (isUpdatingFromOSC) return; // don't echo feedback back to the console
	var d = descByAddr[value.getControlAddress()];
	if (!d) return;
	var s = SPEC[d.key];
	sendSet(s.pid + "/" + d.x, encode(s.type, value.get()));
}

// ---- conversions -----------------------------------------------------------

function dbToRaw(db) {
	if (db <= MIN_DB) return INF_RAW;
	var raw = Math.round(db * 100);
	if (raw > 1000) raw = 1000;
	if (raw < -13800) raw = -13800;
	return raw;
}

function rawToDb(raw) {
	if (raw <= INF_RAW) return MIN_DB;
	return raw / 100;
}

function encode(type, v) {
	if (type == "level") return dbToRaw(v);
	if (type == "on")    return v ? 1 : 0;
	if (type == "pan")   return Math.round(v);
	return v; // name (string)
}

function decode(type, raw) {
	if (type == "level") return rawToDb(parseInt(raw));
	if (type == "on")    return parseInt(raw) != 0;
	if (type == "pan")   return parseInt(raw);
	return "" + raw; // name
}

// ---- OSC send helpers ------------------------------------------------------

// /yosc:req/set/<paramIdWithIndices>  <value>
function sendSet(paramIdWithIndices, value) {
	local.send(REQ + "/set/" + paramIdWithIndices, value);
}

// ---- command callbacks (Input Channel) -------------------------------------

function inFaderLevel(ch, db)      { sendSet("MIXER:Current/InCh/Fader/Level/" + ch, dbToRaw(db)); }
function inFaderOn(ch, on)         { sendSet("MIXER:Current/InCh/Fader/On/" + ch, on ? 1 : 0); }
function inPan(ch, pan)            { sendSet("MIXER:Current/InCh/ToSt/Pan/" + ch, Math.round(pan)); }
function inName(ch, name)          { sendSet("MIXER:Current/InCh/Label/Name/" + ch, name); }
function inColor(ch, color)        { sendSet("MIXER:Current/InCh/Label/Color/" + ch, color); }
function inToMixLevel(ch, mix, db) { sendSet("MIXER:Current/InCh/ToMix/Level/" + ch + "/" + mix, dbToRaw(db)); }
function inToMixOn(ch, mix, on)    { sendSet("MIXER:Current/InCh/ToMix/On/" + ch + "/" + mix, on ? 1 : 0); }
function inToMixPan(ch, mix, pan)  { sendSet("MIXER:Current/InCh/ToMix/Pan/" + ch + "/" + mix, Math.round(pan)); }
function inToMtrxLevel(ch, mtx, db){ sendSet("MIXER:Current/InCh/ToMtrx/Level/" + ch + "/" + mtx, dbToRaw(db)); }
function inToMtrxOn(ch, mtx, on)   { sendSet("MIXER:Current/InCh/ToMtrx/On/" + ch + "/" + mtx, on ? 1 : 0); }
function inDcaAssign(ch, dca, a)   { sendSet("MIXER:Current/InCh/DCA/Assign/" + ch + "/" + dca, a ? 1 : 0); }

// ---- command callbacks (Mix Channel) ---------------------------------------

function mixFaderLevel(mix, db)      { sendSet("MIXER:Current/Mix/Fader/Level/" + mix, dbToRaw(db)); }
function mixFaderOn(mix, on)         { sendSet("MIXER:Current/Mix/Fader/On/" + mix, on ? 1 : 0); }
function mixName(mix, name)          { sendSet("MIXER:Current/Mix/Label/Name/" + mix, name); }
function mixColor(mix, color)        { sendSet("MIXER:Current/Mix/Label/Color/" + mix, color); }
function mixToMtrxLevel(mix, mtx, db){ sendSet("MIXER:Current/Mix/ToMtrx/Level/" + mix + "/" + mtx, dbToRaw(db)); }
function mixToMtrxOn(mix, mtx, on)   { sendSet("MIXER:Current/Mix/ToMtrx/On/" + mix + "/" + mtx, on ? 1 : 0); }

// ---- command callbacks (Matrix Channel) ------------------------------------

function mtrxFaderLevel(mtx, db) { sendSet("MIXER:Current/Mtrx/Fader/Level/" + mtx, dbToRaw(db)); }
function mtrxFaderOn(mtx, on)    { sendSet("MIXER:Current/Mtrx/Fader/On/" + mtx, on ? 1 : 0); }
function mtrxName(mtx, name)     { sendSet("MIXER:Current/Mtrx/Label/Name/" + mtx, name); }
function mtrxColor(mtx, color)   { sendSet("MIXER:Current/Mtrx/Label/Color/" + mtx, color); }

// ---- command callbacks (Stereo Channel) ------------------------------------

function stFaderLevel(st, db) { sendSet("MIXER:Current/St/Fader/Level/" + st, dbToRaw(db)); }
function stFaderOn(st, on)    { sendSet("MIXER:Current/St/Fader/On/" + st, on ? 1 : 0); }
function stName(st, name)     { sendSet("MIXER:Current/St/Label/Name/" + st, name); }

// ---- command callbacks (DCA Group) -----------------------------------------

function dcaFaderLevel(dca, db) { sendSet("MIXER:Current/DCA/Fader/Level/" + dca, dbToRaw(db)); }
function dcaFaderOn(dca, on)    { sendSet("MIXER:Current/DCA/Fader/On/" + dca, on ? 1 : 0); }
function dcaName(dca, name)     { sendSet("MIXER:Current/DCA/Label/Name/" + dca, name); }
function dcaColor(dca, color)   { sendSet("MIXER:Current/DCA/Label/Color/" + dca, color); }

// ---- command callbacks (Mute Group) ----------------------------------------

function muteGroupOn(mg, muted) { sendSet("MIXER:Current/MuteGrpCtrl/On/" + mg, muted ? 1 : 0); }
function muteGroupName(mg, name){ sendSet("MIXER:Current/MuteGrpCtrl/Label/Name/" + mg, name); }

// ---- command callbacks (Scene) ---------------------------------------------

function recallScene(list, number) {
	// number must be sent as "x.xx"
	local.send(REQ + "/ssrecallt_ex", list, number.toFixed(2));
}
function sceneInc(list) { local.send(REQ + "/event", "MIXER:Lib/Scene/RecallInc", list); }
function sceneDec(list) { local.send(REQ + "/event", "MIXER:Lib/Scene/RecallDec", list); }

// ---- command callbacks (Advanced) ------------------------------------------

function sendRawSet(paramIdWithIndices, value) {
	var v = value;
	if (value !== "" && !isNaN(value)) v = parseFloat(value); // numeric string -> number
	sendSet(paramIdWithIndices, v);
}

// ---- incoming OSC (experimental feedback) ----------------------------------

function oscEvent(address, args) {
	// Best-effort: find the "MIXER:Current" token, treat the trailing numeric
	// token(s) as X (/Y) indices and the rest as the ParamID. Value is args[0]
	// if present, else the last address token.
	var tokens = address.split("/");
	var start = -1;
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i] == "MIXER:Current") { start = i; break; }
	}
	if (start < 0) { logUnhandled(address, args); return; }

	// walk back over trailing numeric index tokens; the first one is X.
	// (avoid Array.slice/join/unshift - unsupported by Chataigne's JS engine)
	var end = tokens.length - 1;
	while (end > start && isIntToken(tokens[end])) end--;
	if (end + 1 >= tokens.length) { logUnhandled(address, args); return; } // no index token
	var xToken = tokens[end + 1];

	var pid = "";
	for (var j = start; j <= end; j++) pid += (j > start ? "/" : "") + tokens[j];

	var key = pidToKey[pid];
	if (key === undefined) { logUnhandled(address, args); return; }

	var refs = valueRefs[key];
	var target = refs ? refs["" + parseInt(xToken)] : null;
	if (!target) { logUnhandled(address, args); return; }

	var raw = (args && args.length > 0) ? args[0] : tokens[tokens.length - 1];
	isUpdatingFromOSC = true;
	target.set(decode(SPEC[key].type, raw));
	isUpdatingFromOSC = false;
}

function isIntToken(t) {
	if (t.length == 0) return false;
	for (var i = 0; i < t.length; i++) {
		var ch = t.charAt(i);
		if (i == 0 && ch == "-") continue;
		if (ch < "0" || ch > "9") return false;
	}
	return t != "-";
}

function logUnhandled(address, args) {
	if (!local.parameters.logUnhandledIncoming.get()) return;
	var argStr = "";
	if (args) {
		for (var i = 0; i < args.length; i++) argStr += (i > 0 ? ", " : "") + args[i];
	}
	script.log("Unhandled OSC in: " + address + " [" + argStr + "]");
}
