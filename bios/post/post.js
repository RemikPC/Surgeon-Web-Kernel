/* ============================================================================
 * Surgeon Kernel PA 0.1 (Pre-Alpha)
 * bios/post/post.js
 * ----------------------------------------------------------------------------
 * Текстовый POST в духе AMIBIOS: шапка с блочным логотипом, лента инициализации,
 * счётчик памяти, затем сплэш с подсказкой про <Del> и <F11>.
 *
 * Наружу отдаёт три вещи:
 *   TPABKA_REGISTRY  — реестр железа: POST его читает, шаги инициализации пишут;
 *   SurgeonDiskReady — накопитель просканирован, бутлоадеру можно грузиться;
 *   TPABKA_PROCESSES — таблица процессов, чистится на входе в BIOS.
 *
 * Setup не открывается с одного нажатия: <Del> надо долбить DEL_PRESSES раз,
 * и только на фазе логотипа — пока идёт лента, клавиши молчат.
 *
 * Анимаций и курсора нет: строки выводятся мгновенно, указатель появится
 * только в Setup.
 *
 * API: SurgeonPost.init() / runPOST() / destroy()
 *
 * Куда уходит управление:
 *   <Del> x5        -> window.SurgeonClickBios.init()   (только на фазе лого)
 *   таймаут / <F11> -> событие 'bios_complete', на него подписан GRUB
 * ========================================================================== */
(function (window, document) {
    'use strict';

    /* --- 1. Тайминги, клавиши, лимиты -------------------------------------- */
    var CONTAINER_ID  = 'surgeon-post';
    var LOGO_WORD     = 'SURGEON';
    var LINE_DELAY    = 110;      // мс между строками POST
    var RAM_MAX_MB    = 4096;
    var RAM_STEP_MB   = 256;
    var RAM_TICK_MS   = 30;
    var LOG_LIMIT     = 18;       // строк в окне: лишние уползают вверх
    var SPLASH_DELAY  = 1500;     // пауза после последней строки POST
    var SETUP_TIMEOUT = 4000;     // сколько ждём <Del>, потом грузимся дальше
    var DEL_PRESSES   = 5;        // столько нажатий <Del> открывают Setup

    var KEY_DELETE = 46;
    var KEY_F11    = 122;

    /* --- 1a. Ключи хранилища: их читают бутлоадер и ядро ------------------- */
    var DISK_KEY     = 'surgeon_virtual_disk';
    var DISK_LABEL   = 'SURGEON_VDFS_SSD';
    var DISK_SIZE_MB = 524288;    // 512 GB — как на наклейке корпуса
    var PART_SIZE_MB = 262144;    // по 256 GB на раздел
    var FS_PROTECTED = 'pww13';   // защищённая ФС: /core/ и /drivers/
    var FS_USER      = 'vdfs';    // расширяемая ФС: /home/ и /Versions/Apps/

    /* Паспорт железа: цифры нарисованы, структура настоящая. */
    var CPU_MODEL     = 'GenuineSurgeon(R) Virtual Core Processor @ 3.60GHz';
    var CPU_SPEED_MHZ = 3600;
    var RAM_TOTAL_MB  = 4096;
    var BOARD_NAME    = 'Surgeon Z990 (VDFS Bridge)';
    var USB_DEVICES   = ['USB Keyboard (port 3)', 'USB Mouse (port 4)'];

    /* --- 2. Низкоуровневый слой: реестр, процессы, виртуальный диск -------- */

    /* Шаблон реестра: заливается до первой строки POST, дальше только дополняется. */
    function registryDefaults() {
        return {
            hardware: {
                cpu:     { status: 'OK', microcode: '0x1A', overclocked: false },
                video:   { driver: '[NOT_INITIALIZED]', mode: 'Standard Text Mode', resolution: null },
                mouse:   { driver: '[NOT_INITIALIZED]', irq: 12 },
                usb_bus: { driver: '[NOT_INITIALIZED]', devices: [] },
                acpi:    { driver: '[NOT_INITIALIZED]', power_state: 'S0' },
                storage: { driver: '[NOT_INITIALIZED]', device: DISK_LABEL, partitions: [], ready: false }
            },
            system_flags: {
                is_safe_mode: false,
                kernel_ring: 0
            }
        };
    }

    /* Реестр создаётся один раз: дальше любой модуль только читает ветки. */
    function ensureRegistry() {
        var base = registryDefaults();
        var reg, group, key;

        window.TPABKA_REGISTRY = window.TPABKA_REGISTRY || base;
        reg = window.TPABKA_REGISTRY;

        /* После factory-reset реестр бывает обрезан — достраиваем. */
        for (group in base) {
            if (!Object.prototype.hasOwnProperty.call(base, group)) { continue; }
            if (!reg[group] || typeof reg[group] !== 'object') { reg[group] = {}; }

            for (key in base[group]) {
                if (!Object.prototype.hasOwnProperty.call(base[group], key)) { continue; }
                if (typeof reg[group][key] === 'undefined') {
                    reg[group][key] = base[group][key];
                }
            }
        }
        return reg;
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function readJSON(key, fallback) {
        try {
            var raw = window.localStorage.getItem(key);
            if (!raw) { return fallback; }

            var parsed = JSON.parse(raw);
            return parsed === null ? fallback : parsed;
        } catch (error) {
            return fallback;      // приватный режим или мусор в хранилище
        }
    }

    function writeJSON(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            // не сохранилось — BIOS живёт в памяти
        }
    }

    /* --- 2a. Таблица процессов симулятора --------------------------------- */
    /* Всё из прошлого запуска обязано умереть, иначе чужие интервалы живут дальше. */
    function resetProcessTable() {
        var old    = window.TPABKA_PROCESSES;
        var killed = 0;
        var entry, i;

        if (isArray(old)) {
            for (i = 0; i < old.length; i++) {
                entry = old[i];
                if (!entry) { continue; }

                /* Драйверы кладут сюда свои kill()/cancel(). */
                if (typeof entry.kill === 'function') {
                    try { entry.kill(); killed++; } catch (error) { /* уже мёртв */ }
                } else if (typeof entry.cancel === 'function') {
                    try { entry.cancel(); killed++; } catch (error) { /* уже мёртв */ }
                }

                if (typeof entry.interval === 'number') { window.clearInterval(entry.interval); killed++; }
                if (typeof entry.timeout === 'number')  { window.clearTimeout(entry.timeout);  killed++; }
            }
        }

        window.TPABKA_PROCESSES = [];
        return killed;
    }

    /* --- 2b. Виртуальный диск (JSON-ФС) ----------------------------------- */
    /* Разметка: защищённый pww13 под ядро и расширяемый vdfs под пользователя. */
    function diskLayout() {
        return {
            label:       DISK_LABEL,
            interface:   'VDFS-BRIDGE',
            fs_revision: 'PA 0.1',
            sector_size: 512,
            size_mb:     DISK_SIZE_MB,
            created:     new Date().toISOString(),
            partitions: [
                {
                    id:           'pww13-core',
                    fs:           FS_PROTECTED,
                    label:        'SURGEON_CORE',
                    size_mb:      PART_SIZE_MB,
                    status:       'OK',
                    bootable:     true,
                    protected:    true,
                    mount_points: ['/core/', '/drivers/'],
                    directories:  ['/core/', '/drivers/']
                },
                {
                    id:           'vdfs-home',
                    fs:           FS_USER,
                    label:        'SURGEON_HOME',
                    size_mb:      PART_SIZE_MB,
                    status:       'OK',
                    bootable:     false,
                    protected:    false,
                    mount_points: ['/home/', '/Versions/Apps/'],
                    directories:  ['/home/', '/Versions/Apps/']
                }
            ],
            boot: { device: DISK_LABEL, partition: 'pww13-core' }
        };
    }

    /* Физический скан накопителя: находим готовую разметку или пишем новую. */
    function ensureVirtualDisk() {
        var disk    = readJSON(DISK_KEY, null);
        var created = false;
        var reg, parts, part, i;

        if (!disk || typeof disk !== 'object' || !isArray(disk.partitions) ||
            disk.partitions.length === 0) {
            disk = diskLayout();
            writeJSON(DISK_KEY, disk);
            created = true;
        }

        reg   = ensureRegistry();
        parts = [];

        for (i = 0; i < disk.partitions.length; i++) {
            part = disk.partitions[i];
            parts.push({
                id:           part.id,
                fs:           part.fs,
                mount_points: isArray(part.mount_points) ? part.mount_points.slice() : []
            });
        }

        reg.hardware.storage.driver     = '[VDFS_BRIDGE]';
        reg.hardware.storage.device     = disk.label;
        reg.hardware.storage.partitions = parts;
        reg.hardware.storage.ready      = true;

        window.SurgeonDiskInfo = disk;      // ядру и GRUB: живой объект разметки

        if (window.SurgeonDiskReady !== true) {
            window.SurgeonDiskReady = true;     // зелёный свет бутлоадеру
            console.log('[BIOS] Virtual disk ready: ' + disk.label + ' (' +
                (created ? 'new layout written' : 'existing layout mounted') + ')');
            document.dispatchEvent(new CustomEvent('surgeon_disk_ready'));
        }

        return { disk: disk, created: created };
    }

    /* Таблица монтирования одной строкой — для ленты POST и панели Setup. */
    function partitionTableText(disk) {
        var text = '';
        var i, part;

        for (i = 0; i < disk.partitions.length; i++) {
            part = disk.partitions[i];
            text += (i ? '  |  ' : '') + part.fs + ' [' + part.status + '] ' +
                part.mount_points.join(' ');
        }
        return text;
    }

    /* --- 3. Блочный шрифт 5x6 для логотипа --------------------------------- */
    var LOGO_FONT = {
        S: [' █████', '██    ', ' █████', '     ██', '██████'],
        U: ['██  ██', '██  ██', '██  ██', '██  ██', ' ████ '],
        R: ['█████ ', '██  ██', '█████ ', '██ ██ ', '██  ██'],
        G: [' █████', '██    ', '██ ███', '██  ██', ' ████ '],
        E: ['██████', '██    ', '█████ ', '██    ', '██████'],
        O: [' ████ ', '██  ██', '██  ██', '██  ██', ' ████ '],
        N: ['██  ██', '███ ██', '██████', '██ ███', '██  ██']
    };

    function buildLogoArt(word) {
        var rows = ['', '', '', '', ''];
        var i, r, glyph;

        for (i = 0; i < word.length; i++) {
            glyph = LOGO_FONT[word.charAt(i)];
            if (!glyph) { continue; }
            for (r = 0; r < rows.length; r++) {
                rows[r] += (i > 0 ? ' ' : '') + glyph[r];
            }
        }
        return rows.join('\n');
    }

    var LOGO_ART = buildLogoArt(LOGO_WORD);

    /* --- 4. Ленты экрана --------------------------------------------------- */
    var HEAD_LINES = [
        'AMIBIOS (C) 2026 American Megatrends, Inc.',
        'SURGEON BOARD ACPI BIOS Revision 0101',
        'SURGEON CLICK BIOS 5  ·  PA 0.1  ·  10/10/2026'
    ];

    /* --- 4a. Лента POST собирается на живых данных реестра ---------------- */
    /* Элемент ленты: текст, функция (считается в момент вывода), пустая строка,
     * счётчик памяти или отдельный шаг инициализации железа. */
    function buildPostScript() {
        var reg  = ensureRegistry();
        var hw   = reg.hardware;
        var disk = readJSON(DISK_KEY, null);
        var firstFs = (disk && isArray(disk.partitions) && disk.partitions.length)
            ? disk.partitions[0].fs : FS_PROTECTED;

        return [
            { text: 'CPU : ' + CPU_MODEL },
            { text: function () {
                return 'Status : ' + hw.cpu.status + '        Microcode : ' + hw.cpu.microcode +
                    '        Overclock : ' + (hw.cpu.overclocked ? 'ON' : 'OFF');
            } },
            { text: 'Speed : ' + CPU_SPEED_MHZ + 'MHz        Count : 1 Core / 2 Threads' },
            { text: function () {
                return 'Cache : 512KB L2 + 8MB L3        Kernel Ring : ' + reg.system_flags.kernel_ring;
            } },
            { text: 'Chipset : ' + BOARD_NAME + ' Rev. 21' },
            { text: 'BIOS Date : 10/10/2026        Rev. 0101 (UEFI 2.7)' },
            { text: 'Total Memory : ' + RAM_TOTAL_MB + 'MB DDR4-3200 @ 1600MHz' },
            { text: function () {
                return 'VGA : ' + hw.video.driver + '        Mode : ' + hw.video.mode;
            } },
            { text: function () {
                return 'Pointing : ' + hw.mouse.driver + '        IRQ : ' + hw.mouse.irq;
            } },
            { text: function () {
                return 'Process Table : 0 active (' + staleProcessesKilled +
                    ' stale process(es) killed, simulator RAM cleared)';
            } },
            { blank: true },
            { run: stepUsbControllers },
            { text: 'Auto-Detecting SATA Port 0 ... ' + DISK_LABEL + ' 512GB' },
            { text: 'Auto-Detecting SATA Port 1 ... SURGEON_OPTICAL_DVD-RW' },
            { text: 'Detecting ATA/ATAPI Devices .. 3 Devices Found' },
            { text: 'PCI Express x16 Link Training .. x16 (Gen3)' },
            { run: stepVideo },
            { memtest: true },
            { blank: true },
            { run: stepVirtualDisk },
            { run: stepAcpi },
            { text: function () {
                return 'Drivers : VGA ' + hw.video.driver + '  USB ' + hw.usb_bus.driver +
                    '  ACPI ' + hw.acpi.driver + '  STORAGE ' + hw.storage.driver;
            } },
            { text: 'Verifying DMI Pool Data ......' },
            { text: 'VDFS: boot device selected -> ' + DISK_LABEL + ' (' + firstFs + ')' },
            { text: 'BIOS POST complete. Handing over to boot loader.' }
        ];
    }

    function lineText(item) {
        return (typeof item.text === 'function') ? item.text() : item.text;
    }

    /* --- 5. Состояние ------------------------------------------------------ */
    var container  = null;    // корневая коробка #surgeon-post
    var logEl      = null;    // лента строк инициализации
    var keyHandler = null;
    var setupTimer = null;
    var runToken   = 0;       // номер прогона: прошлый POST сам себя останавливает
    var delPresses = 0;       // сколько раз уже долбили <Del>
    var delProgressEl = null; // строка с прогрессом на сплэше
    var splashVisible = false; // лого на экране: только тогда клавиши видны
    var staleProcessesKilled = 0;   // сколько процессов прибито на входе в BIOS

    /* --- 6. Мелкие хелперы ------------------------------------------------- */
    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (typeof text === 'string') { node.textContent = text; }
        return node;
    }

    function pad(value, size) {
        var text = String(value);
        while (text.length < size) { text = '0' + text; }
        return text;
    }

    function isStale(token) {
        return token !== runToken;
    }

    /* Лента не растёт: лишняя строка уезжает вверх. */
    function trimLog() {
        if (!logEl) { return; }
        while (logEl.childNodes.length > LOG_LIMIT) {
            logEl.removeChild(logEl.firstChild);
        }
    }

    function printLine(text) {
        if (!logEl) { return null; }

        var line = el('div', 'post-line', text);
        logEl.appendChild(line);
        trimLog();
        return line;
    }

    function printBlank() {
        if (!logEl) { return; }
        logEl.appendChild(el('div', 'post-blank'));
        trimLog();
    }

    /* --- 7. Сборка экрана POST --------------------------------------------- */
    function buildHead() {
        var head  = el('div', 'post-head');
        var texts = el('div', 'post-head-text');
        var brand = el('div', 'post-head-brand');
        var i;

        for (i = 0; i < HEAD_LINES.length; i++) {
            texts.appendChild(el('div',
                'post-head-line' + (i === 0 ? ' post-head-title' : ''), HEAD_LINES[i]));
        }

        brand.appendChild(el('pre', 'post-head-art', LOGO_ART));
        brand.appendChild(el('div', 'post-head-caption', 'CLICK BIOS 5  ·  PA 0.1'));

        head.appendChild(texts);
        head.appendChild(brand);
        return head;
    }

    function buildContainer() {
        var old = document.getElementById(CONTAINER_ID);
        if (old && old.parentNode) { old.parentNode.removeChild(old); }

        container = el('div', 'post-text');
        container.id = CONTAINER_ID;

        var screen = el('div', 'post-screen');
        screen.appendChild(buildHead());

        logEl = el('div', 'post-log');
        screen.appendChild(logEl);
        container.appendChild(screen);

        document.body.appendChild(container);
        return container;
    }

    /* --- 8. Счётчик памяти: 0 -> 4096 MB с шагом 256 ----------------------- */
    function checkNVRAM(token) {
        return new Promise(function (resolve) {
            var row     = el('div', 'post-line');
            var value   = el('span', 'post-value', pad(0, 4));
            var current = 0;
            var timer   = null;

            row.appendChild(el('span', 'post-ok', 'Memory Test : '));
            row.appendChild(value);
            row.appendChild(el('span', 'post-ok', ' MB'));

            if (logEl) {
                logEl.appendChild(row);
                trimLog();
            }

            timer = window.setInterval(function () {
                if (isStale(token) || !row.parentNode) {
                    window.clearInterval(timer);
                    resolve();
                    return;
                }

                current += RAM_STEP_MB;
                value.textContent = pad(current, 4);

                if (current >= RAM_MAX_MB) {
                    window.clearInterval(timer);
                    value.textContent = pad(RAM_MAX_MB, 4);
                    row.appendChild(el('span', 'post-ok', '  OK'));
                    resolve();
                }
            }, RAM_TICK_MS);
        });
    }

    /* --- 8a. Шаги инициализации: пишут в реестр и в ленту ------------------ */
    async function stepUsbControllers(token) {
        var hw = ensureRegistry().hardware;

        hw.usb_bus.driver  = '[XHCI_LEGACY]';
        hw.usb_bus.devices = USB_DEVICES.slice();

        printLine('Initializing USB Controllers .. ' + hw.usb_bus.driver + ' Done');
        await sleep(LINE_DELAY);
        if (isStale(token)) { return; }

        printLine('USB Device(s) : ' + hw.usb_bus.devices.length + ' -> ' + hw.usb_bus.devices.join(', '));
        await sleep(LINE_DELAY);
        if (isStale(token)) { return; }

        hw.mouse.driver = '[PS2_LEGACY_MOUSE]';
        printLine('Pointing Device : ' + hw.mouse.driver + ' on IRQ ' + hw.mouse.irq);
    }

    async function stepVideo(token) {
        var hw = ensureRegistry().hardware;

        hw.video.driver     = '[VESA_VBE_3.0]';
        hw.video.mode       = 'VBE 1024x768x32';
        hw.video.resolution = { width: 1024, height: 768, bpp: 32 };

        if (isStale(token)) { return; }
        printLine('VGA BIOS : ' + hw.video.driver + '  Mode ' + hw.video.mode);
    }

    /* Скан накопителя: разметка и таблица монтирования. */
    async function stepVirtualDisk(token) {
        var scan = ensureVirtualDisk();
        var disk = scan.disk;
        var i, part;

        printLine('Scanning virtual disk .. ' + disk.label + ' (' + disk.size_mb + ' MB, ' +
            disk.partitions.length + ' partitions)');
        await sleep(LINE_DELAY);
        if (isStale(token)) { return; }

        for (i = 0; i < disk.partitions.length; i++) {
            part = disk.partitions[i];
            printLine('  ' + part.fs + ' : ' + part.mount_points.join(' ') + ' .. ' + part.status +
                ' (' + part.size_mb + ' MB' + (part.protected ? ', protected' : ', writable') + ')');
            await sleep(LINE_DELAY);
            if (isStale(token)) { return; }
        }

        printLine('Disk layout : ' + (scan.created ? 'new partition table written' :
            'existing layout mounted'));
        await sleep(LINE_DELAY);
        if (isStale(token)) { return; }

        printLine('Mount Table : ' + partitionTableText(disk));
    }

    async function stepAcpi(token) {
        var hw = ensureRegistry().hardware;

        hw.acpi.driver = '[ACPI_2.0]';

        if (isStale(token)) { return; }
        printLine('ACPI : ' + hw.acpi.driver + '  RSDP @ 0x000F0000  Power State : ' + hw.acpi.power_state);
    }

    /* --- 9. Прогон POST --------------------------------------------------- */
    async function runPOST() {
        var token  = runToken;
        var script = buildPostScript();

        splashVisible = false;      // логотипа пока нет
        var item, i;

        for (i = 0; i < script.length; i++) {
            if (isStale(token)) { return; }

            item = script[i];

            if (item.run) {
                await item.run(token);
            } else if (item.memtest) {
                await checkNVRAM(token);
            } else if (item.blank) {
                printBlank();
            } else {
                printLine(lineText(item));
            }

            if (isStale(token)) { return; }
            await sleep(LINE_DELAY);
        }

        if (isStale(token)) { return; }
        await sleep(SPLASH_DELAY);

        if (isStale(token)) { return; }

        showSplash();
    }

    /* --- 10. Фаза 2: сплэш -------------------------------------------------- */
    function buildSplash() {
        var frame = el('div', 'post-splash-frame');

        frame.appendChild(el('pre', 'post-art', LOGO_ART));

        var logo = el('div', 'post-logo');
        logo.appendChild(el('span', 'post-logo-brand', 'SURGEON'));
        logo.appendChild(document.createTextNode(' '));
        logo.appendChild(el('span', 'post-logo-product', 'CLICK BIOS 5'));
        frame.appendChild(logo);

        frame.appendChild(el('div', 'post-splash-sub',
            'PA 0.1  ·  BIOS Rev. 0101  ·  10/10/2026  ·  ' +
            '(C) 2026 Surgeon Technologies, Inc.'));

        return frame;
    }

    function showSplash() {
        var hint, box;

        if (!container) { return; }

        container.innerHTML = '';
        container.classList.remove('post-text');
        container.classList.add('post-splash');
        container.appendChild(buildSplash());

        logEl         = null;    // ленты POST больше нет
        delPresses    = 0;       // на лого счёт идёт с нуля
        delProgressEl = null;

        hint = el('div', 'post-splash-hint');
        box  = el('div', 'post-hint-box');

        box.appendChild(el('div', 'post-hint',
            'Press <Del> x' + DEL_PRESSES + ' to run BIOS Setup, <F11> to run Boot Menu'));
        delProgressEl = el('div', 'post-hint-progress', '');
        box.appendChild(delProgressEl);

        hint.appendChild(box);
        container.appendChild(hint);

        /* Лого на экране: только теперь клавиши BIOS видны. */
        splashVisible = true;
        startSetupWindow();
    }

    /* Окно для <Del>: не успел — грузимся дальше. */
    function startSetupWindow() {
        setupTimer = window.setTimeout(function () {
            teardown();
            finishPOST();
        }, SETUP_TIMEOUT);
    }

    /* --- 11. Перехват <Del> и <F11> --------------------------------------- */
    /* <Del> надо долбить, как на живой плате, и только на фазе лого. Пока идёт
     * лента, клавиши молчат — но глушатся всегда, иначе браузер уйдёт в полный
     * экран по <F11>. */
    function armSetupInterrupt() {
        keyHandler = function (event) {
            var code  = event.keyCode || event.which;
            var key   = event.key || '';
            var isDel = (code === KEY_DELETE || key === 'Delete');
            var isF11 = (code === KEY_F11 || key === 'F11');

            if (!isDel && !isF11) { return; }

            event.preventDefault();            // <F11> в браузере — полный экран

            if (!splashVisible) { return; }    // логотипа ещё нет — рано

            if (isDel) {
                registerDelPress();
                return;
            }

            teardown();                        // сразу Boot Menu
            finishPOST();
        };

        window.addEventListener('keydown', keyHandler, true);
    }

    function registerDelPress() {
        delPresses++;
        console.log('[POST] Setup request: <Del> x' + delPresses + ' / ' + DEL_PRESSES);

        if (delPresses >= DEL_PRESSES) {
            teardown();
            launchSetup();
            return;
        }

        showDelProgress(DEL_PRESSES - delPresses);
    }

    /* Прогресс под подсказкой сплэша. */
    function showDelProgress(left) {
        if (!delProgressEl) { return; }

        delProgressEl.textContent = 'Setup Request : ' + delPresses + '/' + DEL_PRESSES +
            ' \u2014 press <Del> ' + left + ' more time(s)';
    }

    /* --- 12. Выход из BIOS: teardown, Setup, переход к бутлоадеру --------- */
    function teardown() {
        runToken++;      // незаконченный POST дальше не пойдёт

        if (keyHandler) {
            window.removeEventListener('keydown', keyHandler, true);
            keyHandler = null;
        }
        if (setupTimer) {
            window.clearTimeout(setupTimer);
            setupTimer = null;
        }
        if (container && container.parentNode) {
            container.parentNode.removeChild(container);
        }

        container     = null;
        logEl         = null;
        delProgressEl = null;
        delPresses    = 0;
        splashVisible = false;
    }

    function launchSetup() {
        if (window.SurgeonClickBios && typeof window.SurgeonClickBios.init === 'function') {
            window.SurgeonClickBios.init();
            return;
        }
        console.error('SurgeonPost: модуль Click BIOS не подключён, грузимся дальше.');
        finishPOST();
    }

    function finishPOST() {
        var scan = ensureVirtualDisk();      // финальная проверка накопителя
        var reg  = ensureRegistry();

        reg.system_flags.kernel_ring = 0;
        window.SurgeonDiskReady = true;      // зелёный свет бутлоадеру

        document.dispatchEvent(new CustomEvent('bios_complete', {
            detail: {
                disk:        scan.disk.label,
                partitions:  scan.disk.partitions.length,
                created:     scan.created,
                disk_ready:  window.SurgeonDiskReady,
                kernel_ring: reg.system_flags.kernel_ring
            }
        }));
    }

    /* --- 13. Точка входа -------------------------------------------------- */
    function init() {
        /* Чистим RAM симулятора: чужие интервалы жить не должны. */
        staleProcessesKilled = resetProcessTable();
        console.log('[BIOS] process table reset (' + staleProcessesKilled + ' killed)');

        /* Реестр железа нужен до первой строки POST. */
        ensureRegistry();

        /* Экран, перехват клавиш, сам прогон. */
        buildContainer();
        armSetupInterrupt();
        return runPOST();
    }

    /* Хуки для Click BIOS и будущего ядра. */
    window.TPABKA_ensureRegistry    = ensureRegistry;
    window.TPABKA_resetProcesses    = resetProcessTable;
    window.TPABKA_ensureVirtualDisk = ensureVirtualDisk;
    window.TPABKA_partitionTable    = partitionTableText;
    window.TPABKA_DISK_KEY          = DISK_KEY;

    window.SurgeonPost = {
        init:    init,
        runPOST: runPOST,
        destroy: teardown
    };
})(window, document);
