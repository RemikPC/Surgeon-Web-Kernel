/* ============================================================================
 * Surgeon Kernel PA 0.1 (Pre-Alpha)    Файл: boot/bootloader/bootloader.js
 * ----------------------------------------------------------------------------
 * Ретро-меню в стиле GRUB: синий DOS-экран, стрелки ↑/↓, Enter и автозапуск
 * через 5 секунд.
 *
 * Меню — чистый лист: верхний пункт один, Normal Core Mode, под ним Safe Mode.
 * Выключенные Safe и Recovery остались в KERNEL_LABELS, вернуть их можно одной
 * строкой в MENU_BLUEPRINT. Установленные дистрибутивы лежат в localStorage
 * ('surgeon_installed_distros') и дописываются подпунктами к Normal Core Mode.
 *
 * Ядру уходит событие 'boot_complete' с window.SurgeonBootConfig:
 *   { coreMode: 'normal' | 'safe' | 'recovery', activeDistro, distroSafeMode }
 *
 * API: SurgeonBoot.init() / destroy()
 * ========================================================================== */
(function (window, document) {
    'use strict';

    /* --- 1. Константы ----------------------------------------------------- */
    var CONTAINER_ID    = 'surgeon-grub';
    var EVENT_NAME      = 'boot_complete';
    var STORAGE_KEY     = 'surgeon_installed_distros';
    var KEY_ENTER       = 13;
    var KEY_UP          = 38;
    var KEY_DOWN        = 40;
    var TIMEOUT_SECONDS = 5;
    var FRAME_WIDTH     = 66;       // символов между вертикальными │

    var INDENT_ROOT     = '  ';     // отступ базовых пунктов
    var INDENT_NESTED   = '      '; // отступ подпунктов (перед └──)

    var GLYPH = {
        v:      '│',
        top:    '┌', topR: '┐',  h: '─',
        bot:    '└', botR: '┘',
        teeL:   '├', teeR: '┤',
        dV:     '║',
        dTop:   '╔', dTopR: '╗', dH: '═',
        dBot:   '╚', dBotR: '╝',
        branch: '└── '
    };

    /* --- 2. Режимы ядра и их подписи -------------------------------------- */
    var CORE_MODE = {
        NORMAL:   'normal',
        SAFE:     'safe',
        RECOVERY: 'recovery'
    };

    var KERNEL_LABELS = {};
    KERNEL_LABELS[CORE_MODE.NORMAL]   = 'Surgeon Kernel (Normal Core Mode)';
    KERNEL_LABELS[CORE_MODE.SAFE]     = 'Surgeon Kernel (Safe Core Mode)';
    KERNEL_LABELS[CORE_MODE.RECOVERY] = 'Surgeon Kernel (Recovery Core Mode)';

    var SAFE_SUB_LABEL = 'Safe Mode';   // подпункт Normal Core Mode

    /* --- 3. Черновик меню -------------------------------------------------
     * kernel — базовый пункт ядра, safe — подпункт под Normal, distros — сюда
     * подставляются установленные дистрибутивы. Recovery ждёт своего этапа.
     * --------------------------------------------------------------------- */
    var MENU_BLUEPRINT = [
        { type: 'kernel',  coreMode: CORE_MODE.NORMAL },
        { type: 'safe',    coreMode: CORE_MODE.NORMAL },
        { type: 'distros', coreMode: CORE_MODE.NORMAL }
    ];

    /* --- 4. Состояние модуля ---------------------------------------------- */
    var state = {
        initialized: false,
        booting:     false,           // чтобы таймер и Enter не выстрелили дважды
        container:   null,
        frameEl:     null,
        timerEl:     null,
        timerId:     null,
        remaining:   TIMEOUT_SECONDS,
        activeIndex: 0,
        itemEls:     [],              // строки меню (DOM)
        entries:     [],              // конфиги пунктов, параллельно itemEls
        keyHandler:  null
    };

    /* --- 5. Мелкие хелперы ------------------------------------------------ */
    function repeat(ch, count) {
        var out = '';
        for (var i = 0; i < count; i++) { out += ch; }
        return out;
    }

    /* Центрирует текст в строке шириной width. */
    function padCenter(text, width) {
        if (text.length >= width) { return text.slice(0, width); }
        var gap  = width - text.length;
        var left = Math.floor(gap / 2);
        return repeat(' ', left) + text + repeat(' ', gap - left);
    }

    /* Быстрое создание элемента. */
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (typeof text === 'string') { node.textContent = text; }
        return node;
    }

    /* Горизонтальная линия рамки. */
    function frameLine(left, fill, right) {
        var node = el('div', 'grub-frame-line');
        node.textContent = left + repeat(fill, FRAME_WIDTH) + right;
        return node;
    }

    /* Строка рамки: │ тело │ */
    function frameRow(rowClass, bodyNodes) {
        var row = el('div', 'grub-row ' + rowClass);
        row.appendChild(el('span', 'grub-edge', GLYPH.v));

        var body = el('span', 'grub-body');
        for (var i = 0; i < bodyNodes.length; i++) { body.appendChild(bodyNodes[i]); }
        row.appendChild(body);

        row.appendChild(el('span', 'grub-edge', GLYPH.v));
        return row;
    }

    /* Старые движки без indexOf/isArray/trim — отсюда свои версии. */
    function indexOfNode(list, node) {
        for (var i = 0; i < list.length; i++) {
            if (list[i] === node) { return i; }
        }
        return -1;
    }

    function indexOfString(list, value) {
        for (var i = 0; i < list.length; i++) {
            if (list[i] === value) { return i; }
        }
        return -1;
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function trimText(value) {
        return String(value).replace(/^\s+|\s+$/g, '');
    }

    /* --- 6. NVRAM: установленные дистрибутивы (битые данные — просто []) --- */
    function readInstalledDistros() {
        var raw = null;

        try {
            if (!window.localStorage) { return []; }
            raw = window.localStorage.getItem(STORAGE_KEY);
        } catch (accessError) {
            return [];      // приватный режим или хранилище выключено
        }

        if (!raw) { return []; }

        var parsed = null;
        try {
            parsed = JSON.parse(raw);
        } catch (parseError) {
            return [];
        }

        if (!isArray(parsed)) { return []; }

        var names = [];
        for (var i = 0; i < parsed.length; i++) {
            var name = normalizeDistroName(parsed[i]);
            if (name !== '' && indexOfString(names, name) === -1) {
                names.push(name);
            }
        }
        return names;
    }

    /* Имя сборки может прийти строкой или объектом. */
    function normalizeDistroName(record) {
        var name = '';

        if (typeof record === 'string') {
            name = record;
        } else if (record && typeof record === 'object') {
            if (typeof record.name === 'string')       { name = record.name;  }
            else if (typeof record.title === 'string') { name = record.title; }
            else if (typeof record.id === 'string')    { name = record.id;    }
        }

        return trimText(name);
    }

    /* --- 7. Сборка списка пунктов меню ------------------------------------ */
    function buildMenuModel() {
        var model   = [];
        var distros = readInstalledDistros();

        for (var b = 0; b < MENU_BLUEPRINT.length; b++) {
            var slot = MENU_BLUEPRINT[b];

            if (slot.type === 'kernel') {
                model.push({
                    label:          KERNEL_LABELS[slot.coreMode],
                    coreMode:       slot.coreMode,
                    activeDistro:   null,
                    distroSafeMode: false,
                    nested:         false
                });
                continue;
            }

            /* Safe Mode живёт подпунктом под Normal Core Mode. */
            if (slot.type === 'safe') {
                model.push({
                    label:          SAFE_SUB_LABEL,
                    coreMode:       CORE_MODE.SAFE,
                    activeDistro:   null,
                    distroSafeMode: false,
                    nested:         true
                });
                continue;
            }

            /* Дистрибутивы: обычный запуск и запуск в safe mode. */
            if (slot.type === 'distros') {
                for (var d = 0; d < distros.length; d++) {
                    model.push(distroEntry(slot.coreMode, distros[d], false));
                    model.push(distroEntry(slot.coreMode, distros[d], true));
                }
            }
        }

        return model;
    }

    function distroEntry(coreMode, distroName, safe) {
        return {
            label:          safe ? (distroName + '  (Safe Mode)') : distroName,
            coreMode:       coreMode,
            activeDistro:   distroName,
            distroSafeMode: safe,
            nested:         true
        };
    }

    /* --- 8. Баннер над рамкой --------------------------------------------- */
    function buildBanner() {
        var banner = el('div', 'grub-banner');

        banner.appendChild(el('div', 'grub-banner-line',
            GLYPH.dTop + repeat(GLYPH.dH, FRAME_WIDTH) + GLYPH.dTopR));

        banner.appendChild(el('div', 'grub-banner-line',
            GLYPH.dV + padCenter('SURGEON KERNEL PA 0.1  ·  GRUB BOOT MANAGER', FRAME_WIDTH) + GLYPH.dV));

        banner.appendChild(el('div', 'grub-banner-line',
            GLYPH.dBot + repeat(GLYPH.dH, FRAME_WIDTH) + GLYPH.dBotR));

        return banner;
    }

    /* --- 9. Рамка меню: базовые пункты слева, подпункты с веткой └── ------ */
    /* Здесь же наполняются state.itemEls и state.entries. */
    function buildEntryRow(entry) {
        var bodyNodes;

        if (entry.nested) {
            bodyNodes = [
                el('span', 'grub-branch', INDENT_NESTED + GLYPH.branch),
                el('span', 'grub-label', entry.label)
            ];
        } else {
            bodyNodes = [
                el('span', 'grub-label', INDENT_ROOT + entry.label)
            ];
        }

        var row = frameRow('grub-row--item', bodyNodes);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-label', entry.label);

        /* Мышь — приятный бонус, клавиатура всё равно основная. */
        row.addEventListener('mouseenter', function () {
            var hovered = indexOfNode(state.itemEls, this);
            if (hovered !== -1) { setActive(hovered); }
        });
        row.addEventListener('click', function () {
            var clicked = indexOfNode(state.itemEls, this);
            if (clicked !== -1) { finalize(clicked); }
        });

        return row;
    }

    function buildFrame() {
        var frame = el('div', 'grub-frame');

        frame.appendChild(frameLine(GLYPH.top, GLYPH.h, GLYPH.topR));

        frame.appendChild(frameRow('grub-row--title', [
            el('span', 'grub-title', '  Surgeon Kernel Boot Manager  ::  PA 0.1')
        ]));

        frame.appendChild(frameLine(GLYPH.teeL, GLYPH.h, GLYPH.teeR));

        /* Каждый init() собирает меню заново. */
        var model = buildMenuModel();

        state.itemEls = [];
        state.entries = [];

        for (var i = 0; i < model.length; i++) {
            var entry = model[i];
            var row   = buildEntryRow(entry);

            state.itemEls.push(row);
            state.entries.push({
                coreMode:       entry.coreMode,
                activeDistro:   entry.activeDistro,
                distroSafeMode: entry.distroSafeMode
            });

            frame.appendChild(row);
        }

        frame.appendChild(frameLine(GLYPH.bot, GLYPH.h, GLYPH.botR));

        state.frameEl = frame;
        return frame;
    }

    function buildScreen() {
        var screen = el('div', 'grub-screen');
        screen.appendChild(buildBanner());
        screen.appendChild(buildFrame());
        return screen;
    }

    function buildFooter() {
        var footer = el('div', 'grub-footer');
        footer.appendChild(el('div', 'grub-hint',
            'Используйте ↑ и ↓ для выбора, Enter для подтверждения.'));
        state.timerEl = el('div', 'grub-timer', '');
        footer.appendChild(state.timerEl);
        return footer;
    }

    /* --- 10. Активный пункт (навигация по кругу) --------------------------- */
    function setActive(index) {
        var total = state.itemEls.length;
        if (!total) { return; }

        var normalized = ((index % total) + total) % total;

        for (var i = 0; i < total; i++) {
            if (i === normalized) {
                state.itemEls[i].classList.add('is-active');
            } else {
                state.itemEls[i].classList.remove('is-active');
            }
        }
        state.activeIndex = normalized;
    }

    function move(delta) {
        setActive(state.activeIndex + delta);
    }

    /* --- 11. Обратный отсчёт ---------------------------------------------- */
    function paintTimer() {
        if (state.timerEl) {
            state.timerEl.textContent =
                'Автоматический запуск через: ' + state.remaining + ' сек.';
        }
    }

    function startTimer() {
        state.remaining = TIMEOUT_SECONDS;
        paintTimer();

        /* 5 → 4 → 3 → 2 → 1 → автозапуск. */
        state.timerId = window.setInterval(function () {
            state.remaining -= 1;

            if (state.remaining <= 0) {
                stopTimer(false);
                finalize(0);     // первый пункт — Normal Core Mode
                return;
            }
            paintTimer();
        }, 1000);
    }

    /* eraseLine — заодно стереть строку таймера из подвала. */
    function stopTimer(eraseLine) {
        if (state.timerId !== null) {
            window.clearInterval(state.timerId);
            state.timerId = null;
        }
        if (eraseLine && state.timerEl && state.timerEl.parentNode) {
            state.timerEl.parentNode.removeChild(state.timerEl);
            state.timerEl = null;
        }
    }

    /* --- 12. Клавиатура ---------------------------------------------------- */
    function handleKeydown(event) {
        var code = event.keyCode || event.which;

        /* Любая стрелка снимает автозапуск. */
        if (code === KEY_UP || code === KEY_DOWN) {
            event.preventDefault();

            if (state.timerId !== null) { stopTimer(true); }

            move(code === KEY_UP ? -1 : 1);
            return;
        }

        if (code === KEY_ENTER) {
            event.preventDefault();
            finalize(state.activeIndex);
        }
    }

    /* --- 13. Финализация: отдаём выбор ядру (чистое ядро или дистрибутив) -- */
    function finalize(index) {
        if (state.booting || !state.initialized) { return; }

        var entry = state.entries[index];
        if (!entry) { return; }

        state.booting = true;

        window.SurgeonBootConfig = {
            coreMode:       entry.coreMode,
            activeDistro:   entry.activeDistro,
            distroSafeMode: entry.distroSafeMode
        };
        var exported = window.SurgeonBootConfig;

        destroy();

        document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: exported }));
    }

    /* --- 14. init() / destroy() ------------------------------------------- */
    function init() {
        if (state.initialized) { destroy(); }

        /* Контейнер ищем в разметке или создаём сами. */
        var container = document.getElementById(CONTAINER_ID);
        if (!container) {
            container = document.createElement('div');
            container.id = CONTAINER_ID;
            (document.body || document.documentElement).appendChild(container);
        }
        container.innerHTML = '';
        state.container = container;

        container.appendChild(buildScreen());
        container.appendChild(buildFooter());

        state.keyHandler = handleKeydown;
        window.addEventListener('keydown', state.keyHandler, false);

        state.initialized = true;
        state.booting     = false;

        /* Первым подсвечен Normal Core Mode — он же уходит в автозапуск. */
        setActive(0);

        startTimer();
    }

    function destroy() {
        if (state.timerId !== null) {
            window.clearInterval(state.timerId);
            state.timerId = null;
        }

        if (state.keyHandler) {
            window.removeEventListener('keydown', state.keyHandler, false);
            state.keyHandler = null;
        }

        if (state.container && state.container.parentNode) {
            state.container.parentNode.removeChild(state.container);
        }
        state.container = null;

        state.frameEl     = null;
        state.timerEl     = null;
        state.itemEls     = [];
        state.entries     = [];
        state.activeIndex = 0;
        state.remaining   = TIMEOUT_SECONDS;
        state.initialized = false;
        state.booting     = false;
    }

    /* --- 15. Наружу торчит только один объект ------------------------------ */
    window.SurgeonBoot = {
        init:    init,
        destroy: destroy
    };
})(window, document);
