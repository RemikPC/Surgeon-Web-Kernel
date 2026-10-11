/* ============================================================================
 * Surgeon Kernel PA 0.3    Файл: core/os_recovery.js
 * ----------------------------------------------------------------------------
 * Аварийный режим ядра. Сюда уходит ветка coreMode = 'recovery' из бутлоадера:
 * штатное ядро не запускается, машина поднимает консоль восстановления.
 *
 * Пока это заглушка этапа 3: она честно рисует красный баннер, объясняет, где
 * мы и что делать, и оставляет приглашение. Команды восстановления (fsck,
 * mount, restore) придут вместе с установщиком — этап 16.
 *
 * API: SurgeonRecovery.init(config) / destroy() / active() / banner
 * ========================================================================== */
(function (window, document) {
    'use strict';

    var PA_VERSION   = 'PA 0.3';
    var VERSION_LINE = 'Surgeon OS Recovery Console v0.3';
    var BANNER       = '[ EMERGENCY CRITICAL MODE ] ' + VERSION_LINE;
    var TERMINAL_ID  = 'surgeon-terminal';
    var GRUB_ID      = 'surgeon-grub';
    var DESKTOP_ID   = 'surgeon-desktop';
    var MONITOR_ID   = 'surgeon-monitor';
    var PROMPT       = 'recovery@Surgeon_OS:~# ';

    var state = {
        active:    false,
        container: null,
        logEl:     null,
        config:    null
    };

    /* --- 1. Мелкие хелперы ------------------------------------------------ */
    function el(tag, className, text) {
        var node = document.createElement(tag);

        if (className) { node.className = className; }
        if (typeof text === 'string') { node.textContent = text; }
        return node;
    }

    function layer(id) {
        return document.getElementById(id);
    }

    function monitor() {
        return layer(MONITOR_ID) || document.body;
    }

    function hideLayer(id) {
        var node = layer(id);

        if (node) { node.style.display = 'none'; }
    }

    /* --- 2. Экран восстановления ------------------------------------------ */
    /* Консоль собирается здесь же: ядро к этому моменту уже погасило GRUB. */
    function buildConsole() {
        var node = layer(TERMINAL_ID);
        var screen, log;

        if (!node) {
            node = el('div');
            node.id = TERMINAL_ID;
            monitor().appendChild(node);
        }

        node.textContent = '';
        node.style.display = 'flex';

        screen = el('div', 'kernel-screen');
        log    = el('div', 'kernel-log');

        screen.appendChild(log);
        node.appendChild(screen);

        state.container = node;
        state.logEl     = log;
        return log;
    }

    function line(text, className) {
        var node = el('div', 'kernel-line' + (className ? ' ' + className : ''), text);

        if (state.logEl) { state.logEl.appendChild(node); }
        return node;
    }

    /* --- 3. init() / destroy() -------------------------------------------- */
    function init(config) {
        var cfg = config || window.SurgeonBootConfig || { coreMode: 'recovery' };

        /* Аварийный режим — единственный слой на экране. */
        hideLayer(GRUB_ID);
        hideLayer(DESKTOP_ID);

        state.active = true;
        state.config = cfg;
        buildConsole();

        /* Красный баннер: ровно та строка, которую ждёт POST и человек. */
        line(BANNER, 'is-err');
        line('[ INFO ] coreMode = recovery — the normal kernel was not started.', 'is-info');
        line('[ INFO ] Control handed over to /core/os_recovery.js.', 'is-info');
        line('[ OK ] pww13 file system mounted read-only.', 'is-ok');
        line('[ WARN ] Recovery tools: stage 16 (installer).', 'is-warn');
        line('', 'is-dim');
        line('Подсказка: штатное ядро не поднималось, машина ждёт сборку восстановителя.', 'is-dim');
        line(PROMPT + '(консоль восстановления ждёт своей сборки)', 'is-dim');

        console.warn('[RECOVERY] ' + BANNER);
        return state;
    }

    function destroy() {
        state.active = false;
        state.config = null;

        if (state.container) {
            state.container.textContent = '';
            state.container.style.display = 'none';
        }
        state.container = null;
        state.logEl     = null;
        return state.active;
    }

    /* --- 4. Экспорт ------------------------------------------------------- */
    window.SurgeonRecovery = {
        init:    init,
        destroy: destroy,
        active:  function () { return state.active; },
        prompt:  PROMPT,
        banner:  BANNER,
        version: PA_VERSION
    };
})(window, document);
