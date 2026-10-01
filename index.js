// Bubble Splitter - splits a finished AI reply into several chat bubbles.
// Splits after . .. ... ! ? … (punctuation stays in the same bubble).

(() => {
    const MODULE = 'bubble_splitter';
    const DEFAULTS = { enabled: true, minWords: 10, maxBubbles: 6, balanceMarkup: true };

    // Words that end in a dot but don't end a sentence.
    const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e']);

    let busy = false;

    function getSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        const s = extensionSettings[MODULE];
        for (const key of Object.keys(DEFAULTS)) {
            if (!(key in s)) s[key] = DEFAULTS[key];
        }
        return s;
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function countWords(text) {
        const t = text.trim();
        return t ? t.split(/\s+/).length : 0;
    }

    // Cut after a punctuation cluster (. .. ... ! ? ?! …) plus any closing quote/asterisk,
    // but only when followed by whitespace/end, so "3.5" and "wait...what" stay intact.
    function splitSentences(text) {
        const parts = [];
        const re = /[.!?…]+["'”’)\]*_~]*(?=\s|$)/g;
        let last = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            if (m[0] === '.') {
                const before = text.slice(last, m.index);
                const word = before.match(/([A-Za-z.]+)$/);
                if (word && ABBREVIATIONS.has(word[1].toLowerCase())) continue;
            }
            const end = m.index + m[0].length;
            parts.push(text.slice(last, end).trim());
            last = end;
        }
        const tail = text.slice(last).trim();
        if (tail) parts.push(tail);
        return parts.filter(Boolean);
    }

    function countMark(text, mark) {
        if (mark === '*') text = text.replace(/\*\*/g, '');
        return text.split(mark).length - 1;
    }

    // If a split lands inside *action* or "dialogue", close it in one bubble and reopen in the next.
    function balance(parts) {
        const MARKS = ['*', '"'];
        const open = { '*': false, '"': false };
        return parts.map((p) => {
            let prefix = '';
            let suffix = '';
            for (const m of MARKS) if (open[m]) prefix += m;
            for (const m of MARKS) if (countMark(p, m) % 2) open[m] = !open[m];
            for (const m of [...MARKS].reverse()) if (open[m]) suffix += m;
            return prefix + p + suffix;
        });
    }

    async function onRendered(id, type) {
        if (busy) return;
        const s = getSettings();
        if (!s.enabled || type === 'first_message') return;

        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        const idx = Number(id);
        if (!Number.isInteger(idx) || idx === 0 || idx !== chat.length - 1) return;

        const msg = chat[idx];
        if (!msg || msg.is_user || msg.is_system || msg.extra?.bubble_clone) return;

        const text = msg.mes ?? '';
        if (text.includes('```')) return; // leave code blocks alone
        if (countWords(text) <= s.minWords) return;

        let parts = splitSentences(text);
        if (parts.length < 2) return;

        const max = Math.max(2, Number(s.maxBubbles) || 6);
        if (parts.length > max) {
            const head = parts.slice(0, max - 1);
            head.push(parts.slice(max - 1).join(' '));
            parts = head;
        }
        if (s.balanceMarkup) parts = balance(parts);

        busy = true;
        try {
            // First bubble: reuse the original message (keeps the thinking block, swipes, etc.)
            msg.mes = parts[0];
            const sid = msg.swipe_id ?? 0;
            if (Array.isArray(msg.swipes) && msg.swipes[sid] !== undefined) msg.swipes[sid] = parts[0];
            ctx.updateMessageBlock(idx, msg);

            // Remaining bubbles: new messages from the same character
            for (const part of parts.slice(1)) {
                const extra = { ...(msg.extra || {}), bubble_clone: true };
                delete extra.reasoning;
                delete extra.reasoning_duration;
                delete extra.reasoning_type;
                delete extra.token_count;

                const clone = {
                    name: msg.name,
                    is_user: false,
                    is_system: false,
                    send_date: msg.send_date,
                    mes: part,
                    extra,
                };
                if (msg.force_avatar) clone.force_avatar = msg.force_avatar;
                if (msg.original_avatar) clone.original_avatar = msg.original_avatar;

                chat.push(clone);
                ctx.addOneMessage(clone);
            }
            await ctx.saveChat();
        } catch (err) {
            console.error('[Bubble Splitter] failed:', err);
        } finally {
            busy = false;
        }
    }

    function addSettingsUI() {
        const s = getSettings();
        const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Bubble Splitter</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input id="bs_enabled" type="checkbox"><span>Enabled</span></label>
                <label>Only split replies longer than (words)
                    <input id="bs_min_words" class="text_pole" type="number" min="1" max="500"></label>
                <label>Max bubbles per reply
                    <input id="bs_max_bubbles" class="text_pole" type="number" min="2" max="30"></label>
                <label class="checkbox_label"><input id="bs_balance" type="checkbox"><span>Keep *actions* and "quotes" intact across bubbles</span></label>
            </div>
        </div>`;
        $('#extensions_settings2').append(html);

        $('#bs_enabled').prop('checked', s.enabled).on('change', function () { s.enabled = this.checked; saveSettings(); });
        $('#bs_balance').prop('checked', s.balanceMarkup).on('change', function () { s.balanceMarkup = this.checked; saveSettings(); });
        $('#bs_min_words').val(s.minWords).on('input', function () { s.minWords = Number(this.value) || DEFAULTS.minWords; saveSettings(); });
        $('#bs_max_bubbles').val(s.maxBubbles).on('input', function () { s.maxBubbles = Number(this.value) || DEFAULTS.maxBubbles; saveSettings(); });
    }

    jQuery(() => {
        const { eventSource, eventTypes } = SillyTavern.getContext();
        addSettingsUI();
        eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onRendered);
        console.log('[Bubble Splitter] loaded');
    });
})();
