import { watch } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER } from "@mariozechner/pi-tui";

const TMUX_PANE = process.env.TMUX_PANE;
const HOOK_ID = process.pid;
const STATE_DIR = join(tmpdir(), "pi-tmux-cursor-focus");
const STATE_FILE = TMUX_PANE
	? join(STATE_DIR, `pane-${TMUX_PANE.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${HOOK_ID}.state`)
	: undefined;
const TMUX_TIMEOUT_MS = 500;
const WRAP_GUARD_INTERVAL_MS = 1000;
const WRAPPED_EDITOR = Symbol("piTmuxFocusCursorWrapped");

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const REVERSE_VIDEO_CURSOR_RE = /\x1b\[[0-9;]*7m([\s\S]?)\x1b\[[0-9;]*(?:0|27)m/;

function cursorReplacement(highlightedChar, trailingText) {
	if (highlightedChar === " " && /^\s*$/.test(trailingText)) return "";
	return highlightedChar;
}

function replaceCursorMatch(text, match) {
	if (!match || match.index === undefined) return text;

	const beforeCursor = text.slice(0, match.index);
	const highlightedChar = match[1] ?? "";
	const trailingText = text.slice(match.index + match[0].length);
	return beforeCursor + cursorReplacement(highlightedChar, trailingText) + trailingText;
}

function stripFakeCursor(line) {
	const markerIndex = line.indexOf(CURSOR_MARKER);
	if (markerIndex === -1) return replaceCursorMatch(line, line.match(REVERSE_VIDEO_CURSOR_RE));

	const withoutMarker = line.replace(CURSOR_MARKER, "");
	const afterMarker = withoutMarker.slice(markerIndex);
	const match = afterMarker.match(REVERSE_VIDEO_CURSOR_RE);
	if (!match || match.index !== 0) return withoutMarker;

	const strippedAfterMarker = replaceCursorMatch(afterMarker, match);
	return withoutMarker.slice(0, markerIndex) + strippedAfterMarker;
}

class FocusAwareEditorWrapper {
	constructor(tui, inner) {
		this.tui = tui;
		this.inner = inner;
		this._uiFocused = true;
		this._tmuxFocused = true;
		this.syncInnerFocus();
	}

	_uiFocused;
	_tmuxFocused;
	tui;
	inner;
	actionHandlers = new Map();
	onEscape;
	onCtrlD;
	onPasteImage;
	onExtensionShortcut;

	get onSubmit() {
		return this.inner?.onSubmit;
	}

	set onSubmit(value) {
		if (this.inner) this.inner.onSubmit = value;
	}

	get onChange() {
		return this.inner?.onChange;
	}

	set onChange(value) {
		if (this.inner) this.inner.onChange = value;
	}

	get focused() {
		return this._uiFocused;
	}

	set focused(value) {
		this._uiFocused = value;
		this.syncInnerFocus();
	}

	get wantsKeyRelease() {
		return this.inner?.wantsKeyRelease ?? false;
	}

	get borderColor() {
		return this.inner?.borderColor;
	}

	set borderColor(value) {
		if (this.inner && "borderColor" in this.inner) {
			this.inner.borderColor = value;
		}
	}

	syncInnerFocus() {
		if (this.inner && "focused" in this.inner) {
			this.inner.focused = this._uiFocused && this._tmuxFocused;
		}
	}

	setTmuxFocus(focused) {
		if (this._tmuxFocused === focused) return;
		this._tmuxFocused = focused;
		this.syncInnerFocus();
		this.invalidate();
		this.tui.requestRender();
	}

	onAction(action, handler) {
		this.actionHandlers.set(action, handler);
		this.inner?.onAction?.(action, handler);
	}

	syncInnerCallbacks() {
		if (!this.inner) return;
		this.inner.onSubmit = this.onSubmit;
		this.inner.onChange = this.onChange;
		if ("onEscape" in this.inner) this.inner.onEscape = this.onEscape;
		if ("onCtrlD" in this.inner) this.inner.onCtrlD = this.onCtrlD;
		if ("onPasteImage" in this.inner) this.inner.onPasteImage = this.onPasteImage;
		if ("onExtensionShortcut" in this.inner) this.inner.onExtensionShortcut = this.onExtensionShortcut;
		if (this.inner.actionHandlers instanceof Map) {
			for (const [action, handler] of this.actionHandlers) {
				this.inner.actionHandlers.set(action, handler);
			}
		}
	}

	getText() {
		return this.inner?.getText?.() ?? "";
	}

	setText(text) {
		this.syncInnerCallbacks();
		this.inner?.setText?.(text);
	}

	getExpandedText() {
		return this.inner?.getExpandedText?.() ?? this.getText();
	}

	addToHistory(text) {
		this.inner?.addToHistory?.(text);
	}

	insertTextAtCursor(text) {
		this.inner?.insertTextAtCursor?.(text);
	}

	setAutocompleteProvider(provider) {
		this.inner?.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding) {
		this.inner?.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible) {
		this.inner?.setAutocompleteMaxVisible?.(maxVisible);
	}

	render(width) {
		if (!this.inner?.render) return [];
		const lines = this.inner.render(width);
		if (this._tmuxFocused) return lines;
		return lines.map(stripFakeCursor);
	}

	handleInput(data) {
		this.syncInnerCallbacks();
		this.inner?.handleInput?.(data);
	}

	invalidate() {
		this.inner?.invalidate?.();
	}
}

class FocusAwareDefaultEditor extends CustomEditor {
	constructor(tui, theme, keybindings) {
		super(tui, theme, keybindings);
		this._uiFocused = true;
		this._tmuxFocused = true;
	}

	_uiFocused;
	_tmuxFocused;

	get focused() {
		return this._uiFocused;
	}

	set focused(value) {
		this._uiFocused = value;
		this.syncFocus();
	}

	syncFocus() {
		super.focused = this._uiFocused && this._tmuxFocused;
	}

	setTmuxFocus(focused) {
		if (this._tmuxFocused === focused) return;
		this._tmuxFocused = focused;
		this.syncFocus();
		this.invalidate();
		this.tui.requestRender();
	}

	render(width) {
		const lines = super.render(width);
		if (this._tmuxFocused) return lines;
		return lines.map(stripFakeCursor);
	}
}

function ensureWrappedFactory(pi, ctx, state) {
	if (!ctx.hasUI || !TMUX_PANE) return;

	const currentFactory = ctx.ui.getEditorComponent();
	if (currentFactory?.[WRAPPED_EDITOR]) return;

	let wrappedFactory;
	if (currentFactory) {
		const previousFactory = currentFactory;
		wrappedFactory = (tui, _theme, _keybindings) => {
			const inner = previousFactory(tui, _theme, _keybindings);
			const wrapper = new FocusAwareEditorWrapper(tui, inner);
			state.currentWrapper = wrapper;
			wrapper.setTmuxFocus(state.isTmuxFocused);
			return wrapper;
		};
	} else {
		wrappedFactory = (tui, theme, keybindings) => {
			const wrapper = new FocusAwareDefaultEditor(tui, theme, keybindings);
			state.currentWrapper = wrapper;
			wrapper.setTmuxFocus(state.isTmuxFocused);
			return wrapper;
		};
	}

	wrappedFactory[WRAPPED_EDITOR] = true;
	ctx.ui.setEditorComponent(wrappedFactory);
}

async function runTmux(pi, args) {
	return pi.exec("tmux", args, { timeout: TMUX_TIMEOUT_MS });
}

async function readCurrentPaneFocus(pi) {
	if (!TMUX_PANE) return true;
	try {
		const result = await runTmux(pi, ["display-message", "-p", "-t", TMUX_PANE, "#{pane_active}"]);
		return result.stdout.trim() !== "0";
	} catch {
		return true;
	}
}

async function applyStateFromFile(state) {
	if (!STATE_FILE) return;
	try {
		const nextFocused = (await readFile(STATE_FILE, "utf8")).trim() !== "0";
		if (nextFocused === state.isTmuxFocused) return;
		state.isTmuxFocused = nextFocused;
		state.currentWrapper?.setTmuxFocus(nextFocused);
	} catch {
		// Ignore transient read errors while tmux updates the state file.
	}
}

function hookCommand(value) {
	return `run-shell -b \"printf %s ${value} > ${shellQuote(STATE_FILE)}\"`;
}

async function installHooks(pi, state) {
	if (!TMUX_PANE || !STATE_FILE || state.hooksInstalled) return;
	await mkdir(STATE_DIR, { recursive: true });
	state.isTmuxFocused = await readCurrentPaneFocus(pi);
	await writeFile(STATE_FILE, state.isTmuxFocused ? "1" : "0");
	await runTmux(pi, ["set-hook", "-p", "-t", TMUX_PANE, `pane-focus-in[${HOOK_ID}]`, hookCommand("1")]);
	await runTmux(pi, ["set-hook", "-p", "-t", TMUX_PANE, `pane-focus-out[${HOOK_ID}]`, hookCommand("0")]);
	state.hooksInstalled = true;
}

async function uninstallHooks(pi, state) {
	if (!TMUX_PANE || !state.hooksInstalled) return;
	await Promise.allSettled([
		runTmux(pi, ["set-hook", "-up", "-t", TMUX_PANE, `pane-focus-in[${HOOK_ID}]`]),
		runTmux(pi, ["set-hook", "-up", "-t", TMUX_PANE, `pane-focus-out[${HOOK_ID}]`]),
	]);
	state.hooksInstalled = false;
}

async function startWatching(state) {
	if (!STATE_FILE || state.stateWatcher) return;
	state.stateWatcher = watch(STATE_FILE, { persistent: false }, () => {
		void applyStateFromFile(state);
	});
	state.stateWatcher.on("error", () => {
		state.stateWatcher?.close();
		state.stateWatcher = undefined;
	});
}

async function stopWatching(state) {
	state.stateWatcher?.close();
	state.stateWatcher = undefined;
	if (!STATE_FILE) return;
	await rm(STATE_FILE, { force: true });
}

async function startMonitoring(pi, state) {
	if (!TMUX_PANE || !STATE_FILE) return;
	await installHooks(pi, state);
	await startWatching(state);
	await applyStateFromFile(state);
}

async function stopMonitoring(pi, state) {
	await uninstallHooks(pi, state);
	await stopWatching(state);
}

export default function (pi) {
	const state = {
		currentWrapper: undefined,
		isTmuxFocused: true,
		hooksInstalled: false,
		stateWatcher: undefined,
		wrapGuardTimer: undefined,
	};

	const ensureWrapped = (ctx) => ensureWrappedFactory(pi, ctx, state);

	const startWrapGuard = (ctx) => {
		if (!ctx.hasUI || !TMUX_PANE || state.wrapGuardTimer) return;
		state.wrapGuardTimer = setInterval(() => {
			ensureWrapped(ctx);
		}, WRAP_GUARD_INTERVAL_MS);
	};

	const stopWrapGuard = () => {
		if (state.wrapGuardTimer) {
			clearInterval(state.wrapGuardTimer);
			state.wrapGuardTimer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || !TMUX_PANE) return;
		ensureWrapped(ctx);
		startWrapGuard(ctx);
		await startMonitoring(pi, state);
	});

	pi.on("session_shutdown", async () => {
		state.currentWrapper = undefined;
		stopWrapGuard();
		await stopMonitoring(pi, state);
	});
}
