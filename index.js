// Bubble Splitter — Visual Only
// Supports user and assistant messages with customizable color palettes.
// Never creates chat messages or modifies message payloads/history.

(() => {
    'use strict';

    const MODULE = 'bubble_splitter';

    const DEFAULTS = {
        enabled: true,
        minWords: 5,
        maxBubbles: 6,

        assistantBg: '#343944',
        assistantBorder: '#555D6B',
        assistantText: '#FFFFFF',

        userBg: '#244D70',
        userBorder: '#3979A8',
        userText: '#FFFFFF',
    };

    const ABBREVIATIONS = new Set([
        'mr', 'mrs', 'ms', 'dr', 'prof',
        'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e'
    ]);

    let busy = false;

    // --------------------------------------------------
    // Settings
    // --------------------------------------------------

    function getSettings() {
        const ctx = SillyTavern.getContext();

        if (!ctx.extensionSettings[MODULE]) {
            ctx.extensionSettings[MODULE] = {};
        }

        const settings = ctx.extensionSettings[MODULE];

        for (const [key, value] of Object.entries(DEFAULTS)) {
            if (!(key in settings)) {
                settings[key] = value;
            }
        }

        return settings;
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function validColor(value, fallback) {
        return /^#[0-9a-fA-F]{6}$/.test(value)
            ? value
            : fallback;
    }

    // Use CSS variables so changing the palette also recolors
    // bubbles that have already been rendered.
    function updatePalette() {
        const s = getSettings();

        let style = document.getElementById('bs-visual-palette');

        if (!style) {
            style = document.createElement('style');
            style.id = 'bs-visual-palette';
            document.head.appendChild(style);
        }

        style.textContent = `
            #chat .mes .bs-visual-bubble {
                box-sizing: border-box;
                display: block;
                width: fit-content;
                max-width: 100%;
                margin: 0 0 0.55em 0;
                padding: 0.45em 0.7em;
                border-radius: 0.8em;
                white-space: pre-wrap;
                overflow-wrap: anywhere;
                box-shadow: none;
            }

            #chat .mes .bs-visual-bubble[data-bs-role="assistant"] {
                background-color: var(--bs-assistant-bg) !important;
                border: 1px solid var(--bs-assistant-border) !important;
                color: var(--bs-assistant-text) !important;
            }

            #chat .mes .bs-visual-bubble[data-bs-role="user"] {
                background-color: var(--bs-user-bg) !important;
                border: 1px solid var(--bs-user-border) !important;
                color: var(--bs-user-text) !important;
            }

            #chat {
                --bs-assistant-bg: ${validColor(s.assistantBg, DEFAULTS.assistantBg)};
                --bs-assistant-border: ${validColor(s.assistantBorder, DEFAULTS.assistantBorder)};
                --bs-assistant-text: ${validColor(s.assistantText, DEFAULTS.assistantText)};

                --bs-user-bg: ${validColor(s.userBg, DEFAULTS.userBg)};
                --bs-user-border: ${validColor(s.userBorder, DEFAULTS.userBorder)};
                --bs-user-text: ${validColor(s.userText, DEFAULTS.userText)};
            }
        `;
    }

    // --------------------------------------------------
    // Splitting
    // --------------------------------------------------

    function countWords(text) {
        const value = text.trim();
        return value ? value.split(/\s+/).length : 0;
    }

    function findToolPayload(text) {
        const patterns = [
            /\{\s*"tool_calls"\s*:/,
            /\{\s*"function"\s*:\s*\{\s*"name"\s*:/
        ];

        let earliest = -1;

        for (const pattern of patterns) {
            const match = pattern.exec(text);

            if (match && (earliest === -1 || match.index < earliest)) {
                earliest = match.index;
            }
        }

        return earliest;
    }

    function splitText(text) {
        const payloadStart = findToolPayload(text);

        // Do not split inside a detected tool-call payload.
        const splitLimit = payloadStart === -1
            ? text.length
            : payloadStart;

        const prefix = text.slice(0, splitLimit);
        const ranges = [];

        // Split at sentence endings OR line breaks.
        const boundary = /[.!?…]+["'”’)\]*_~]*(?=\s|$)|\n+/g;

        let last = 0;
        let match;

        while ((match = boundary.exec(prefix)) !== null) {
            const end = match.index + match[0].length;
            const before = prefix.slice(last, match.index);

            if (/^[.!?…]/.test(match[0])) {
                const word = before.match(/([A-Za-z.]+)$/);

                if (
                    match[0].startsWith('.') &&
                    word &&
                    ABBREVIATIONS.has(word[1].toLowerCase())
                ) {
                    continue;
                }
            }

            if (prefix.slice(last, end).trim()) {
                ranges.push({ start: last, end });
            }

            last = end;
        }

        if (last < text.length && text.slice(last).trim()) {
            ranges.push({ start: last, end: text.length });
        }

        return ranges;
    }

    function locateOffset(nodes, offset, totalLength) {
        offset = Math.max(0, Math.min(offset, totalLength));

        let consumed = 0;

        for (const node of nodes) {
            const length = node.nodeValue.length;

            if (offset <= consumed + length) {
                return {
                    node,
                    offset: offset - consumed
                };
            }

            consumed += length;
        }

        const last = nodes[nodes.length - 1];

        return last
            ? { node: last, offset: last.nodeValue.length }
            : null;
    }

    function createBubble(content, role) {
        const bubble = document.createElement('div');

        bubble.className = 'bs-visual-bubble';
        bubble.dataset.bsRole = role;

        bubble.appendChild(content);

        return bubble;
    }

    function splitRenderedElement(element, role, settings) {
        if (!element || !element.isConnected) return;

        if (element.dataset.bsVisualSplit === 'true') return;

        // Avoid rewriting code editors and code blocks.
        if (element.querySelector('pre, code, .code-block')) return;

        const originalText = element.textContent || '';

        if (countWords(originalText) <= Number(settings.minWords)) {
            return;
        }

        const ranges = splitText(originalText);

        if (ranges.length < 2) return;

        const max = Math.max(
            2,
            Math.min(30, Number(settings.maxBubbles) || DEFAULTS.maxBubbles)
        );

        if (ranges.length > max) {
            const reduced = ranges.slice(0, max - 1);

            reduced.push({
                start: ranges[max - 1].start,
                end: ranges[ranges.length - 1].end
            });

            ranges.length = 0;
            ranges.push(...reduced);
        }

        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    return node.nodeValue.length
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_REJECT;
                }
            }
        );

        const nodes = [];

        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }

        if (!nodes.length) return;

        const totalLength = nodes.reduce(
            (sum, node) => sum + node.nodeValue.length,
            0
        );

        // If DOM text offsets don't match, leave the message untouched.
        if (totalLength !== originalText.length) return;

        const fragment = document.createDocumentFragment();

        for (const part of ranges) {
            const start = locateOffset(nodes, part.start, totalLength);
            const end = locateOffset(nodes, part.end, totalLength);

            if (!start || !end || part.end <= part.start) continue;

            const range = document.createRange();

            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);

            const content = range.cloneContents();

            if (!(content.textContent || '').trim()) continue;

            fragment.appendChild(createBubble(content, role));
        }

        if (!fragment.childNodes.length) return;

        // DOM-only transformation. No chat object or payload is modified.
        element.replaceChildren(fragment);
        element.dataset.bsVisualSplit = 'true';
    }

    // --------------------------------------------------
    // Message rendering
    // --------------------------------------------------

    function getMessage(index) {
        const ctx = SillyTavern.getContext();
        const message = ctx.chat[index];

        if (!message) return null;

        const messageElement =
            document.querySelector(`#chat .mes[mesid="${index}"]`) ||
            document.querySelector(`#chat .mes[data-mesid="${index}"]`);

        if (!messageElement) return null;

        const textElement = messageElement.querySelector('.mes_text');

        if (!textElement) return null;

        return { message, messageElement, textElement };
    }

    function onRendered(id) {
        if (busy) return;

        const settings = getSettings();

        if (!settings.enabled) return;

        const ctx = SillyTavern.getContext();
        const index = Number(id);

        if (!Number.isInteger(index) || index < 0) return;
        if (index >= ctx.chat.length) return;

        const found = getMessage(index);

        if (!found) return;

        const { message, messageElement, textElement } = found;

        if (message.is_system) return;

        if (textElement.dataset.bsVisualSplit === 'true') return;

        const role = message.is_user ? 'user' : 'assistant';

        // Don't alter the message object. Only inspect its existing content.
        const originalText = message.mes ?? '';

        if (countWords(originalText) <= Number(settings.minWords)) {
            return;
        }

        busy = true;

        try {
            splitRenderedElement(textElement, role, settings);

            // Add role metadata to the containing message for styling/debugging.
            // This is a DOM attribute, not a chat-history change.
            if (textElement.dataset.bsVisualSplit === 'true') {
                messageElement.dataset.bsVisualRole = role;
            }
        } catch (error) {
            console.error('[Bubble Splitter] visual split failed:', error);
        } finally {
            busy = false;
        }
    }

    // --------------------------------------------------
    // Settings interface
    // --------------------------------------------------

    function addSettingsUI() {
        if ($('#bubble_splitter_settings').length) return;

        const settings = getSettings();

        const html = `
        <div id="bubble_splitter_settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Bubble Splitter — Visual Only</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>

            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="bs_enabled" type="checkbox">
                    <span>Enable bubble splitting</span>
                </label>

                <label>
                    Minimum words per message
                    <input id="bs_min_words"
                        class="text_pole"
                        type="number" min="1" max="500">
                </label>

                <label>
                    Maximum bubbles per message
                    <input id="bs_max_bubbles"
                        class="text_pole"
                        type="number" min="2" max="30">
                </label>

                <hr>

                <h4>Assistant bubble palette</h4>

                <label>
                    Background
                    <input id="bs_assistant_bg" type="color">
                </label>

                <label>
                    Border
                    <input id="bs_assistant_border" type="color">
                </label>

                <label>
                    Text
                    <input id="bs_assistant_text" type="color">
                </label>

                <hr>

                <h4>User bubble palette</h4>

                <label>
                    Background
                    <input id="bs_user_bg" type="color">
                </label>

                <label>
                    Border
                    <input id="bs_user_border" type="color">
                </label>

                <label>
                    Text
                    <input id="bs_user_text" type="color">
                </label>

                <hr>

                <button id="bs_reset_palette" class="menu_button">
                    Reset default colors
                </button>
            </div>
        </div>`;

        $('#extensions_settings2').append(html);

        $('#bs_enabled')
            .prop('checked', settings.enabled)
            .on('change', function () {
                settings.enabled = this.checked;
                saveSettings();
            });

        $('#bs_min_words')
            .val(settings.minWords)
            .on('change', function () {
                settings.minWords = Math.max(
                    1,
                    Math.min(500, Number(this.value) || DEFAULTS.minWords)
                );

                $(this).val(settings.minWords);
                saveSettings();
            });

        $('#bs_max_bubbles')
            .val(settings.maxBubbles)
            .on('change', function () {
                settings.maxBubbles = Math.max(
                    2,
                    Math.min(30, Number(this.value) || DEFAULTS.maxBubbles)
                );

                $(this).val(settings.maxBubbles);
                saveSettings();
            });

        const colorControls = {
            '#bs_assistant_bg': 'assistantBg',
            '#bs_assistant_border': 'assistantBorder',
            '#bs_assistant_text': 'assistantText',
            '#bs_user_bg': 'userBg',
            '#bs_user_border': 'userBorder',
            '#bs_user_text': 'userText',
        };

        for (const [selector, key] of Object.entries(colorControls)) {
            $(selector)
                .val(validColor(settings[key], DEFAULTS[key]))
                .on('input change', function () {
                    settings[key] = validColor(
                        this.value,
                        DEFAULTS[key]
                    );

                    updatePalette();
                    saveSettings();
                });
        }

        $('#bs_reset_palette').on('click', function () {
            for (const key of Object.keys(DEFAULTS)) {
                if (key.endsWith('Bg') ||
                    key.endsWith('Border') ||
                    key.endsWith('Text')) {
                    settings[key] = DEFAULTS[key];
                }
            }

            for (const [selector, key] of Object.entries(colorControls)) {
                $(selector).val(settings[key]);
            }

            updatePalette();
            saveSettings();
        });
    }

    // --------------------------------------------------
    // Initialize
    // --------------------------------------------------

    jQuery(() => {
        const { eventSource, eventTypes } = SillyTavern.getContext();

        addSettingsUI();
        updatePalette();

        // Assistant responses.
        if (eventTypes.CHARACTER_MESSAGE_RENDERED) {
            eventSource.on(
                eventTypes.CHARACTER_MESSAGE_RENDERED,
                onRendered
            );
        }

        // User messages.
        if (eventTypes.USER_MESSAGE_RENDERED) {
            eventSource.on(
                eventTypes.USER_MESSAGE_RENDERED,
                onRendered
            );
        }

        console.log(
            '[Bubble Splitter] Loaded: user + assistant bubbles, custom palette, visual-only mode.'
        );
    });
})();
