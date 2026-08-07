/*
 * Yamaha DM7 / DM7 Compact OSC module for Chataigne
 * Protocol: DM7 Series OSC Specifications v1.1.0
 *
 * @author Victor Koeppel
 *
 * Address grammar (set):   /yosc:req/set/<ParamID>/<X>[/<Y>]  <value>
 * Address grammar (get):   /yosc:req/get/<ParamID>/<X>[/<Y>]           (state query, no value)
 * Subscribe (push fb):     /yosc:req/subscribe/<ParamID>[/<X>]         (ask desk to push changes)
 * Unsubscribe:             /yosc:req/unsubscribe/<ParamID>[/<X>]
 * Keepalive (heartbeat):   /yosc:req/keepalive                        (stops idle session drop)
 * Scene recall (args):     /yosc:req/ssrecallt_ex  <list>  "<number>"
 * Scene query (args):      /yosc:req/sscurrentt_ex  <list>            (read current scene number)
 * Scene info (args):       /yosc:req/ssinfot_ex  <list>  "<number>"  (read scene name/comment)
 * Scene inc/dec (event):   /yosc:req/event  <ParamID>  <list>
 *
 * The console listens on UDP 49900. Set the module's OSC output remoteHost to
 * the console's "For Mixer Control" IP (SETUP > NETWORK).
 *
 * FEEDBACK: The public v1.1.0 OSC spec does NOT document the response format,
 * but reverse-engineering the DM7 firmware (V1.75 app_console_main; see
 * ../Yamaha-RCP-Chataigne-Module/docs/dm7-rcp-parameters.md, "YOSC" section)
 * settles the transport: the OSC server has SUBSCRIBE/UNSUBSCRIBE/KEEPALIVE
 * (real push feedback), and replies/pushes arrive under FIXED address prefixes
 * — /yosc:ok/get/... (get reply), /yosc:notify/set/... and /yosc:okm/set/...
 * (pushed updates), /yosc:ok/keepalive, /yosc:error/... — NOT an echoed
 * MIXER:Current address. oscEvent() dispatches on those prefixes.
 *
 * Still unverified WITHOUT a real desk (static firmware extraction only): the
 * exact argument encoding after each prefix, and whether MIXER:Current/...
 * addresses (vs the ts:-prefixed object addresses seen in firmware) are
 * subscribable. So push is experimental and OFF by default; keep polling
 * (Refresh All Feedback Values / Scene Poll) as the fallback, and watch "Log
 * Unhandled Incoming" against hardware to confirm / correct the arg format.
 */

// ---- constants -------------------------------------------------------------

var REQ = "/yosc:req";
var INF_RAW = -32768; // fader "-inf" sentinel
var MIN_DB = -138;    // lowest real dB step (raw -13800); <= this => -inf

var REFRESH_RATE = 25; // Hz: update() rate while draining the refresh queue
var GET_BATCH = 20;    // gets flushed per update() tick during a refresh

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
	inColor:  { cont: "Inputs",   sub: "Color", pid: "MIXER:Current/InCh/Label/Color", type: "color", count: "inputs" },

	mixLevel: { cont: "Mixes",    sub: "Level", pid: "MIXER:Current/Mix/Fader/Level",  type: "level", count: "mixes" },
	mixOn:    { cont: "Mixes",    sub: "On",    pid: "MIXER:Current/Mix/Fader/On",     type: "on",    count: "mixes" },
	mixName:  { cont: "Mixes",    sub: "Name",  pid: "MIXER:Current/Mix/Label/Name",   type: "name",  count: "mixes" },
	mixColor: { cont: "Mixes",    sub: "Color", pid: "MIXER:Current/Mix/Label/Color",  type: "color", count: "mixes" },

	mtxLevel: { cont: "Matrices", sub: "Level", pid: "MIXER:Current/Mtrx/Fader/Level", type: "level", count: "matrices" },
	mtxOn:    { cont: "Matrices", sub: "On",    pid: "MIXER:Current/Mtrx/Fader/On",    type: "on",    count: "matrices" },
	mtxName:  { cont: "Matrices", sub: "Name",  pid: "MIXER:Current/Mtrx/Label/Name",  type: "name",  count: "matrices" },
	mtxColor: { cont: "Matrices", sub: "Color", pid: "MIXER:Current/Mtrx/Label/Color", type: "color", count: "matrices" },

	stLevel:  { cont: "Stereo",   sub: "Level", pid: "MIXER:Current/St/Fader/Level",   type: "level", count: "stereo" },
	stOn:     { cont: "Stereo",   sub: "On",    pid: "MIXER:Current/St/Fader/On",      type: "on",    count: "stereo" },
	stName:   { cont: "Stereo",   sub: "Name",  pid: "MIXER:Current/St/Label/Name",    type: "name",  count: "stereo" },

	dcaLevel: { cont: "DCAs",     sub: "Level", pid: "MIXER:Current/DCA/Fader/Level",  type: "level", count: "dca" },
	dcaOn:    { cont: "DCAs",     sub: "On",    pid: "MIXER:Current/DCA/Fader/On",     type: "on",    count: "dca" },
	dcaName:  { cont: "DCAs",     sub: "Name",  pid: "MIXER:Current/DCA/Label/Name",   type: "name",  count: "dca" },
	dcaColor: { cont: "DCAs",     sub: "Color", pid: "MIXER:Current/DCA/Label/Color",  type: "color", count: "dca" },

	muteOn:   { cont: "Mute Groups", sub: "Muted", pid: "MIXER:Current/MuteGrpCtrl/On",         type: "on",   count: "mute" },
	muteName: { cont: "Mute Groups", sub: "Name",  pid: "MIXER:Current/MuteGrpCtrl/Label/Name", type: "name", count: "mute" }
};

// Chataigne's JS engine (JUCE) has no for..in, so keys are listed explicitly.
var SPEC_KEYS = [
	"inLevel", "inOn", "inPan", "inName", "inColor",
	"mixLevel", "mixOn", "mixName", "mixColor",
	"mtxLevel", "mtxOn", "mtxName", "mtxColor",
	"stLevel", "stOn", "stName",
	"dcaLevel", "dcaOn", "dcaName", "dcaColor",
	"muteOn", "muteName"
];
var CONT_NAMES = ["Inputs", "Mixes", "Matrices", "Stereo", "DCAs", "Mute Groups"];

// runtime lookups (rebuilt by generateValues)
var valueRefs = {};   // key -> { index -> parameter }
var descByAddr = {};  // value control address -> { key, x }
var pidToKey = {};    // ParamID string -> key   (for feedback parsing)
var sceneRefs = {};   // list token ("scene_a"/"scene_b") -> { number, name }
var isUpdatingFromOSC = false;

// paced queue: get/subscribe/unsubscribe requests are spread across update()
// ticks (see #1) instead of blasting ~770 UDP packets in one synchronous burst.
var getQueue = [];        // pending paramId+indices strings
var getQueueLen = 0;      // entries filled
var getQueuePos = 0;      // next entry to send
var getQueueMode = "get"; // "get" | "subscribe" | "unsubscribe": how to flush entries

// keepalive: wall-clock (seconds) of the next /yosc:req/keepalive to send. Firmware
// drops idle sessions (scpmode keepalive window); pinging keeps NOTIFY/push alive.
var nextKeepalive = 0;

// whether we currently hold a subscription, so syncSubscription() only sends the
// unsubscribe sweep when there's actually something to tear down (not at startup).
var subscriptionActive = false;

// ---- lifecycle -------------------------------------------------------------

function init() {
	refreshCounts();
	buildPidIndex();
	generateValues();
	syncSubscription(); // subscribe now if push feedback + value tree are both on
	refreshUpdateRate();
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
		syncSubscription();
	} else if (param.name == "generateFeedbackValues") {
		generateValues();
		syncSubscription();
	} else if (param.name == "useSubscribe") {
		syncSubscription();
	} else if (param.name == "scenePollSeconds" || param.name == "keepaliveSeconds") {
		refreshUpdateRate();
	}
}

// Subscribe (push feedback) is a persistent request the desk honours until we
// unsubscribe. Bring it in line with the current toggles: subscribe the whole
// feedback tree when both "Use Subscribe" and "Generate Feedback Values" are on,
// otherwise unsubscribe. (Unsubscribing when never subscribed is a harmless no-op.)
function syncSubscription() {
	if (local.parameters.useSubscribe.get() && local.parameters.generateFeedbackValues.get()) {
		queueAllParams("subscribe");
		subscriptionActive = true;
	} else if (subscriptionActive) {
		queueAllParams("unsubscribe");
		subscriptionActive = false;
	}
}

// ---- value tree (two-way feedback) -----------------------------------------

function generateValues() {
	// wipe previous tree
	for (var c = 0; c < CONT_NAMES.length; c++) {
		local.values.removeContainer(CONT_NAMES[c]);
	}
	local.values.removeContainer("Scene");
	valueRefs = {};
	descByAddr = {};
	sceneRefs = {};
	// pre-init per-key ref maps (avoids chained-bracket assignment later)
	for (var kp = 0; kp < SPEC_KEYS.length; kp++) valueRefs[SPEC_KEYS[kp]] = {};

	// Scene holder is independent of the strip tree, so scene query/polling works
	// even in send-only mode (Generate Feedback Values off).
	buildSceneValues();

	if (!local.parameters.generateFeedbackValues.get()) return;

	// Channel-first tree: <Container> / <index> / <Level|On|Pan|Name>
	for (var c2 = 0; c2 < CONT_NAMES.length; c2++) {
		var contName = CONT_NAMES[c2];

		// all keys of a container share one channel count; find it
		var count = 0;
		for (var kc = 0; kc < SPEC_KEYS.length; kc++) {
			if (SPEC[SPEC_KEYS[kc]].cont == contName) { count = COUNTS[SPEC[SPEC_KEYS[kc]].count]; break; }
		}
		if (count == 0) continue;

		var cont = local.values.addContainer(contName);
		cont.setCollapsed(true);
		for (var i = 1; i <= count; i++) {
			var chC = cont.addContainer("" + i);
			chC.setCollapsed(true);
			for (var k = 0; k < SPEC_KEYS.length; k++) {
				var key = SPEC_KEYS[k];
				var s = SPEC[key];
				if (s.cont != contName) continue;
				var p = addValueParam(chC, s.sub, s.type);
				var refs = valueRefs[key];
				refs["" + i] = p;
				descByAddr[p.getControlAddress()] = { key: key, x: i };
			}
		}
	}
}

// Scene state holders: Scene / <A|B> / Number, Name. Read-only; updated from the
// (undocumented) sscurrentt_ex reply in oscEvent.
function buildSceneValues() {
	var sc = local.values.addContainer("Scene");
	sc.setCollapsed(true);
	var lists = ["scene_a", "scene_b"];
	var labels = ["A", "B"];
	for (var i = 0; i < 2; i++) {
		var g = sc.addContainer(labels[i]);
		var num = g.addStringParameter("Number", "current scene number (x.xx)", "");
		num.setAttribute("readonly", true);
		var nm = g.addStringParameter("Name", "current scene name", "");
		nm.setAttribute("readonly", true);
		sceneRefs[lists[i]] = { number: num, name: nm };
	}
}

function addValueParam(container, name, type) {
	if (type == "level") return container.addFloatParameter(name, "dB", 0, MIN_DB, 10);
	if (type == "pan")   return container.addIntParameter(name, "L63..R63", 0, -63, 63);
	if (type == "on")    return container.addBoolParameter(name, "", false);
	if (type == "color") return container.addStringParameter(name, "Blue/Orange/Yellow/Purple/Cyan/Magenta/Red/Green/LtGreen/White/Off", "Blue");
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
	if (type == "name")  return clampName(v);
	return v; // color (string)
}

// Channel/label names are capped at 8 chars by the spec. Truncate (ES3-safe:
// no String.slice/substring) so an over-length name still sets its first 8.
function clampName(name) {
	var s = "" + name;
	if (s.length <= 8) return s;
	var out = "";
	for (var i = 0; i < 8; i++) out += s.charAt(i);
	return out;
}

function decode(type, raw) {
	if (type == "level") return rawToDb(parseInt(raw));
	if (type == "on") {
		if (raw === true) return true;   // OSC bool true
		if (raw === false) return false; // OSC bool false (parseInt(false) is NaN)
		return parseInt(raw) != 0;       // numeric 0/1
	}
	if (type == "pan")   return parseInt(raw);
	return "" + raw; // name / color
}

// ---- OSC send helpers ------------------------------------------------------

// /yosc:req/set/<paramIdWithIndices>  <value>
function sendSet(paramIdWithIndices, value) {
	local.send(REQ + "/set/" + paramIdWithIndices, value);
}

// /yosc:req/get/<paramIdWithIndices>  (no value) — asks the console to report
// the current value once. Reply arrives as /yosc:ok/get/...; oscEvent() handles it.
function sendGet(paramIdWithIndices) {
	local.send(REQ + "/get/" + paramIdWithIndices);
}

// /yosc:req/subscribe/<paramIdWithIndices> — ask the desk to PUSH future changes
// (as /yosc:notify/set/... or /yosc:okm/set/...). Firmware-confirmed OSC verb, but
// whether MIXER:Current addresses are subscribable is unverified — experimental.
function sendSubscribe(paramIdWithIndices) {
	local.send(REQ + "/subscribe/" + paramIdWithIndices);
}

function sendUnsubscribe(paramIdWithIndices) {
	local.send(REQ + "/unsubscribe/" + paramIdWithIndices);
}

// /yosc:req/keepalive — heartbeat so the desk doesn't drop an idle session (which
// would kill push feedback). Reply is /yosc:ok/keepalive (swallowed in oscEvent).
function sendKeepalive() {
	local.send(REQ + "/keepalive");
}

// ---- command callbacks (Input Channel) -------------------------------------

function inFaderLevel(ch, db)      { sendSet("MIXER:Current/InCh/Fader/Level/" + ch, dbToRaw(db)); }
function inFaderOn(ch, on)         { sendSet("MIXER:Current/InCh/Fader/On/" + ch, on ? 1 : 0); }
function inPan(ch, pan)            { sendSet("MIXER:Current/InCh/ToSt/Pan/" + ch, Math.round(pan)); }
function inName(ch, name)          { sendSet("MIXER:Current/InCh/Label/Name/" + ch, clampName(name)); }
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
function mixName(mix, name)          { sendSet("MIXER:Current/Mix/Label/Name/" + mix, clampName(name)); }
function mixColor(mix, color)        { sendSet("MIXER:Current/Mix/Label/Color/" + mix, color); }
function mixToMtrxLevel(mix, mtx, db){ sendSet("MIXER:Current/Mix/ToMtrx/Level/" + mix + "/" + mtx, dbToRaw(db)); }
function mixToMtrxOn(mix, mtx, on)   { sendSet("MIXER:Current/Mix/ToMtrx/On/" + mix + "/" + mtx, on ? 1 : 0); }

// ---- command callbacks (Matrix Channel) ------------------------------------

function mtrxFaderLevel(mtx, db) { sendSet("MIXER:Current/Mtrx/Fader/Level/" + mtx, dbToRaw(db)); }
function mtrxFaderOn(mtx, on)    { sendSet("MIXER:Current/Mtrx/Fader/On/" + mtx, on ? 1 : 0); }
function mtrxName(mtx, name)     { sendSet("MIXER:Current/Mtrx/Label/Name/" + mtx, clampName(name)); }
function mtrxColor(mtx, color)   { sendSet("MIXER:Current/Mtrx/Label/Color/" + mtx, color); }

// ---- command callbacks (Stereo Channel) ------------------------------------

function stFaderLevel(st, db) { sendSet("MIXER:Current/St/Fader/Level/" + st, dbToRaw(db)); }
function stFaderOn(st, on)    { sendSet("MIXER:Current/St/Fader/On/" + st, on ? 1 : 0); }
function stName(st, name)     { sendSet("MIXER:Current/St/Label/Name/" + st, clampName(name)); }

// ---- command callbacks (DCA Group) -----------------------------------------

function dcaFaderLevel(dca, db) { sendSet("MIXER:Current/DCA/Fader/Level/" + dca, dbToRaw(db)); }
function dcaFaderOn(dca, on)    { sendSet("MIXER:Current/DCA/Fader/On/" + dca, on ? 1 : 0); }
function dcaName(dca, name)     { sendSet("MIXER:Current/DCA/Label/Name/" + dca, clampName(name)); }
function dcaColor(dca, color)   { sendSet("MIXER:Current/DCA/Label/Color/" + dca, color); }

// ---- command callbacks (Mute Group) ----------------------------------------

function muteGroupOn(mg, muted) { sendSet("MIXER:Current/MuteGrpCtrl/On/" + mg, muted ? 1 : 0); }
function muteGroupName(mg, name){ sendSet("MIXER:Current/MuteGrpCtrl/Label/Name/" + mg, clampName(name)); }

// ---- command callbacks (Scene) ---------------------------------------------

function recallScene(list, number) {
	// number must be sent as "x.xx"
	local.send(REQ + "/ssrecallt_ex", list, number.toFixed(2));
}
function sceneInc(list) { local.send(REQ + "/event", "MIXER:Lib/Scene/RecallInc", list); }
function sceneDec(list) { local.send(REQ + "/event", "MIXER:Lib/Scene/RecallDec", list); }

// Ask the console for the current scene NUMBER of a list. The reply
// (/yosc:...sscurrentt_ex..., handled in handleSceneReply) then triggers a
// ssinfot_ex to fetch the name. Arg encoding is best-effort (watch "Log Unhandled
// Incoming").
function queryScene(list) { local.send(REQ + "/sscurrentt_ex", list); }

// Ask for a scene's NAME/comment (firmware: SSINFOT_EX). number is the "x.xx" string.
function querySceneInfo(list, number) { local.send(REQ + "/ssinfot_ex", list, number); }

// update() is driven fast while draining a paced queue; otherwise it ticks fast
// enough to service the scene poll and/or keepalive on their own intervals (both
// are gated on util.getTime(), so the exact tick rate only bounds their jitter).
// Chataigne stops periodic updates at rate 0; every update() path is additionally
// guarded, so a nonzero interpretation of 0 would still be a cheap no-op (#3).
function refreshUpdateRate() {
	if (getQueuePos < getQueueLen) { script.setUpdateRate(REFRESH_RATE); return; }
	var scenePoll = local.parameters.scenePollSeconds.get();
	var keepalive = local.parameters.keepaliveSeconds.get();
	// need periodic ticks if either timed task is active; 2 Hz keeps their jitter
	// well under a second without busy-spinning.
	script.setUpdateRate((scenePoll > 0 || keepalive > 0) ? 2 : 0);
}

function update(deltaTime) {
	if (drainRefreshQueue()) return; // busy draining; skip timed tasks this tick

	var now = util.getTime();

	var keepalive = local.parameters.keepaliveSeconds.get();
	if (keepalive > 0 && now >= nextKeepalive) {
		sendKeepalive();
		nextKeepalive = now + keepalive;
	}

	if (local.parameters.scenePollSeconds.get() > 0) {
		queryScene("scene_a");
		queryScene("scene_b");
	}
}

// Send up to GET_BATCH queued entries via the current queue mode (get / subscribe /
// unsubscribe). Returns true while the queue is draining.
function drainRefreshQueue() {
	if (getQueuePos >= getQueueLen) return false;
	var end = getQueuePos + GET_BATCH;
	if (end > getQueueLen) end = getQueueLen;
	for (; getQueuePos < end; getQueuePos++) flushQueueEntry(getQueue[getQueuePos]);
	if (getQueuePos >= getQueueLen) {
		getQueue = [];
		getQueueLen = 0;
		getQueuePos = 0;
		refreshUpdateRate(); // restore scene-poll/keepalive (or idle) rate
		script.log("DM7 OSC: " + getQueueMode + " complete.");
	}
	return true;
}

function flushQueueEntry(entry) {
	if (getQueueMode == "subscribe") sendSubscribe(entry);
	else if (getQueueMode == "unsubscribe") sendUnsubscribe(entry);
	else sendGet(entry);
}

// Queue one entry per (feedback param, channel) for the given mode, then switch
// update() to fast-drain. Shared by refreshAllValues() and syncSubscription().
function queueAllParams(mode) {
	getQueueMode = mode;
	getQueue = [];
	getQueueLen = 0;
	getQueuePos = 0;
	for (var k = 0; k < SPEC_KEYS.length; k++) {
		var s = SPEC[SPEC_KEYS[k]];
		var n = COUNTS[s.count];
		for (var i = 1; i <= n; i++) getQueue[getQueueLen++] = s.pid + "/" + i;
	}
	refreshUpdateRate(); // switch update() to fast drain
}

// ---- command callbacks (Query / refresh) -----------------------------------

// Fire a get for every parameter in the feedback value tree so the console
// reports its current state. This is a burst of messages (one per channel per
// value type); replies land in oscEvent() once the reply format is confirmed.
function refreshAllValues() {
	if (!local.parameters.generateFeedbackValues.get()) {
		script.log("Refresh: turn on 'Generate Feedback Values' first (nothing to populate).");
		return;
	}
	// Snapshot pull: queue a get per value; update()/drainRefreshQueue() paces them
	// out (#1). Independent of subscribe (which pushes *future* changes).
	queueAllParams("get");
	script.log("DM7 OSC: queued " + getQueueLen + " state queries (~" + (GET_BATCH * REFRESH_RATE) + "/s). Enable 'Log Unhandled Incoming' if nothing updates.");
}

// ---- command callbacks (Advanced) ------------------------------------------

function sendRawSet(paramIdWithIndices, value) {
	var v = value;
	if (value !== "" && !isNaN(value)) v = parseFloat(value); // numeric string -> number
	sendSet(paramIdWithIndices, v);
}

function sendRawGet(paramIdWithIndices) {
	sendGet(paramIdWithIndices);
}

// Escape hatches for the (firmware-confirmed but hardware-unverified) push verbs.
// Handy for trying the ts:-prefixed object addresses seen in firmware by hand.
function sendRawSubscribe(paramIdWithIndices) {
	sendSubscribe(paramIdWithIndices);
}

function sendRawUnsubscribe(paramIdWithIndices) {
	sendUnsubscribe(paramIdWithIndices);
}

// ---- incoming OSC (experimental feedback) ----------------------------------

function oscEvent(address, args) {
	// Keepalive heartbeat reply — swallow.
	if (startsWith(address, "/yosc:ok/keepalive")) return;

	// Error reply — surface it (if logging is on) and stop.
	if (startsWith(address, "/yosc:error")) { logUnhandled(address, args); return; }

	// Scene replies (sscurrentt_ex number / ssinfot_ex name) — verb is in the address.
	if (handleSceneReply(address, args)) return;

	// Firmware-confirmed value channels: a get reply and two push forms. The tail
	// after the prefix is "<ParamID>/<X>[/<Y>]".
	var rem = afterPrefix(address, "/yosc:ok/get/");
	if (rem === null) rem = afterPrefix(address, "/yosc:notify/set/");
	if (rem === null) rem = afterPrefix(address, "/yosc:okm/set/");
	if (rem !== null) {
		if (applyParamUpdate(rem, args)) return;
		logUnhandled(address, args);
		return;
	}

	// Last-resort fallback (pre-firmware guess): scan the whole address for a
	// MIXER:Current token, in case a real desk replies differently than the
	// firmware format strings suggest. Confirm/prune via "Log Unhandled Incoming".
	if (applyMixerCurrentScan(address, args)) return;
	logUnhandled(address, args);
}

// rem = "<ParamID>/<X>[/<Y>]" (ParamID itself contains slashes). Split off the
// trailing numeric index token(s), look up the value control by ParamID, set it.
// Returns true if a matching value was updated.
function applyParamUpdate(rem, args) {
	var tokens = rem.split("/");
	var end = tokens.length - 1;
	while (end >= 0 && isIntToken(tokens[end])) end--; // tokens[0..end] = ParamID
	if (end < 0) return false;                          // no ParamID tokens
	if (end + 1 >= tokens.length) return false;         // no index token
	var pid = "";
	for (var j = 0; j <= end; j++) pid += (j > 0 ? "/" : "") + tokens[j];
	return setValueByPid(pid, tokens[end + 1], args, tokens);
}

// Fallback for a raw echoed address: find "MIXER:Current" and take the trailing
// numeric token(s) as X (/Y). (Avoid Array.slice/join/unshift - unsupported here.)
function applyMixerCurrentScan(address, args) {
	var tokens = address.split("/");
	var start = -1;
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i] == "MIXER:Current") { start = i; break; }
	}
	if (start < 0) return false;
	var end = tokens.length - 1;
	while (end > start && isIntToken(tokens[end])) end--;
	if (end + 1 >= tokens.length) return false;
	var pid = "";
	for (var j = start; j <= end; j++) pid += (j > start ? "/" : "") + tokens[j];
	return setValueByPid(pid, tokens[end + 1], args, tokens);
}

// Map a ParamID + X index to its generated value control and set it from the
// incoming value (args[0] if present, else the last address token). Returns false
// if the ParamID isn't one we track or the channel is out of range.
function setValueByPid(pid, xToken, args, tokens) {
	var key = pidToKey[pid];
	if (key === undefined) return false;
	var refs = valueRefs[key];
	var target = refs ? refs["" + parseInt(xToken)] : null;
	if (!target) return false;
	var raw = (args && args.length > 0) ? args[0] : tokens[tokens.length - 1];
	isUpdatingFromOSC = true;
	target.set(decode(SPEC[key].type, raw));
	isUpdatingFromOSC = false;
	return true;
}

// Scene replies. sscurrentt_ex returns the current NUMBER of a list; the NAME
// comes from a separate ssinfot_ex query (firmware: SSCURRENTT_EX vs SSINFOT_EX),
// so on a current-number reply we chain a ssinfot_ex to fill the name. Arg shapes
// are best-effort (list echoed first, then number, then name) - confirm on hardware.
function handleSceneReply(address, args) {
	var isCurrent = address.split("sscurrentt").length > 1;
	var isInfo = address.split("ssinfot").length > 1;
	if (!isCurrent && !isInfo) return false;
	if (!args || args.length == 0) { logUnhandled(address, args); return true; }
	var list = "" + args[0];
	var ref = sceneRefs[list];
	if (!ref) { logUnhandled(address, args); return true; }

	isUpdatingFromOSC = true;
	if (isInfo) {
		// ssinfot_ex: list, number, name[, comment]
		if (args.length > 1) ref.number.set("" + args[1]);
		if (args.length > 2) ref.name.set("" + args[2]);
		isUpdatingFromOSC = false;
	} else {
		// sscurrentt_ex: list, number -> record number, then pull the name.
		var number = (args.length > 1) ? ("" + args[1]) : "";
		if (number != "") ref.number.set(number);
		isUpdatingFromOSC = false;
		if (number != "") querySceneInfo(list, number);
	}
	return true;
}

// ES3-safe string helpers (Chataigne's JS engine lacks String.startsWith/substring).
function startsWith(s, pre) {
	if (s.length < pre.length) return false;
	for (var i = 0; i < pre.length; i++) {
		if (s.charAt(i) != pre.charAt(i)) return false;
	}
	return true;
}

// Return the part of `address` after `prefix`, or null if it doesn't start with it.
function afterPrefix(address, prefix) {
	if (!startsWith(address, prefix)) return null;
	var out = "";
	for (var i = prefix.length; i < address.length; i++) out += address.charAt(i);
	return out;
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
