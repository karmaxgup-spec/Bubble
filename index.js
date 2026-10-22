// Bubble Splitter — visual-only version.
// The chat message, message count, swipes, and saved history are never modified.
// Only the rendered DOM inside the last assistant message is rearranged into visual bubbles.

(() => {
    'use strict';

    const MODULE = 'bubble_splitter';
    const DEFAULTS = { enabled: true, minWords: 10, maxBubbles: 6, balanceMarkup: true };
    const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e']);
    let busy = false;

    function getSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        const settings = extensionSettings[MODULE];
        for (const key of Object.keys(DEFAULTS)) {
            if (!(key in settings)) settings[key] = DEFAULTS[key];
        }
        return settings;
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function countWords(text) {
        const value = text.trim();
        return value ? value.split(/\s+/).length : 0;
    }

    function splitSentences(text) {
        const parts = [];
        const re = /[.!?…]+["'”’)\]*_~]*(?=\s|$)/g;
        let last = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
            if (match[0] === '.') {
                const before = text.slice(last, match.index);
                const word = before.match(/([A-Za-z.]+)$/);
                if (word && ABBREVIATIONS.has(word[1].toLowerCase())) continue;
            }
            const end = match.index + match[0].length;
            parts.push({ start: last, end });
            last = end;
        }
        if (last < text.length) parts.push({ start: last, end: text.length });
        return parts
            .map(part => ({ start: part.start, end: part.end }))
            .filter(part => text.slice(part.start, part.end).trim());
    }

    // Find the DOM text-node position corresponding to an offset in the rendered text.
    function locateOffset(nodes, offset, totalLength) {
        offset = Math.max(0, Math.min(offset, totalLength));
        let consumed = 0;
        for (const node of nodes) {
            const length = node.nodeValue.length;
            if (offset <= consumed + length) {
                return { node, offset: offset - consumed };
            }
            consumed += length;
        }
        const last = nodes[nodes.length - 1];
        return last ? { node: last, offset: last.nodeValue.length } : null;
    }

    function splitRenderedElement(element, settings) {
        if (!element || element.dataset.bsVisualSplit === 'true') return;
        if (element.querySelector('pre, code, .code-block')) return;

        const originalText = element.textContent || '';
        if (countWords(originalText) <= settings.minWords) return;

        let ranges = splitSentences(originalText);
        if (ranges.length < 2) return;

        const max = Math.max(2, Number(settings.maxBubbles) || DEFAULTS.maxBubbles);
        if (ranges.length > max) {
            const first = ranges.slice(0, max - 1);
            first.push({ start: ranges[max - 1].start, end: ranges[ranges.length - 1].end });
            ranges = first;
        }

        // Work on the already-rendered DOM so Markdown formatting, links, and emphasis
        // are retained as far as possible. No chat data or message payload is changed.
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        if (!nodes.length) return;

        const totalLength = nodes.reduce((sum, node) => sum + node.nodeValue.length, 0);
        // textContent and TreeWalker text can differ for special elements; avoid risky offsets.
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

            const bubble = document.createElement('div');
            bubble.className = 'bs-visual-bubble';
            bubble.style.display = 'block';
            bubble.style.width = 'fit-content';
            bubble.style.maxWidth = '100%';
            bubble.style.boxSizing = 'border-box';
            bubble.style.margin = '0 0 0.55em 0';
            bubble.style.padding = '0.45em 0.7em';
            bubble.style.borderRadius = '0.8em';
            bubble.style.background = 'var(--SmartThemeQuoteColor, rgba(127, 127, 127, 0.12))';
            bubble.style.border = '1px solid var(--SmartThemeBorderColor, rgba(127, 127, 127, 0.2))';
            bubble.appendChild(content);
            fragment.appendChild(bubble);
        }

        if (!fragment.childNodes.length) return;
        element.replaceChildren(fragment);
        element.dataset.bsVisualSplit = 'true';
    }

    async function onRendered(id, type) {
        if (busy) return;
        const settings = getSettings();
        if (!settings.enabled || type === 'first_message') return;

        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        const index = Number(id);
        if (!Number.isInteger(index) || index < 0 || index !== chat.length - 1) return;

        const message = chat[index];
        if (!message || message.is_user || message.is_system) return;

        // Read the original text only; never assign to message.mes, chat[], swipes, or saveChat().
        const text = message.mes ?? '';
        if (text.includes('```') || countWords(text) <= settings.minWords) return;

        const messageElement =
            document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`) ||
            document.querySelector(`#chat .mes[data-mesid="${index}"] .mes_text`);
        if (!messageElement || messageElement.dataset.bsVisualSplit === 'true') return;

        busy = true;
        try {
            splitRenderedElement(messageElement, settings);
        } catch (error) {
            console.error('[Bubble Splitter] visual split failed:', error);
        } finally {
            busy = false;
        }
    }

    function addSettingsUI() {
        const settings = getSettings();
        if ($('#bubble_splitter_settings').length) return;

        const html = `
        <div id="bubble_splitter_settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Bubble Splitter (Visual Only)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input id="bs_enabled" type="checkbox"><span>Enabled</span></label>
                <label>Only split replies longer than (words)
                    <input id="bs_min_words" class="text_pole" type="number" min="1" max="500"></label>
                <label>Max bubbles per reply
                    <input id="bs_max_bubbles" class="text_pole" type="number" min="2" max="30"></label>
            </div>
        </div>`;
        $('#extensions_settings2').append(html);

        $('#bs_enabled').prop('checked', settings.enabled).on('change', function () {
            settings.enabled = this.checked; saveSettings();
        });
        $('#bs_min_words').val(settings.minWords).on('input', function () {
            settings.minWords = Number(this.value) || DEFAULTS.minWords; saveSettings();
        });
        $('#bs_max_bubbles').val(settings.maxBubbles).on('input', function () {
            settings.maxBubbles = Number(this.value) || DEFAULTS.maxBubbles; saveSettings();
        });
    }

    jQuery(() => {
        const { eventSource, eventTypes } = SillyTavern.getContext();
        addSettingsUI();
        eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onRendered);
        console.log('[Bubble Splitter] loaded (visual-only; chat history is untouched)');
    });
})();
