/* ============================================================================
 * Surgeon Kernel alpha 0.1 — system/mouse.js
 * ----------------------------------------------------------------------------
 * PS/2-мышь машины. Своей стрелки модуль не рисует вовсе: на экране всегда
 * системный (браузерный) курсор — тот самый, что человек и ждёт от живой
 * VGA-консоли с мышью. Модуль решает ровно одно: где этому курсору можно быть.
 *
 * Указатель держит драйвер: пока в NVRAM нет пака с PS/2-мышью и её шиной
 * usb_bus (ключ 'surgeon_driver_pack', его пишет drivers/driver_manager.js),
 * машина мышь не ведёт — и указателя нет ни в меню загрузки, ни в консоли.
 * Отсюда две ступени одной руки:
 *   меню загрузки (#surgeon-grub) — драйвер плюс прошивка: пока в Setup стоит
 *     Legacy USB Support [Enabled], мышь отдаётся legacy-коду ещё до ядра
 *     (boot/bootloader/bootloader.css);
 *   консоль ядра (#surgeon-terminal) — тот же драйвер, но только когда ядро
 *     дошло до shell: пока идут логи и сводка, системы ещё нет.
 *
 * Право на указатель оба слоя подтверждают классом .sv-pointer: без драйвера он
 * снят, и курсор прячут базовые стили слоёв (core/kernel.css,
 * boot/bootloader/bootloader.css). Setup — единственный экран с мышью всегда:
 * она там своя, прошивочная, и драйвер ей не нужен (bios/click-bios/
 * click-bios.css). Ни POST (bios/post/post.css), ни экран загрузки системы, ни
 * панель рабочего стола, ни паника с shutdown указателя не получают.
 *
 * Режим драйвера виден только в строках драйвера:
 *   [OPTIMIZED / EXCELLENT]  PS/2 · IRQ 12 · 3-byte packets — опрос 200 Гц;
 *   [GENERIC / UNOPTIMIZED]  generic · 2-byte packets — опрос 30 Гц.
 * На вид указателя это не влияет: курсор системный, ведёт его сама машина.
 *
 * API: window.SurgeonMouse — installed / mode / state / report / layer / layers /
 *                            refresh / sync / detach / version
 * ========================================================================== */
(function (window, document) {
    'use strict';

    var PA_VERSION  = 'alpha 0.1';
    var NVRAM_KEY   = 'surgeon_driver_pack';      // тот же ключ, что у менеджера
    var USB_KEY     = 'surgeon_bios_usb';         // Legacy USB Support из Setup
    var PACK_EVENT  = 'driver_pack_changed';
    var STYLE_ID    = 'surgeon-mouse-style';
    var GRUB_ID     = 'surgeon-grub';             // меню загрузки: мышь прошивки
    var TERMINAL_ID = 'surgeon-terminal';         // консоль ядра: мышь драйвера

    /* Слои, которым указатель нужен, старший первым: меню загрузки перекрывает
     * консоль (z-index 9999), поэтому его и спрашивают первым. Кто из них что
     * получает, решает cursorAllowed(). */
    var LAYERS = [GRUB_ID, TERMINAL_ID];

    /* Класс живого слоя: он и есть выключатель курсора — базовые стили обоих
     * слоёв указатель гасят (core/kernel.css, boot/bootloader/bootloader.css),
     * поэтому решает класс, а не порядок таблиц стилей. Ставит его только sync(). */
    var CURSOR_CLASS = 'sv-pointer';

    /* Пакет и опрос — свойство драйвера, а не стрелки: их и печатает менеджер. */
    var MODE_OPTIMIZED = {
        key:    'optimized',
        mode:   'PS/2 · IRQ 12 · 3-byte packets',
        packet: 3,
        pollHz: 200,
        report: 'ps2: IRQ 12 armed — the pointer is live in the kernel console ' +
            '(200 Hz, 3-byte packets).'
    };

    var MODE_GENERIC = {
        key:    'generic',
        mode:   'generic · PS/2 IRQ 12, 2-byte packets',
        packet: 2,
        pollHz: 30,
        report: 'ps2: generic driver — 2-byte packets, 30 Hz poll: the console gets ' +
            'the same system cursor (an optimized driver polls at 200 Hz).'
    };

    var state = {
        host:      null,   // слой, которому отдан указатель
        mode:      null,   // MODE_OPTIMIZED | MODE_GENERIC | null
        installed: false,  // драйвер мыши есть в NVRAM
        generic:   false,
        legacyUsb: true    // Legacy USB Support из Setup
    };

    /* --- 1. NVRAM: право на указатель -------------------------------------- */
    function readJSON(key) {
        var raw = null;

        try { raw = window.localStorage.getItem(key); }
        catch (err) { return null; }

        if (!raw) { return null; }

        try { return JSON.parse(raw); }
        catch (err) { return null; }
    }

    function isList(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function has(list, value) {
        return isList(list) && list.indexOf(value) >= 0;
    }

    /* Драйвер мыши висит на шине: без usb_bus PS/2-порт мёртв, как и в devman. */
    function readDriver() {
        var pack  = readJSON(NVRAM_KEY);
        var usb   = readJSON(USB_KEY);
        var wired = !!pack && has(pack.installed, 'mouse') && has(pack.installed, 'usb_bus');

        state.legacyUsb = !(usb && usb.legacy_usb === false);
        state.installed = wired;
        state.generic   = wired && has(pack.auto, 'mouse');
        state.mode      = wired ? (state.generic ? MODE_GENERIC : MODE_OPTIMIZED) : null;
        return wired;
    }

    /* --- 2. Слои: где сейчас живёт машина ---------------------------------- */
    function layer(id) { return document.getElementById(id); }

    function visible(node) {
        if (!node || typeof window.getComputedStyle !== 'function') { return false; }
        return window.getComputedStyle(node).display !== 'none';
    }

    /* Фаза ядра: 'idle' | 'logs' | 'summary' | 'shell' | 'off' | 'recovery'.
     * Загрузка системы — это logs и summary, а экран восстановления — заглушка
     * без ввода: указатель встаёт только вместе с shell, где есть что делать. */
    function kernelPhase() {
        var core = window.SurgeonCore;

        if (!core || typeof core.phase !== 'function') { return ''; }

        try { return String(core.phase() || ''); }
        catch (err) { return ''; }
    }

    /* Кому сейчас можно указатель: сперва драйвер, потом экран. Пака PS/2 в
     * NVRAM нет — машина мышь не ведёт, и указателя не получает ни меню, ни
     * консоль: одному нужен ещё Legacy USB Support [Enabled] (прошивка отдаёт
     * мышь legacy-коду), другой ждёт готового shell. */
    function cursorAllowed(id) {
        if (state.installed !== true) { return false; }
        if (id === GRUB_ID) { return state.legacyUsb === true; }
        return kernelPhase() === 'shell';
    }

    /* Живой слой — верхний видимый. Если указателя на нём быть не должно, нижние
     * не смотрим: человек видит именно этот экран (POST, загрузка системы). */
    function activeLayer() {
        var i, node;

        for (i = 0; i < LAYERS.length; i++) {
            node = layer(LAYERS[i]);
            if (!node || !visible(node)) { continue; }
            return cursorAllowed(LAYERS[i]) ? node : null;
        }
        return null;
    }

    /* --- 3. Стили: системный курсор живёт на двух слоях -------------------- */
    /* Своих узлов модуль не создаёт: указатель — это сам браузерный курсор,
     * поэтому здесь одно правило «где ему стоять». Своё меню загрузки держит
     * курсор и без класса — правило просто не спорит с ним. */
    var STYLE_CSS =
        '#' + GRUB_ID + '.' + CURSOR_CLASS + ',\n' +
        '#' + TERMINAL_ID + '.' + CURSOR_CLASS + ' { cursor: default; }';

    function injectStyles() {
        var node = document.getElementById(STYLE_ID);

        if (node) { return node; }
        if (!document.head) { return null; }

        node = document.createElement('style');
        node.id = STYLE_ID;
        node.textContent = STYLE_CSS;
        document.head.appendChild(node);
        return node;
    }

    /* --- 4. Класс живого слоя: тут указатель появляется и пропадает -------- */
    function mark(node, on) {
        if (!node || !node.classList) { return false; }

        if (on) { node.classList.add(CURSOR_CLASS); }
        else    { node.classList.remove(CURSOR_CLASS); }
        return on;
    }

    /* Указателя нет нигде: класс снят со всех слоёв, которыми занят модуль. */
    function clearCursor() {
        var i;

        for (i = 0; i < LAYERS.length; i++) { mark(layer(LAYERS[i]), false); }
        state.host = null;
        return true;
    }

    /* Слои переключает сама машина (POST → GRUB → ядро), поэтому сверка идёт по
     * каждому событию: отдельного «машина ушла со слоя» ждать неоткуда. */
    function sync() {
        var host = activeLayer();

        if (!host) { clearCursor(); return false; }

        if (host !== state.host) {
            clearCursor();
            state.host = host;
        }

        mark(host, true);
        return true;
    }

    /* Паника и shutdown: ввод мёртв — мёртв и указатель. */
    function detach() {
        clearCursor();
        return true;
    }

    /* Кто именно держит указатель на живом слое: драйвер из NVRAM, а в меню
     * загрузки ещё и прошивка — она передаёт мышь legacy-коду. */
    function sourceText() {
        if (!state.mode) { return 'no driver in NVRAM'; }
        if (state.host && state.host.id === GRUB_ID) { return state.mode.mode + ' — boot menu'; }
        return state.mode.mode;
    }

    /* Перечитать NVRAM и состояние машины, отдать или снять указатель: точка
     * входа для ядра, бутлоадера и менеджера драйверов. */
    function refresh(reason) {
        readDriver();
        sync();

        console.log('[MOUSE] pointer ' + (reason || 'refresh') + ': ' + (state.host
            ? state.host.id + ' — ' + sourceText()
            : 'no layer with a pointer'));
        return !!state.host;
    }

    /* --- 5. События машины ------------------------------------------------- */
    /* Право на указатель меняется вместе с паком, живым слоем и фазой ядра,
     * поэтому событий несколько. Паника и shutdown снимают его сразу: экран после
     * них читает человек, а не мышь. */
    function wire() {
        document.addEventListener(PACK_EVENT, function () { refresh('pack'); });
        document.addEventListener('boot_complete', function () { refresh('boot'); });
        document.addEventListener('kernel_boot_start', function () { refresh('kernel'); });
        document.addEventListener('kernel_ready', function () { refresh('kernel'); });
        document.addEventListener('kernel_panic', function () { detach(); });
        document.addEventListener('kernel_halted', function () { detach(); });

        /* Перезагрузка машины: экран уходит в POST и в Setup — указателя там нет,
         * а класс на консоли остался бы висеть до следующей загрузки ядра. */
        document.addEventListener('surgeon_reboot', function () { detach(); });
        return true;
    }

    /* --- 6. Сервисный API -------------------------------------------------- */
    /* Снимок состояния: им пользуются менеджер драйверов (его строки), меню
     * GRUB и тесты. */
    function snapshot() {
        var mode = state.mode;

        return {
            installed: state.installed,
            generic:   state.generic,
            mode:      mode ? mode.key : 'none',
            driver:    mode ? mode.mode : '-',
            report:    mode ? mode.report : '',
            packets:   mode ? mode.packet : 0,
            pollHz:    mode ? mode.pollHz : 0,
            layer:     state.host ? state.host.id : null,
            visible:   !!state.host && !!state.host.classList &&
                state.host.classList.contains(CURSOR_CLASS),
            cursorClass: CURSOR_CLASS,
            legacyUsb: state.legacyUsb,
            kernelPhase: kernelPhase() || 'unknown'
        };
    }

    window.SurgeonMouse = {
        version:     PA_VERSION,
        nvramKey:    NVRAM_KEY,
        layers:      LAYERS.slice(0),
        cursorClass: CURSOR_CLASS,
        installed: function () { return state.installed; },
        mode:      function () { return state.mode ? state.mode.key : 'none'; },
        state:     snapshot,
        report:    function () { return state.mode ? state.mode.report : ''; },
        layer:     function () { return state.host ? state.host.id : null; },
        refresh:   refresh,
        sync:      sync,
        detach:    detach
    };

    /* --- 7. Старт ---------------------------------------------------------- */
    injectStyles();
    wire();
    refresh('load');

    console.log('[MOUSE] system/mouse.js ready: ' + (state.host
        ? sourceText() + ' -> cursor on ' + state.host.id
        : (state.installed
            ? 'PS/2 driver in NVRAM — the console gets the cursor with the shell'
            : 'no PS/2 driver in NVRAM — no pointer: neither the boot menu ' +
              'nor the console')));
}(window, document));
