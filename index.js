
 // Bubble Splitter — Visual Only + Messenger Voice Notes
 // Supports VN tags anywhere in a message, including beginning/end.
 // Example: [VN]Hello![/VN]
 // Example: Hello there. [VN]Speak this part.[/VN] Goodbye.
 // Example: [VN]First note.[/VN] Text. [VN]Second note.[/VN]

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
        'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e'
    ]);

    let busy = false;
    let chatObserver = null;
    let observerScheduled = false;

    const pendingMessageIndexes = new Set();
    const activeVoiceNoteButtons = new WeakSet();

    function getSettings() {
        const ctx = SillyTavern.getContext();
        ctx.extensionSettings ??= {};
        ctx.extensionSettings[MODULE] ??= {};

        const settings = ctx.extensionSettings[MODULE];

        for (const [key, value] of Object.entries(DEFAULTS)) {
            if (!(key in settings)) settings[key] = value;
        }

        return settings;
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function validColor(value, fallback) {
        return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
            ? value : fallback;
    }

    function updatePalette() {
        const s = getSettings();
        let style = document.getElementById('bs-visual-palette');

        if (!style) {
            style = document.createElement('style');
            style.id = 'bs-visual-palette';
            document.head.appendChild(style);
        }

        style.textContent = `
            #chat {
                --bs-assistant-bg: ${validColor(s.assistantBg, DEFAULTS.assistantBg)};
                --bs-assistant-border: ${validColor(s.assistantBorder, DEFAULTS.assistantBorder)};
                --bs-assistant-text: ${validColor(s.assistantText, DEFAULTS.assistantText)};
                --bs-user-bg: ${validColor(s.userBg, DEFAULTS.userBg)};
                --bs-user-border: ${validColor(s.userBorder, DEFAULTS.userBorder)};
                --bs-user-text: ${validColor(s.userText, DEFAULTS.userText)};
            }

            #chat .mes .bs-visual-bubble {
                display: block;
                width: fit-content;
                max-width: 100%;
                box-sizing: border-box;
                margin: 0 0 .55em;
                padding: .45em .7em;
                border-radius: .8em;
                white-space: pre-wrap;
                overflow-wrap: anywhere;
            }

            #chat .mes .bs-visual-bubble[data-bs-role="assistant"] {
                background: var(--bs-assistant-bg) !important;
                border: 1px solid var(--bs-assistant-border) !important;
                color: var(--bs-assistant-text) !important;
            }

            #chat .mes .bs-visual-bubble[data-bs-role="user"] {
                background: var(--bs-user-bg) !important;
                border: 1px solid var(--bs-user-border) !important;
                color: var(--bs-user-text) !important;
            }

            #chat .bs-voice-note {
                display: flex;
                align-items: center;
                gap: 12px;
                width: min(310px, 100%);
                min-height: 64px;
                box-sizing: border-box;
                padding: 10px 13px;
                margin: 5px 0 9px;
                border-radius: 18px;
                background: #343944;
                color: #fff;
                border: 1px solid rgba(255,255,255,.12);
                font-family: inherit;
            }

            #chat .bs-voice-note[data-bs-role="user"] {
                background: #087fca;
            }

            #chat .bs-voice-note-play {
                flex: 0 0 40px;
                width: 40px;
                height: 40px;
                border: 0;
                border-radius: 50%;
                background: #fff;
                color: #087fca;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                font-size: 17px;
            }

            #chat .bs-voice-note-play:disabled {
                opacity: .65;
                cursor: wait;
            }

            #chat .bs-voice-note-main {
                min-width: 0;
                flex: 1;
            }

            #chat .bs-voice-note-title {
                font-size: 12px;
                margin-bottom: 5px;
            }

            #chat .bs-voice-note-wave {
                display: flex;
                align-items: center;
                gap: 3px;
                height: 20px;
                overflow: hidden;
            }

            #chat .bs-voice-note-wave i {
                display: block;
                width: 3px;
                min-width: 3px;
                border-radius: 3px;
                background: currentColor;
                opacity: .85;
            }

            #chat .bs-voice-note-status {
                font-size: 11px;
                opacity: .8;
                margin-top: 4px;
            }

            #chat .bs-voice-note[data-bs-playing="true"] .bs-voice-note-wave i {
                animation: bs-vn-wave .7s ease-in-out infinite alternate;
            }

            #chat .bs-voice-note[data-bs-playing="true"] .bs-voice-note-wave i:nth-child(2n) {
                animation-delay: .15s;
            }

            #chat .bs-voice-note[data-bs-playing="true"] .bs-voice-note-wave i:nth-child(3n) {
                animation-delay: .3s;
            }

            @keyframes bs-vn-wave {
                from { transform: scaleY(.45); }
                to { transform: scaleY(1); }
            }
        `;
    }

    function countWords(text) {
        const value = String(text || '').trim();
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
        const prefix = text.slice(0, payloadStart === -1 ? text.length : payloadStart);
        const ranges = [];
        const boundary = /[.!?…]+["'”’)\]*_~]*(?=\s|$)|\n+/g;

        let last = 0;
        let match;

        while ((match = boundary.exec(prefix)) !== null) {
            const end = match.index + match[0].length;
            const before = prefix.slice(last, match.index);
            const word = before.match(/([A-Za-z.]+)$/);

            if (
                match[0].startsWith('.') &&
                word &&
                ABBREVIATIONS.has(word[1].toLowerCase())
            ) {
                continue;
            }

            if (prefix.slice(last, end).trim()) ranges.push({ start: last, end });
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
                return { node, offset: offset - consumed };
            }
            consumed += length;
        }

        const last = nodes[nodes.length - 1];
        return last ? { node: last, offset: last.nodeValue.length } : null;
    }

    function createBubble(content, role) {
        const bubble = document.createElement('div');
        bubble.className = 'bs-visual-bubble';
        bubble.dataset.bsRole = role;
        bubble.appendChild(content);
        return bubble;
    }

    function unwrapVisualBubbles(element) {
        if (!element) return;

        for (const bubble of Array.from(
            element.querySelectorAll(':scope > .bs-visual-bubble')
        )) {
            while (bubble.firstChild) {
                element.insertBefore(bubble.firstChild, bubble);
            }
            bubble.remove();
        }

        delete element.dataset.bsVisualSplit;
        delete element.dataset.bsVisualText;
    }

    function isMessageBeingEdited(messageElement) {
        return Boolean(messageElement.querySelector(
            'textarea.mes_edit_textarea, .mes_edit_textarea, textarea.edit_textarea, .edit_textarea'
        ));
    }

    function wrapSingleBubble(element, role) {
        if (!element?.isConnected) return false;
        if (element.dataset.bsVisualSplit === 'true') return true;

        const content = document.createDocumentFragment();
        while (element.firstChild) content.appendChild(element.firstChild);

        element.appendChild(createBubble(content, role));
        element.dataset.bsVisualSplit = 'true';
        element.dataset.bsVisualText = element.textContent || '';
        return true;
    }

    function splitRenderedElement(element, role, settings) {
        if (!element?.isConnected) return false;
        if (element.dataset.bsVisualSplit === 'true') return true;

        const originalText = element.textContent || '';

        if (countWords(originalText) <= Number(settings.minWords)) return false;
        if (element.querySelector('pre, code, .code-block')) return false;

        let ranges = splitText(originalText);
        if (ranges.length < 2) return false;

        const max = Math.max(2, Math.min(
            30, Number(settings.maxBubbles) || DEFAULTS.maxBubbles
        ));

        if (ranges.length > max) {
            const reduced = ranges.slice(0, max - 1);
            reduced.push({
                start: ranges[max - 1].start,
                end: ranges[ranges.length - 1].end
            });
            ranges = reduced;
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
        while (walker.nextNode()) nodes.push(walker.currentNode);
        if (!nodes.length) return false;

        const totalLength = nodes.reduce(
            (sum, node) => sum + node.nodeValue.length, 0
        );

        if (totalLength !== originalText.length) return false;

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

        if (!fragment.childNodes.length) return false;

        element.replaceChildren(fragment);
        element.dataset.bsVisualSplit = 'true';
        element.dataset.bsVisualText = element.textContent || '';
        return true;
    }

    function getMessageElements(index) {
        const messageElement =
            document.querySelector(`#chat .mes[mesid="${index}"]`) ||
            document.querySelector(`#chat .mes[data-mesid="${index}"]`);

        if (!messageElement) return null;

        const textElement = messageElement.querySelector('.mes_text');
        return textElement ? { messageElement, textElement } : null;
    }

    // FIX: find every VN block anywhere in the message.
    // Returns the text between tags as separate voice-note segments.
    function extractVoiceNotes(messageText) {
        if (typeof messageText !== 'string') return [];

        const regex = /\[VN\]([\s\S]*?)\[\/VN\]/gi;
        const notes = [];
        let match;

        while ((match = regex.exec(messageText)) !== null) {
            const spokenText = match[1].trim();

            if (spokenText) {
                notes.push({
                    start: match.index,
                    end: regex.lastIndex,
                    text: spokenText
                });
            }
        }

        return notes;
    }

    async function playVoiceNote(text, button, card) {
        if (activeVoiceNoteButtons.has(button)) return;
        activeVoiceNoteButtons.add(button);

        const ctx = SillyTavern.getContext();
        const originalIcon = button.innerHTML;
        const status = card.querySelector('.bs-voice-note-status');

        const releaseButton = () => {
            button.disabled = false;
            button.innerHTML = originalIcon;
            activeVoiceNoteButtons.delete(button);
        };

        try {
            button.disabled = true;
            card.dataset.bsPlaying = 'true';
            if (status) status.textContent = 'Preparing voice…';

            if (ctx.extensionSettings?.tts?.enabled !== true) {
                throw new Error('SillyTavern TTS is disabled.');
            }

            if (typeof ctx.executeSlashCommandsWithOptions !== 'function') {
                throw new Error('Slash-command execution is unavailable in this SillyTavern version.');
            }

            // Pass the text as a quoted slash-command argument so punctuation
            // and spaces are less likely to be interpreted as command options.
            const escapedText = String(text)
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"')
                .replace(/\r?\n/g, ' ');

            const result = await ctx.executeSlashCommandsWithOptions(
                `/speak "${escapedText}"`,
                {
                    handleParserErrors: true,
                    handleExecutionErrors: true
                }
            );

            if (result?.isError) {
                throw new Error(result.error || 'The TTS command failed.');
            }

            if (status) status.textContent = 'Sent to configured TTS';

            // The /speak command hands audio to ST's TTS pipeline. Re-enable
            // the button after handoff so it can be pressed again for replay.
            setTimeout(() => {
                card.dataset.bsPlaying = 'false';
                releaseButton();
            }, 1200);

        } catch (error) {
            console.error('[Bubble Splitter] Voice-note playback failed:', error);
            card.dataset.bsPlaying = 'false';

            if (status) status.textContent = 'TTS failed — check TTS settings';

            if (typeof toastr !== 'undefined' && toastr.warning) {
                toastr.warning(
                    'Voice note could not play. Check that SillyTavern TTS is enabled and configured.'
                );
            }

            releaseButton();
        }
    }

    function createVoiceNoteCard(voiceText, role) {
        const card = document.createElement('div');
        card.className = 'bs-voice-note';
        card.dataset.bsPlaying = 'false';
        card.dataset.bsRole = role;

        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'bs-voice-note-play';
        play.title = 'Play voice note';
        play.setAttribute('aria-label', 'Play voice note');
        play.innerHTML = '<i class="fa-solid fa-play" aria-hidden="true"></i>';

        const main = document.createElement('div');
        main.className = 'bs-voice-note-main';

        const title = document.createElement('div');
        title.className = 'bs-voice-note-title';
        title.textContent = 'Voice message';

        const wave = document.createElement('div');
        wave.className = 'bs-voice-note-wave';

        const heights = [
            7,12,17,10,14,19,9,15,6,13,18,8,14,10,17,
            7,12,19,9,14,6,11,16,8,13,18,10,6,15,9
        ];

        for (const height of heights) {
            const bar = document.createElement('i');
            bar.style.height = `${height}px`;
            wave.appendChild(bar);
        }

        const status = document.createElement('div');
        status.className = 'bs-voice-note-status';
        status.textContent = 'Tap to play';

        main.append(title, wave, status);
        card.append(play, main);

        play.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            playVoiceNote(voiceText, play, card);
        });

        return card;
    }

    // Render all VN blocks while preserving all surrounding ordinary text.
    function renderMessageWithVoiceNotes(
        textElement, message, role, notes, options = {}
    ) {
        const raw = String(message.mes || '');

        if (
            textElement.dataset.bsVoiceNoteSource === raw &&
            textElement.dataset.bsVoiceNote === 'true' &&
            !options.force
        ) {
            return false;
        }

        const fragment = document.createDocumentFragment();
        let cursor = 0;

        for (const note of notes) {
            if (note.start > cursor) {
                const ordinaryText = raw.slice(cursor, note.start);

                if (ordinaryText) {
                    const ordinary = document.createTextNode(ordinaryText);
                    fragment.appendChild(createBubble(ordinary, role));
                }
            }

            fragment.appendChild(createVoiceNoteCard(note.text, role));
            cursor = note.end;
        }

        if (cursor < raw.length) {
            const trailingText = raw.slice(cursor);
            if (trailingText) {
                fragment.appendChild(
                    createBubble(document.createTextNode(trailingText), role)
                );
            }
        }

        textElement.replaceChildren(fragment);
        textElement.dataset.bsVoiceNote = 'true';
        textElement.dataset.bsVoiceNoteSource = raw;
        textElement.dataset.bsVisualSplit = 'true';
        textElement.dataset.bsVisualText = textElement.textContent || '';

        return true;
    }

    function renderOne(index, options = {}) {
        const settings = getSettings();
        if (!settings.enabled && !options.force) return false;

        const ctx = SillyTavern.getContext();
        const message = ctx.chat?.[index];

        if (!message || message.is_system) return false;

        const found = getMessageElements(index);
        if (!found) return false;

        const { messageElement, textElement } = found;
        if (isMessageBeingEdited(messageElement)) return false;

        const role = message.is_user ? 'user' : 'assistant';
        const raw = String(message.mes || '');
        const voiceNotes = extractVoiceNotes(raw);

        if (voiceNotes.length) {
            return renderMessageWithVoiceNotes(
                textElement, message, role, voiceNotes, options
            );
        }

        // If VN tags were removed during editing, restore the current message
        // as text before applying normal visual bubbles.
        if (textElement.dataset.bsVoiceNote === 'true') {
            delete textElement.dataset.bsVoiceNote;
            delete textElement.dataset.bsVoiceNoteSource;
            delete textElement.dataset.bsVisualSplit;
            delete textElement.dataset.bsVisualText;
            textElement.textContent = raw;
        }

        const alreadyRendered = textElement.dataset.bsVisualSplit === 'true';

        if (
            alreadyRendered &&
            !options.force &&
            textElement.dataset.bsVisualText === (textElement.textContent || '')
        ) {
            return false;
        }

        if (alreadyRendered) unwrapVisualBubbles(textElement);

        let rendered = false;

        try {
            rendered = splitRenderedElement(textElement, role, settings);

            if (!rendered) {
                rendered = wrapSingleBubble(textElement, role);
            }

            if (rendered) messageElement.dataset.bsVisualRole = role;
            return rendered;

        } catch (error) {
            console.error('[Bubble Splitter] Failed to render message', index, error);

            try {
                rendered = wrapSingleBubble(textElement, role);
                if (rendered) messageElement.dataset.bsVisualRole = role;
            } catch (fallbackError) {
                console.error('[Bubble Splitter] Fallback failed', fallbackError);
            }

            return rendered;
        }
    }

    function onRendered(id) {
        if (busy) return;

        const ctx = SillyTavern.getContext();
        const index = Number(id);

        if (!Number.isInteger(index) || index < 0 || index >= ctx.chat.length) {
            return;
        }

        busy = true;
        try {
            renderOne(index);
        } finally {
            busy = false;
        }
    }

    function renderAllMessages() {
        if (busy) return;

        const settings = getSettings();

        if (!settings.enabled) {
            if (typeof toastr !== 'undefined' && toastr.warning) {
                toastr.warning('Enable Bubble Splitter first.');
            }
            return;
        }

        const ctx = SillyTavern.getContext();
        const count = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
        let rendered = 0;

        busy = true;
        try {
            for (let index = 0; index < count; index++) {
                if (renderOne(index, { force: true })) rendered++;
            }
        } finally {
            busy = false;
        }

        if (typeof toastr !== 'undefined' && toastr.success) {
            toastr.success(`Processed the open chat. ${rendered} message(s) rendered.`);
        }

        console.log(`[Bubble Splitter] Render All complete: ${rendered} message(s).`);
    }

    function queueMessageRender(index) {
        if (!Number.isInteger(index) || index < 0) return;

        pendingMessageIndexes.add(index);
        if (observerScheduled) return;

        observerScheduled = true;

        setTimeout(() => {
            observerScheduled = false;
            if (busy) return;

            const indexes = Array.from(pendingMessageIndexes);
            pendingMessageIndexes.clear();

            busy = true;
            try {
                for (const messageIndex of indexes) renderOne(messageIndex);
            } finally {
                busy = false;
            }
        }, 0);
    }

    function installChatObserver() {
        if (chatObserver || !document.body) return;

        chatObserver = new MutationObserver(records => {
            for (const record of records) {
                const target = record.target?.nodeType === Node.ELEMENT_NODE
                    ? record.target
                    : record.target?.parentElement;

                const messageElement = target?.closest?.('#chat .mes');

                if (messageElement) {
                    const rawIndex =
                        messageElement.getAttribute('mesid') ??
                        messageElement.getAttribute('data-mesid');

                    if (rawIndex !== null) queueMessageRender(Number(rawIndex));
                }

                for (const added of record.addedNodes || []) {
                    if (added.nodeType !== Node.ELEMENT_NODE) continue;

                    const candidates = [];

                    if (added.matches?.('#chat .mes')) candidates.push(added);

                    if (added.querySelectorAll) {
                        candidates.push(...added.querySelectorAll('#chat .mes'));
                    }

                    for (const candidate of candidates) {
                        const rawIndex =
                            candidate.getAttribute('mesid') ??
                            candidate.getAttribute('data-mesid');

                        if (rawIndex !== null) queueMessageRender(Number(rawIndex));
                    }
                }
            }
        });

        chatObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

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
                    <span>Enable bubble styling and splitting</span>
                </label>

                <label>Split messages longer than (words)
                    <input id="bs_min_words" class="text_pole" type="number" min="1" max="500">
                </label>

                <label>Maximum bubbles per message
                    <input id="bs_max_bubbles" class="text_pole" type="number" min="2" max="30">
                </label>

                <div class="marginTop10">
                    <button id="bs_render_all" class="menu_button" type="button">
                        Render All Messages
                    </button>
                    <small>Reapply visual bubbles and voice notes in the open chat.</small>
                </div>

                <hr>
                <h4>Assistant bubble palette</h4>
                <label>Background<input id="bs_assistant_bg" type="color"></label>
                <label>Border<input id="bs_assistant_border" type="color"></label>
                <label>Text<input id="bs_assistant_text" type="color"></label>

                <hr>
                <h4>User bubble palette</h4>
                <label>Background<input id="bs_user_bg" type="color"></label>
                <label>Border<input id="bs_user_border" type="color"></label>
                <label>Text<input id="bs_user_text" type="color"></label>

                <hr>
                <button id="bs_reset_palette" class="menu_button" type="button">
                    Reset default colors
                </button>
            </div>
        </div>`;

        $('#extensions_settings2').append(html);

        $('#bs_enabled').prop('checked', settings.enabled).on('change', function () {
            settings.enabled = this.checked;
            saveSettings();
            if (settings.enabled) renderAllMessages();
        });

        $('#bs_min_words').val(settings.minWords).on('change', function () {
            settings.minWords = Math.max(1, Math.min(
                500, Number(this.value) || DEFAULTS.minWords
            ));
            $(this).val(settings.minWords);
            saveSettings();
        });

        $('#bs_max_bubbles').val(settings.maxBubbles).on('change', function () {
            settings.maxBubbles = Math.max(2, Math.min(
                30, Number(this.value) || DEFAULTS.maxBubbles
            ));
            $(this).val(settings.maxBubbles);
            saveSettings();
        });

        const colorControls = {
            '#bs_assistant_bg': 'assistantBg',
            '#bs_assistant_border': 'assistantBorder',
            '#bs_assistant_text': 'assistantText',
            '#bs_user_bg': 'userBg',
            '#bs_user_border': 'userBorder',
            '#bs_user_text': 'userText'
        };

        for (const [selector, key] of Object.entries(colorControls)) {
            $(selector).val(validColor(settings[key], DEFAULTS[key]))
                .on('input change', function () {
                    settings[key] = validColor(this.value, DEFAULTS[key]);
                    updatePalette();
                    saveSettings();
                });
        }

        $('#bs_reset_palette').on('click', function () {
            for (const key of Object.keys(DEFAULTS)) {
                if (
                    key.endsWith('Bg') ||
                    key.endsWith('Border') ||
                    key.endsWith('Text')
                ) {
                    settings[key] = DEFAULTS[key];
                }
            }

            for (const [selector, key] of Object.entries(colorControls)) {
                $(selector).val(settings[key]);
            }

            updatePalette();
            saveSettings();
        });

        $('#bs_render_all').on('click', renderAllMessages);
    }

    jQuery(() => {
        const ctx = SillyTavern.getContext();
        const eventSource = ctx.eventSource;
        const eventTypes = ctx.eventTypes;

        addSettingsUI();
        updatePalette();

        if (eventSource && eventTypes?.CHARACTER_MESSAGE_RENDERED) {
            eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onRendered);
        }

        if (eventSource && eventTypes?.USER_MESSAGE_RENDERED) {
            eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onRendered);
        }

        installChatObserver();
        setTimeout(renderAllMessages, 0);

        console.log('[Bubble Splitter] Loaded with multi-position VN support.');
    });
})();
